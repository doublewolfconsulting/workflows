#!/usr/bin/env node
/**
 * PSI Monitor with Playwright site audit and Claude diagnosis
 *
 * Runs on a schedule via GitHub Actions (caller sets the cron).
 *
 * 1. Fetches PageSpeed Insights (mobile + desktop)
 * 2. Runs a Playwright headless audit of the live site:
 *    - Console errors and JS exceptions
 *    - Failed network requests (4xx / 5xx)
 *    - Broken internal links
 * 3. If anything fails: calls Claude with full Lighthouse detail + audit
 *    results + key source files, then opens/updates a GitHub issue
 * 4. If everything passes: silent. Closes any open issue if recovered.
 *
 * Required env vars:
 *   GITHUB_TOKEN        -- provided automatically by GitHub Actions
 *   GITHUB_REPOSITORY   -- provided automatically by GitHub Actions
 *   ANTHROPIC_API_KEY   -- repository secret
 *   GOOGLE_PSI_API_KEY  -- repository secret (avoids PSI rate limits on cloud IPs)
 *   SITE_URL            -- e.g. https://doublewolf.consulting
 *   MOBILE_THRESHOLD    -- minimum mobile PSI score (default 90)
 *   DESKTOP_THRESHOLD   -- minimum desktop PSI score (default 90)
 *   CONTEXT_FILES       -- space-separated repo-relative paths to include in Claude context
 *   SCHEMA_CONFIG       -- optional JSON mapping URLs to expected schema type arrays
 *                          e.g. {"https://example.com/":["Organization","WebSite","WebPage"]}
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
// This script lives at _wf/scripts/psi-monitor.mjs in the runner workspace.
// Two levels up is the workspace root, i.e. the caller's checked-out repo.
const ROOT = join(__dirname, '../..');

const SITE_URL = process.env.SITE_URL || '';
const THRESHOLDS = {
  mobile:  parseInt(process.env.MOBILE_THRESHOLD  || '90', 10),
  desktop: parseInt(process.env.DESKTOP_THRESHOLD || '90', 10),
};
const CONTEXT_FILES = (process.env.CONTEXT_FILES || 'CLAUDE.md').split(' ').filter(Boolean);
const SCHEMA_CONFIG = process.env.SCHEMA_CONFIG ? (() => {
  try { return JSON.parse(process.env.SCHEMA_CONFIG); }
  catch (e) { console.error('Invalid SCHEMA_CONFIG JSON: ' + e.message); return null; }
})() : null;
const LABEL = 'site-health';
const today = new Date().toISOString().split('T')[0];

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GOOGLE_PSI_API_KEY = process.env.GOOGLE_PSI_API_KEY;
const [OWNER, REPO] = (process.env.GITHUB_REPOSITORY || '').split('/');

const sleep = function(ms) { return new Promise(function(r) { setTimeout(r, ms); }); };

// --- GitHub API helper ------------------------------------------------------

async function gh(method, path, body) {
  const res = await fetch('https://api.github.com' + path, {
    method,
    headers: {
      'Authorization': 'Bearer ' + GITHUB_TOKEN,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('GitHub API ' + res.status + ': ' + await res.text());
  return res.json();
}

// --- PageSpeed Insights -----------------------------------------------------

async function fetchPSI(strategy, attempt) {
  if (!attempt) attempt = 1;
  const url = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed' +
    '?url=' + encodeURIComponent(SITE_URL) + '&strategy=' + strategy +
    (GOOGLE_PSI_API_KEY ? '&key=' + GOOGLE_PSI_API_KEY : '');
  const res = await fetch(url);
  // Retry on 429 (rate limit) and 400/5xx (transient API failures).
  // Google's PSI API returns 400 when it cannot queue the analysis for a strategy,
  // which happens transiently under load — not just for bad requests.
  if ((res.status === 429 || res.status === 400 || res.status >= 500) && attempt < 4) {
    const wait = attempt * 15000;
    console.log('PSI API ' + res.status + ' for ' + strategy + ', retrying in ' + (wait / 1000) + 's...');
    await sleep(wait);
    return fetchPSI(strategy, attempt + 1);
  }
  if (!res.ok) throw new Error('PSI API ' + res.status + ' for ' + strategy);
  return res.json();
}

function extractMetrics(data) {
  const audits = data.lighthouseResult.audits;
  const cats = data.lighthouseResult.categories;
  return {
    score: Math.round(cats.performance.score * 100),
    lcp: audits['largest-contentful-paint'].displayValue,
    cls: audits['cumulative-layout-shift'].displayValue,
    inp: (audits['interaction-to-next-paint'] || {}).displayValue || 'N/A',
    fcp: audits['first-contentful-paint'].displayValue,
    si:  audits['speed-index'].displayValue,
    tbt: audits['total-blocking-time'].displayValue,
  };
}

function extractLighthouseDetail(data) {
  const audits = data.lighthouseResult.audits;
  const lines = [];

  // Opportunities with estimated savings
  const opportunityIds = [
    'render-blocking-resources',
    'unused-css-rules',
    'unused-javascript',
    'uses-optimized-images',
    'uses-webp-images',
    'uses-text-compression',
    'uses-responsive-images',
    'preload-lcp-image',
    'total-byte-weight',
  ];
  const oppLines = [];
  for (const id of opportunityIds) {
    const a = audits[id];
    if (a && a.score !== null && a.score < 0.9 && a.displayValue) {
      oppLines.push('  ' + (a.title || id) + ': ' + a.displayValue);
      if (a.details && a.details.items) {
        a.details.items.slice(0, 3).forEach(function(item) {
          const label = item.url || item.label || '';
          if (label) oppLines.push('    - ' + String(label).slice(0, 100));
        });
      }
    }
  }
  if (oppLines.length > 0) {
    lines.push('Opportunities:');
    oppLines.forEach(function(l) { lines.push(l); });
  }

  // Diagnostics
  const diagnosticIds = [
    'dom-size',
    'server-response-time',
    'redirects',
    'mainthread-work-breakdown',
    'bootup-time',
    'third-party-summary',
    'uses-long-cache-ttl',
    'critical-request-chains',
  ];
  const diagLines = [];
  for (const id of diagnosticIds) {
    const a = audits[id];
    if (a && a.score !== null && a.score < 0.9 && a.displayValue) {
      diagLines.push('  ' + (a.title || id) + ': ' + a.displayValue);
    }
  }
  if (diagLines.length > 0) {
    lines.push('Diagnostics:');
    diagLines.forEach(function(l) { lines.push(l); });
  }

  // LCP element
  const lcpEl = audits['largest-contentful-paint-element'];
  if (lcpEl && lcpEl.details && lcpEl.details.items && lcpEl.details.items.length > 0) {
    lines.push('LCP element:');
    lcpEl.details.items.forEach(function(item) {
      if (item.node && item.node.snippet) {
        lines.push('  ' + item.node.snippet.slice(0, 150));
      }
    });
  }

  // CLS shift sources
  const clsEl = audits['layout-shift-elements'];
  if (clsEl && clsEl.details && clsEl.details.items && clsEl.details.items.length > 0) {
    lines.push('CLS shift elements:');
    clsEl.details.items.forEach(function(item) {
      if (item.node && item.node.snippet) {
        lines.push('  ' + item.node.snippet.slice(0, 150));
      }
    });
  }

  return lines.join('\n');
}

// --- Playwright helpers -----------------------------------------------------

// Creates a browser context that passes basic bot-detection checks.
// Cloudflare Bot Fight Mode blocks headless Chromium when navigator.webdriver
// is true (the default). Using a real user-agent and removing the webdriver
// property makes the request indistinguishable from a normal browser visit.
async function newStealthPage(browser) {
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  });
  await context.addInitScript(function() {
    Object.defineProperty(navigator, 'webdriver', { get: function() { return undefined; } });
  });
  return context.newPage();
}

// --- Playwright site audit --------------------------------------------------

async function runSiteAudit() {
  console.log('Running Playwright site audit...');
  const browser = await chromium.launch({ args: ['--disable-blink-features=AutomationControlled'] });
  const page = await newStealthPage(browser);

  const consoleErrors = [];
  const failedRequests = [];

  page.on('console', function(msg) {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', function(err) {
    consoleErrors.push('JS exception: ' + err.message);
  });
  page.on('response', function(res) {
    if (res.status() >= 400) failedRequests.push(res.status() + ' ' + res.url());
  });

  try {
    await page.goto(SITE_URL, { waitUntil: 'load', timeout: 30000 });
  } catch (err) {
    await browser.close();
    console.error('Playwright navigation failed: ' + err.message);
    return null;
  }

  // Collect unique internal links
  const links = await page.evaluate(function(base) {
    return Array.from(document.querySelectorAll('a[href]'))
      .map(function(a) { return a.href; })
      .filter(function(href) { return href.startsWith(base); })
      .filter(function(href, i, arr) { return arr.indexOf(href) === i; });
  }, SITE_URL);

  // Check up to 20 internal links for 4xx/5xx
  // Use browser-like Accept headers so Cloudflare Bot Fight Mode doesn't block the requests.
  const brokenLinks = [];
  for (const link of links.slice(0, 20)) {
    try {
      const res = await page.request.get(link, {
        timeout: 10000,
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Accept-Encoding': 'gzip, deflate, br',
        },
      });
      if (res.status() >= 400) brokenLinks.push(res.status() + ' ' + link);
    } catch {}
  }

  await browser.close();

  console.log(
    'Site audit: ' + consoleErrors.length + ' console error(s), ' +
    failedRequests.length + ' failed request(s), ' +
    brokenLinks.length + ' broken link(s)'
  );
  return { consoleErrors, failedRequests, brokenLinks };
}

// --- Schema validation (plain HTTP fetch, no browser) -----------------------
// JSON-LD schemas are static HTML injected at build time — no JS execution
// needed. Using fetch() avoids Cloudflare bot detection entirely.

function collectSchemaTypes(obj, types) {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) { obj.forEach(function(item) { collectSchemaTypes(item, types); }); return; }
  const t = obj['@type'];
  if (Array.isArray(t)) t.forEach(function(x) { types.add(x); });
  else if (t) types.add(t);
  Object.values(obj).forEach(function(val) { if (val && typeof val === 'object') collectSchemaTypes(val, types); });
}

async function validateSchema() {
  if (!SCHEMA_CONFIG || Object.keys(SCHEMA_CONFIG).length === 0) return null;

  console.log('Running schema validation...');
  const failures = [];

  for (const [url, expectedTypes] of Object.entries(SCHEMA_CONFIG)) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      if (!res.ok) {
        failures.push({ url: url, error: 'HTTP ' + res.status });
        console.log('  Schema ERROR ' + url + ': HTTP ' + res.status);
        continue;
      }
      const html = await res.text();
      const foundTypes = new Set();
      const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
      let m;
      while ((m = re.exec(html)) !== null) {
        try { collectSchemaTypes(JSON.parse(m[1]), foundTypes); } catch {}
      }
      const foundArray = Array.from(foundTypes);
      const missing = expectedTypes.filter(function(t) { return !foundArray.includes(t); });
      if (missing.length > 0) {
        failures.push({ url: url, missing: missing, found: foundArray });
        console.log('  Schema FAIL ' + url + ': missing ' + missing.join(', '));
      } else {
        console.log('  Schema PASS ' + url);
      }
    } catch (err) {
      failures.push({ url: url, error: err.message });
      console.log('  Schema ERROR ' + url + ': ' + err.message);
    }
  }

  console.log('Schema validation: ' + failures.length + ' failure(s)');
  return failures.length > 0 ? failures : null;
}

// --- Claude diagnosis -------------------------------------------------------

async function diagnose(mobileData, desktopData, mobile, desktop, siteAudit, schemaFailures) {
  const mobileLH  = extractLighthouseDetail(mobileData);
  const desktopLH = extractLighthouseDetail(desktopData);

  // Read context files from the caller's repo
  const contextSections = [];
  for (const relPath of CONTEXT_FILES) {
    try {
      const content = readFileSync(join(ROOT, relPath), 'utf8');
      contextSections.push({ path: relPath, content });
    } catch {}
  }

  const prompt = [
    'You are a senior web performance engineer auditing ' + SITE_URL + '.',
    'The weekly site health monitor detected issues. Diagnose the root cause.',
    '',
    'PSI SCORES',
    'Mobile:  ' + mobile.score + '/100 (threshold ' + THRESHOLDS.mobile + ')  LCP ' + mobile.lcp + '  CLS ' + mobile.cls + '  INP ' + mobile.inp + '  FCP ' + mobile.fcp + '  SI ' + mobile.si + '  TBT ' + mobile.tbt,
    'Desktop: ' + desktop.score + '/100 (threshold ' + THRESHOLDS.desktop + ')  LCP ' + desktop.lcp + '  CLS ' + desktop.cls + '  INP ' + desktop.inp + '  FCP ' + desktop.fcp + '  SI ' + desktop.si + '  TBT ' + desktop.tbt,
    '',
    'LIGHTHOUSE DETAIL (mobile)',
    mobileLH || '(none)',
    '',
    'LIGHTHOUSE DETAIL (desktop)',
    desktopLH || '(none)',
    '',
  ];

  if (siteAudit) {
    if (siteAudit.consoleErrors.length > 0) {
      prompt.push('CONSOLE ERRORS');
      siteAudit.consoleErrors.slice(0, 10).forEach(function(e) { prompt.push('  ' + e); });
      prompt.push('');
    }
    if (siteAudit.failedRequests.length > 0) {
      prompt.push('FAILED NETWORK REQUESTS');
      siteAudit.failedRequests.slice(0, 10).forEach(function(r) { prompt.push('  ' + r); });
      prompt.push('');
    }
    if (siteAudit.brokenLinks.length > 0) {
      prompt.push('BROKEN INTERNAL LINKS');
      siteAudit.brokenLinks.forEach(function(l) { prompt.push('  ' + l); });
      prompt.push('');
    }
  }

  for (const { path, content } of contextSections) {
    prompt.push(path, content, '');
  }

  if (schemaFailures && schemaFailures.length > 0) {
    prompt.push('SCHEMA VALIDATION FAILURES');
    schemaFailures.forEach(function(f) {
      if (f.error) {
        prompt.push('  ' + f.url + ': error -- ' + f.error);
      } else {
        prompt.push('  ' + f.url + ': missing ' + f.missing.join(', '));
        prompt.push('    found: ' + (f.found.length > 0 ? f.found.join(', ') : '(none)'));
      }
    });
    prompt.push('');
  }

  prompt.push(
    'Respond in this exact format:',
    '',
    '## Root Cause',
    '[1-2 sentences identifying the specific cause]',
    '',
    '## Fix',
    '[Concrete steps referencing specific files and line numbers]',
    '',
    '## Confidence',
    '[high / medium / low]',
    '',
    '## Patch',
    'If confidence is high and the fix requires exact, safe string replacements in the source files',
    'provided above, include a JSON patch block. Otherwise omit this section entirely.',
    '```json',
    '{',
    '  "files": [',
    '    {',
    '      "path": "relative/path/from/repo/root.tsx",',
    '      "search": "exact string to find (must be unique in the file)",',
    '      "replace": "replacement string"',
    '    }',
    '  ]',
    '}',
    '```',
    '',
    'Be concise. The diagnosis (Root Cause + Fix + Confidence) goes into a GitHub issue.'
  );

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt.join('\n') }],
    }),
  });

  if (!res.ok) {
    console.error('Anthropic API error: ' + await res.text());
    return null;
  }
  const data = await res.json();
  const text = data.content[0].text;

  // Split diagnosis (for issue) from patch (for PR)
  const patchSplit = text.split(/^## Patch/m);
  const diagnosis = patchSplit[0].trim();

  let patch = null;
  if (patchSplit[1]) {
    const jsonMatch = patchSplit[1].match(/```json\s*([\s\S]*?)```/);
    if (jsonMatch) {
      try { patch = JSON.parse(jsonMatch[1]); } catch {}
    }
  }

  return { diagnosis, patch };
}

// --- Auto-fix PR ------------------------------------------------------------

async function proposeFix(patch, issueNumber) {
  if (!patch || !Array.isArray(patch.files) || patch.files.length === 0) return null;

  const branch = 'fix/psi-auto-' + today;

  try {
    // If a PR already exists for this branch, return it rather than creating a duplicate.
    const existingPRs = await gh('GET', '/repos/' + OWNER + '/' + REPO + '/pulls?head=' + OWNER + ':' + branch + '&state=open');
    if (existingPRs && existingPRs.length > 0) {
      console.log('PR already exists for ' + branch + ' (#' + existingPRs[0].number + '), skipping.');
      return existingPRs[0];
    }

    execSync('git config user.name "github-actions[bot]"', { cwd: ROOT });
    execSync('git config user.email "github-actions[bot]@users.noreply.github.com"', { cwd: ROOT });
    execSync('git fetch origin main', { cwd: ROOT });
    execSync('git checkout -B ' + branch + ' origin/main', { cwd: ROOT });

    let applied = 0;
    for (const file of patch.files) {
      const fullPath = join(ROOT, file.path);
      let content;
      try { content = readFileSync(fullPath, 'utf8'); } catch {
        console.warn('Patch: file not found: ' + file.path);
        continue;
      }
      if (!content.includes(file.search)) {
        console.warn('Patch: search string not found in ' + file.path);
        continue;
      }
      writeFileSync(fullPath, content.replace(file.search, file.replace), 'utf8');
      execSync('git add ' + file.path, { cwd: ROOT });
      applied++;
    }

    if (applied === 0) {
      console.log('Patch: no files changed, skipping PR.');
      return null;
    }

    execSync('git commit -m "fix(psi-auto): proposed fix for site health issue #' + issueNumber + '"', { cwd: ROOT });
    execSync('git push --force origin ' + branch, { cwd: ROOT });

    const pr = await gh('POST', '/repos/' + OWNER + '/' + REPO + '/pulls', {
      title: 'fix: proposed auto-fix for site health issue #' + issueNumber,
      body: 'Auto-generated fix proposed by the PSI monitor for issue #' + issueNumber + '.\n\nReview carefully before merging — this was generated by Claude (`claude-sonnet-4-6`) based on Lighthouse data alone and may be outdated or incorrect if other work was already in flight.',
      head: branch,
      base: 'main',
      draft: true,
    });

    console.log('Opened draft PR #' + pr.number + ' (' + branch + ')');
    return pr;
  } catch (err) {
    console.error('proposeFix error (non-fatal): ' + err.message);
    return null;
  }
}

// --- GitHub issue management ------------------------------------------------

async function ensureLabel() {
  const existing = await gh('GET', '/repos/' + OWNER + '/' + REPO + '/labels/' + encodeURIComponent(LABEL));
  if (!existing) {
    await gh('POST', '/repos/' + OWNER + '/' + REPO + '/labels', {
      name: LABEL,
      color: 'e4e669',
      description: 'Weekly site health regression',
    });
  }
}

async function findOpenIssue() {
  const issues = await gh('GET', '/repos/' + OWNER + '/' + REPO + '/issues?state=open&labels=' + encodeURIComponent(LABEL) + '&per_page=10');
  return (issues || []).find(function(i) { return i.title.startsWith('Site health'); });
}

function buildBody(mobile, desktop, siteAudit, schemaFailures, diagnosis, fixPr) {
  const lines = [];

  // PSI scores table
  const mRow = '| mobile  | ' + (mobile.score >= THRESHOLDS.mobile ? 'PASS' : 'FAIL') + ' ' + mobile.score + ' | ' + mobile.lcp + ' | ' + mobile.cls + ' | ' + mobile.inp + ' | ' + mobile.fcp + ' |';
  const dRow = '| desktop | ' + (desktop.score >= THRESHOLDS.desktop ? 'PASS' : 'FAIL') + ' ' + desktop.score + ' | ' + desktop.lcp + ' | ' + desktop.cls + ' | ' + desktop.inp + ' | ' + desktop.fcp + ' |';
  lines.push('## PSI scores');
  lines.push('');
  lines.push('| Strategy | Score | LCP | CLS | INP | FCP |');
  lines.push('|---|---|---|---|---|---|');
  lines.push(mRow);
  lines.push(dRow);
  lines.push('');
  lines.push('Thresholds: mobile >= ' + THRESHOLDS.mobile + ', desktop >= ' + THRESHOLDS.desktop);
  lines.push('Full report: https://pagespeed.web.dev/analysis?url=' + encodeURIComponent(SITE_URL));

  // Site audit findings
  if (siteAudit) {
    const hasIssues = siteAudit.consoleErrors.length > 0 || siteAudit.failedRequests.length > 0 || siteAudit.brokenLinks.length > 0;
    if (hasIssues) {
      lines.push('');
      lines.push('## Site audit findings');
      if (siteAudit.consoleErrors.length > 0) {
        lines.push('');
        lines.push('**Console errors (' + siteAudit.consoleErrors.length + ')**');
        siteAudit.consoleErrors.slice(0, 10).forEach(function(e) { lines.push('- ' + e); });
      }
      if (siteAudit.failedRequests.length > 0) {
        lines.push('');
        lines.push('**Failed requests (' + siteAudit.failedRequests.length + ')**');
        siteAudit.failedRequests.slice(0, 10).forEach(function(r) { lines.push('- ' + r); });
      }
      if (siteAudit.brokenLinks.length > 0) {
        lines.push('');
        lines.push('**Broken internal links (' + siteAudit.brokenLinks.length + ')**');
        siteAudit.brokenLinks.forEach(function(l) { lines.push('- ' + l); });
      }
    }
  }

  // Schema validation failures
  if (schemaFailures && schemaFailures.length > 0) {
    lines.push('');
    lines.push('## Schema validation failures');
    for (const f of schemaFailures) {
      if (f.error) {
        lines.push('- **' + f.url + '**: error -- ' + f.error);
      } else {
        lines.push('- **' + f.url + '**: missing `' + f.missing.join('`, `') + '`');
        lines.push('  Found: ' + (f.found.length > 0 ? f.found.join(', ') : '(none)'));
      }
    }
  }

  // Claude diagnosis
  if (diagnosis) {
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('## Diagnosis');
    lines.push('');
    lines.push(diagnosis);
  }

  // Auto-fix PR
  if (fixPr) {
    lines.push('');
    lines.push('## Proposed fix');
    lines.push('');
    lines.push('Draft PR ready for review: ' + fixPr.html_url);
  }

  lines.push('');
  lines.push('Run date: ' + today);

  return lines.join('\n');
}

// --- Main -------------------------------------------------------------------

async function main() {
  if (!SITE_URL) throw new Error('SITE_URL env var is required');

  // PSI checks
  console.log('Fetching PSI scores...');
  const mobileData = await fetchPSI('mobile');
  await sleep(10000);
  const desktopData = await fetchPSI('desktop');

  let mobile  = extractMetrics(mobileData);
  let desktop = extractMetrics(desktopData);

  console.log('');
  console.log('=== PSI Results ===');
  console.log('Strategy  Score  LCP      CLS    INP    FCP      SI       TBT');
  console.log('mobile    ' + String(mobile.score).padEnd(5) + '  ' + String(mobile.lcp).padEnd(7) + '  ' + String(mobile.cls).padEnd(5) + '  ' + String(mobile.inp).padEnd(5) + '  ' + String(mobile.fcp).padEnd(7) + '  ' + String(mobile.si).padEnd(7) + '  ' + mobile.tbt);
  console.log('desktop   ' + String(desktop.score).padEnd(5) + '  ' + String(desktop.lcp).padEnd(7) + '  ' + String(desktop.cls).padEnd(5) + '  ' + String(desktop.inp).padEnd(5) + '  ' + String(desktop.fcp).padEnd(7) + '  ' + String(desktop.si).padEnd(7) + '  ' + desktop.tbt);
  console.log('Thresholds: mobile >= ' + THRESHOLDS.mobile + ', desktop >= ' + THRESHOLDS.desktop);

  const mobileLH  = extractLighthouseDetail(mobileData);
  const desktopLH = extractLighthouseDetail(desktopData);
  if (mobileLH)  { console.log(''); console.log('--- Lighthouse detail (mobile) ---');  console.log(mobileLH); }
  if (desktopLH) { console.log(''); console.log('--- Lighthouse detail (desktop) ---'); console.log(desktopLH); }
  console.log('');

  let finalMobileData  = mobileData;
  let finalDesktopData = desktopData;
  let psiFlaky = false;

  // If PSI fails, wait 5 minutes and retry before raising an alarm.
  // A single bad lab measurement is common; two consecutive failures means it's real.
  // Site audit failures are deterministic and don't need a retry.
  if (mobile.score < THRESHOLDS.mobile || desktop.score < THRESHOLDS.desktop) {
    console.log('PSI below threshold. Waiting 5 minutes before retry to rule out lab noise...');
    await sleep(5 * 60 * 1000);

    if (mobile.score < THRESHOLDS.mobile) {
      finalMobileData = await fetchPSI('mobile');
      await sleep(10000);
    }
    if (desktop.score < THRESHOLDS.desktop) {
      finalDesktopData = await fetchPSI('desktop');
    }

    const retryMobile  = extractMetrics(finalMobileData);
    const retryDesktop = extractMetrics(finalDesktopData);
    console.log('Retry, mobile: ' + retryMobile.score + '  desktop: ' + retryDesktop.score);

    if (retryMobile.score >= THRESHOLDS.mobile && retryDesktop.score >= THRESHOLDS.desktop) {
      psiFlaky = true;
      console.log('Retry passed. First run was PSI lab noise.');
    }

    mobile  = retryMobile;
    desktop = retryDesktop;
  }

  const psiPass = mobile.score >= THRESHOLDS.mobile && desktop.score >= THRESHOLDS.desktop;

  // Schema validation runs first — before the site audit's link checker makes raw
  // HTTP requests that can trigger Cloudflare bot mitigation on the runner IP.
  let schemaFailures = null;
  try {
    schemaFailures = await validateSchema();
  } catch (err) {
    console.error('Schema validation error (non-fatal): ' + err.message);
  }

  // Playwright site audit (always runs)
  let siteAudit = null;
  try {
    siteAudit = await runSiteAudit();
  } catch (err) {
    console.error('Site audit error (non-fatal): ' + err.message);
  }

  const auditPass = !siteAudit || (
    siteAudit.consoleErrors.length === 0 &&
    siteAudit.failedRequests.length === 0 &&
    siteAudit.brokenLinks.length === 0
  );

  const schemaPass = !schemaFailures || schemaFailures.length === 0;
  const allPass = psiPass && auditPass && schemaPass;

  if (allPass) {
    if (psiFlaky) {
      console.log('PSI noise on first run, retry passed. No issue raised.');
    } else {
      console.log('All checks passed.');
    }
    const openIssue = await findOpenIssue();
    if (openIssue) {
      await gh('POST', '/repos/' + OWNER + '/' + REPO + '/issues/' + openIssue.number + '/comments', {
        body: 'All checks recovered on ' + today + ': mobile ' + mobile.score + ', desktop ' + desktop.score + ', no site audit issues. Closing.',
      });
      await gh('PATCH', '/repos/' + OWNER + '/' + REPO + '/issues/' + openIssue.number, { state: 'closed' });
      console.log('Closed issue #' + openIssue.number);
    }
    return;
  }

  // Something failed on both PSI runs (or site audit failed): get Claude diagnosis
  console.log('Issues confirmed. Calling Claude for diagnosis...');
  let diagnosis = '(No ANTHROPIC_API_KEY set, diagnosis skipped)';
  let patch = null;
  if (ANTHROPIC_API_KEY) {
    const result = await diagnose(finalMobileData, finalDesktopData, mobile, desktop, siteAudit, schemaFailures);
    if (result) {
      diagnosis = result.diagnosis;
      patch = result.patch;
    } else {
      diagnosis = '(Claude diagnosis unavailable -- Anthropic API error. Check workflow logs for details.)';
    }
  }

  // Open/update the issue first so we have an issue number for the PR
  await ensureLabel();
  const openIssue = await findOpenIssue();
  let issueNumber;

  if (openIssue) {
    issueNumber = openIssue.number;
  } else {
    const parts = [];
    if (!psiPass) parts.push('PSI mobile ' + mobile.score + ' desktop ' + desktop.score);
    if (!auditPass) parts.push('audit issues');
    if (!schemaPass) parts.push('schema failures');
    const title = 'Site health regression (' + today + '): ' + parts.join(', ');
    const issue = await gh('POST', '/repos/' + OWNER + '/' + REPO + '/issues', {
      title: title,
      body: buildBody(mobile, desktop, siteAudit, schemaFailures, diagnosis, null),
      labels: [LABEL],
    });
    issueNumber = issue.number;
    console.log('Opened issue #' + issueNumber);
  }

  // Attempt auto-fix PR if Claude returned a patch
  const fixPr = patch ? await proposeFix(patch, issueNumber) : null;

  // Update issue body/comment with PR link if a fix was proposed
  const body = buildBody(mobile, desktop, siteAudit, schemaFailures, diagnosis, fixPr);
  if (openIssue) {
    await gh('POST', '/repos/' + OWNER + '/' + REPO + '/issues/' + issueNumber + '/comments', {
      body: 'Weekly update (' + today + '):\n\n' + body,
    });
    console.log('Updated issue #' + issueNumber);
  } else if (fixPr) {
    // Patch the issue body to include the PR link now that we have it
    await gh('PATCH', '/repos/' + OWNER + '/' + REPO + '/issues/' + issueNumber, { body });
  }
}

main().catch(function(err) {
  console.error(err);
  process.exit(1);
});
