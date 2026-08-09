#!/usr/bin/env node
/**
 * PSI Monitor with Playwright site audit and Claude diagnosis
 *
 * Runs on a schedule via GitHub Actions (caller sets the cron).
 *
 * 1. Fetches PageSpeed Insights for all configured pages (mobile + desktop)
 * 2. Checks performance, accessibility, best-practices, and SEO scores
 * 3. Runs a Playwright headless audit of the live site (homepage):
 *    - Console errors and JS exceptions
 *    - Failed network requests (4xx / 5xx)
 *    - Broken internal links
 * 4. If anything fails: calls Claude with full Lighthouse detail + audit
 *    results + key source files, then opens/updates a GitHub issue
 * 5. If everything passes: silent. Closes any open issue if recovered.
 *
 * Required env vars:
 *   GITHUB_TOKEN        -- provided automatically by GitHub Actions
 *   GITHUB_REPOSITORY   -- provided automatically by GitHub Actions
 *   ANTHROPIC_API_KEY   -- repository secret
 *   GOOGLE_PSI_API_KEY  -- repository secret (avoids PSI rate limits on cloud IPs)
 *   SITE_URL            -- e.g. https://doublewolf.consulting
 *   PAGES               -- optional JSON array of page URLs (defaults to [SITE_URL])
 *   MOBILE_THRESHOLD    -- legacy: minimum mobile performance score (default 90)
 *   DESKTOP_THRESHOLD   -- legacy: minimum desktop performance score (default 90)
 *   PERFORMANCE_MOBILE_THRESHOLD  -- per-category threshold (0 = fall back to MOBILE_THRESHOLD)
 *   PERFORMANCE_DESKTOP_THRESHOLD -- per-category threshold (0 = fall back to DESKTOP_THRESHOLD)
 *   ACCESSIBILITY_MOBILE_THRESHOLD  -- 0 = skip check
 *   ACCESSIBILITY_DESKTOP_THRESHOLD -- 0 = skip check
 *   BEST_PRACTICES_MOBILE_THRESHOLD -- 0 = skip check
 *   BEST_PRACTICES_DESKTOP_THRESHOLD -- 0 = skip check
 *   SEO_MOBILE_THRESHOLD  -- 0 = skip check
 *   SEO_DESKTOP_THRESHOLD -- 0 = skip check
 *   CONTEXT_FILES       -- space-separated repo-relative paths to include in Claude context
 *   SCHEMA_CONFIG       -- optional JSON mapping URLs to expected schema type arrays
 *                          e.g. {"https://example.com/":["Organization","WebSite","WebPage"]}
 */

import { readFileSync, writeFileSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
// This script lives at _wf/scripts/psi-monitor.mjs in the runner workspace.
// Two levels up is the workspace root, i.e. the caller's checked-out repo.
const ROOT = join(__dirname, '../..');

const SITE_URL = process.env.SITE_URL || '';
const PAGES = process.env.PAGES ? (() => {
  try { return JSON.parse(process.env.PAGES); }
  catch (e) { console.error('Invalid PAGES JSON: ' + e.message); return [SITE_URL]; }
})() : [SITE_URL];

// Per-category thresholds. 0 = skip that category.
// Performance falls back to legacy MOBILE_THRESHOLD / DESKTOP_THRESHOLD for backwards compat.
const CATEGORY_THRESHOLDS = {
  performance: {
    mobile:  parseInt(process.env.PERFORMANCE_MOBILE_THRESHOLD)  || parseInt(process.env.MOBILE_THRESHOLD)  || 90,
    desktop: parseInt(process.env.PERFORMANCE_DESKTOP_THRESHOLD) || parseInt(process.env.DESKTOP_THRESHOLD) || 90,
  },
  accessibility: {
    mobile:  parseInt(process.env.ACCESSIBILITY_MOBILE_THRESHOLD)  || 0,
    desktop: parseInt(process.env.ACCESSIBILITY_DESKTOP_THRESHOLD) || 0,
  },
  'best-practices': {
    mobile:  parseInt(process.env.BEST_PRACTICES_MOBILE_THRESHOLD)  || 0,
    desktop: parseInt(process.env.BEST_PRACTICES_DESKTOP_THRESHOLD) || 0,
  },
  seo: {
    mobile:  parseInt(process.env.SEO_MOBILE_THRESHOLD)  || 0,
    desktop: parseInt(process.env.SEO_DESKTOP_THRESHOLD) || 0,
  },
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

async function fetchPSI(pageUrl, strategy, attempt) {
  if (!attempt) attempt = 1;
  const url = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed' +
    '?url=' + encodeURIComponent(pageUrl) + '&strategy=' + strategy +
    '&category=performance&category=accessibility&category=best-practices&category=seo' +
    (GOOGLE_PSI_API_KEY ? '&key=' + GOOGLE_PSI_API_KEY : '');
  const res = await fetch(url);
  // Retry on 429 (rate limit) and 400/5xx (transient API failures).
  // Google's PSI API returns 400 when it cannot queue the analysis for a strategy,
  // which happens transiently under load — not just for bad requests.
  if ((res.status === 429 || res.status === 400 || res.status >= 500) && attempt < 4) {
    const wait = attempt * 15000;
    console.log('PSI API ' + res.status + ' for ' + strategy + ' ' + pageUrl + ', retrying in ' + (wait / 1000) + 's...');
    await sleep(wait);
    return fetchPSI(pageUrl, strategy, attempt + 1);
  }
  if (!res.ok) throw new Error('PSI API ' + res.status + ' for ' + strategy + ' ' + pageUrl);
  return res.json();
}

function extractMetrics(data) {
  const audits = data.lighthouseResult.audits;
  const cats = data.lighthouseResult.categories;
  return {
    performance:      cats.performance       ? Math.round(cats.performance.score * 100)       : null,
    accessibility:    cats.accessibility     ? Math.round(cats.accessibility.score * 100)     : null,
    'best-practices': cats['best-practices'] ? Math.round(cats['best-practices'].score * 100) : null,
    seo:              cats.seo               ? Math.round(cats.seo.score * 100)               : null,
    lcp: audits['largest-contentful-paint'].displayValue,
    cls: audits['cumulative-layout-shift'].displayValue,
    inp: (audits['interaction-to-next-paint'] || {}).displayValue || 'N/A',
    fcp: audits['first-contentful-paint'].displayValue,
    si:  audits['speed-index'].displayValue,
    tbt: audits['total-blocking-time'].displayValue,
  };
}

function checkThresholdFailures(mobile, desktop) {
  const failures = [];
  for (const [cat, thresholds] of Object.entries(CATEGORY_THRESHOLDS)) {
    if (thresholds.mobile > 0 && mobile[cat] !== null && mobile[cat] < thresholds.mobile) {
      failures.push({ category: cat, strategy: 'mobile', score: mobile[cat], threshold: thresholds.mobile });
    }
    if (thresholds.desktop > 0 && desktop[cat] !== null && desktop[cat] < thresholds.desktop) {
      failures.push({ category: cat, strategy: 'desktop', score: desktop[cat], threshold: thresholds.desktop });
    }
  }
  return failures;
}

async function auditPage(pageUrl) {
  console.log('Fetching PSI for ' + pageUrl + '...');
  let mobileData, desktopData;
  try {
    mobileData = await fetchPSI(pageUrl, 'mobile');
    await sleep(10000);
    desktopData = await fetchPSI(pageUrl, 'desktop');
  } catch (err) {
    console.error('PSI error for ' + pageUrl + ': ' + err.message);
    return { pageUrl, mobile: null, desktop: null, mobileData: null, desktopData: null, failures: [], psiError: err.message };
  }
  const mobile  = extractMetrics(mobileData);
  const desktop = extractMetrics(desktopData);
  const failures = checkThresholdFailures(mobile, desktop);
  return { pageUrl, mobile, desktop, mobileData, desktopData, failures, psiError: null };
}

function logPageResult(result, isRetry) {
  const prefix = isRetry ? 'Retry ' : '';
  const pagePath = result.pageUrl.replace(/^https?:\/\/[^/]+/, '') || '/';
  if (result.psiError) {
    console.log(prefix + 'PSI ERROR for ' + pagePath + ': ' + result.psiError);
    return;
  }
  const m = result.mobile;
  const d = result.desktop;
  const catNames = { performance: 'Performance', accessibility: 'Accessibility', 'best-practices': 'Best Practices', seo: 'SEO' };
  console.log('');
  console.log('=== ' + prefix + 'PSI: ' + result.pageUrl + ' ===');
  for (const [cat, thresholds] of Object.entries(CATEGORY_THRESHOLDS)) {
    if (thresholds.mobile === 0 && thresholds.desktop === 0) continue;
    const mScore = m[cat] !== null ? m[cat] : 'N/A';
    const dScore = d[cat] !== null ? d[cat] : 'N/A';
    const mFail = thresholds.mobile > 0 && m[cat] !== null && m[cat] < thresholds.mobile ? ' < ' + thresholds.mobile + ' FAIL' : '';
    const dFail = thresholds.desktop > 0 && d[cat] !== null && d[cat] < thresholds.desktop ? ' < ' + thresholds.desktop + ' FAIL' : '';
    console.log((catNames[cat] || cat).padEnd(16) + '  mobile ' + String(mScore).padEnd(4) + mFail + '  desktop ' + dScore + dFail);
  }
  console.log('CWV mobile:  LCP ' + m.lcp + '  CLS ' + m.cls + '  INP ' + m.inp + '  FCP ' + m.fcp + '  SI ' + m.si + '  TBT ' + m.tbt);
  console.log('CWV desktop: LCP ' + d.lcp + '  CLS ' + d.cls + '  INP ' + d.inp + '  FCP ' + d.fcp + '  SI ' + d.si + '  TBT ' + d.tbt);
  if (result.failures.length > 0) {
    console.log('FAILURES: ' + result.failures.map(function(f) { return f.category + ' ' + f.strategy + ' ' + f.score + '/' + f.threshold; }).join(', '));
  }
  const mobileLH  = extractLighthouseDetail(result.mobileData);
  const desktopLH = extractLighthouseDetail(result.desktopData);
  if (mobileLH)  { console.log(''); console.log('--- Lighthouse detail (mobile) ---');  console.log(mobileLH); }
  if (desktopLH) { console.log(''); console.log('--- Lighthouse detail (desktop) ---'); console.log(desktopLH); }
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

  // Accessibility failures — show failing audits with element snippets for diagnosis
  const accessibilityIds = [
    'color-contrast',
    'image-alt',
    'label',
    'heading-order',
    'link-name',
    'button-name',
    'aria-hidden-body',
    'duplicate-id-active',
  ];
  const a11yLines = [];
  for (const id of accessibilityIds) {
    const a = audits[id];
    if (a && a.score !== null && a.score < 1) {
      a11yLines.push('  ' + (a.title || id) + ':');
      if (a.details && a.details.items) {
        a.details.items.slice(0, 5).forEach(function(item) {
          const snippet = (item.node && item.node.snippet) || '';
          const ratio = (item.contrastRatio != null)
            ? ' (ratio: ' + item.contrastRatio.toFixed(2) + ':1, need ' + item.thresholdRatio + ':1)'
            : '';
          if (snippet) a11yLines.push('    - ' + snippet.slice(0, 120) + ratio);
        });
      }
    }
  }
  if (a11yLines.length > 0) {
    lines.push('Accessibility failures:');
    a11yLines.forEach(function(l) { lines.push(l); });
  }

  return lines.join('\n');
}

// extractAllFindings: like extractLighthouseDetail but includes passing items too,
// so the job summary shows the full picture even when scores are perfect.
// extractLighthouseDetail (score < 0.9 filter) is still used for Claude prompts
// to keep token cost proportional to actual failures.
function extractAllFindings(data) {
  const audits = data.lighthouseResult.audits;
  const lines = [];

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
    'efficient-animated-content',
    'uses-rel-preconnect',
    'font-display',
  ];
  const oppLines = [];
  for (const id of opportunityIds) {
    const a = audits[id];
    if (!a || a.score === null || !a.displayValue) continue;
    const icon = a.score >= 0.9 ? '✅' : (a.score >= 0.5 ? '⚠️' : '❌');
    oppLines.push(icon + ' ' + (a.title || id) + ': ' + a.displayValue);
    // Show URL details for non-passing items only
    if (a.score < 0.9 && a.details && a.details.items) {
      a.details.items.slice(0, 3).forEach(function(item) {
        const label = item.url || item.label || '';
        if (label) oppLines.push('  - ' + String(label).slice(0, 100));
      });
    }
  }
  if (oppLines.length > 0) {
    lines.push('**Opportunities**');
    oppLines.forEach(function(l) { lines.push(l); });
  }

  const diagnosticIds = [
    'dom-size',
    'server-response-time',
    'redirects',
    'mainthread-work-breakdown',
    'bootup-time',
    'third-party-summary',
    'uses-long-cache-ttl',
    'critical-request-chains',
    'resource-summary',
    'network-requests',
  ];
  const diagLines = [];
  for (const id of diagnosticIds) {
    const a = audits[id];
    if (!a || a.score === null || !a.displayValue) continue;
    const icon = a.score >= 0.9 ? '✅' : (a.score >= 0.5 ? '⚠️' : '❌');
    diagLines.push(icon + ' ' + (a.title || id) + ': ' + a.displayValue);
  }
  if (diagLines.length > 0) {
    if (oppLines.length > 0) lines.push('');
    lines.push('**Diagnostics**');
    diagLines.forEach(function(l) { lines.push(l); });
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

  await browser.close();

  // Check up to 20 internal links for 4xx/5xx using fresh browser navigations.
  // page.evaluate(fetch()) is blocked by Cloudflare Bot Fight Mode with 403 because
  // JS fetch requests carry Sec-Fetch-Mode: cors/same-origin instead of navigate —
  // these 403s then appear as false console errors and failed requests in audit results.
  // A fresh browser per link with page.goto() carries the correct navigation fingerprint
  // (same approach used in schema validation). waitUntil:'commit' returns as soon as the
  // HTTP response headers arrive so link checks don't wait for full page render.
  const brokenLinks = [];
  for (const link of links.slice(0, 20)) {
    const linkBrowser = await chromium.launch({ args: ['--disable-blink-features=AutomationControlled'] });
    try {
      const linkPage = await newStealthPage(linkBrowser);
      let status = 0;
      try {
        const response = await linkPage.goto(link, { waitUntil: 'commit', timeout: 15000 });
        status = response ? response.status() : 0;
      } catch {}
      if (status >= 400) brokenLinks.push(status + ' ' + link);
    } finally {
      await linkBrowser.close();
    }
  }

  console.log(
    'Site audit: ' + consoleErrors.length + ' console error(s), ' +
    failedRequests.length + ' failed request(s), ' +
    brokenLinks.length + ' broken link(s)'
  );
  return { consoleErrors, failedRequests, brokenLinks };
}

// --- Schema validation ------------------------------------------------------
// Uses a fresh Playwright browser context per URL. Reusing a single page across
// multiple navigations triggers Cloudflare's bot detection (no user interaction
// signals between rapid cross-page navigations). A fresh context per URL looks
// like independent browser visits and passes the challenge every time.
// page.content() retrieves the HTML; JSON-LD is parsed in Node.js.

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
    const browser = await chromium.launch({ args: ['--disable-blink-features=AutomationControlled'] });
    try {
      const page = await newStealthPage(browser);
      await page.goto(url, { waitUntil: 'load', timeout: 30000 });
      const html = await page.content();
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
    } finally {
      await browser.close();
    }
  }

  console.log('Schema validation: ' + failures.length + ' failure(s)');
  return failures.length > 0 ? failures : null;
}

// --- Claude diagnosis -------------------------------------------------------

async function diagnose(failingResults, siteAudit, schemaFailures) {
  // Read context files from the caller's repo
  const contextSections = [];
  for (const relPath of CONTEXT_FILES) {
    try {
      const content = readFileSync(join(ROOT, relPath), 'utf8');
      contextSections.push({ path: relPath, content });
    } catch {}
  }

  const prompt = [
    'You are a senior web performance and accessibility engineer auditing ' + SITE_URL + '.',
    'The weekly site health monitor detected issues. Diagnose the root cause.',
    '',
  ];

  // Include diagnostic detail only for pages that actually failed
  for (const result of failingResults) {
    const m = result.mobile;
    const d = result.desktop;
    prompt.push('PAGE: ' + result.pageUrl);
    prompt.push('Failures: ' + result.failures.map(function(f) {
      return f.category + ' ' + f.strategy + ' ' + f.score + '/' + f.threshold;
    }).join(', '));
    prompt.push('CWV mobile:  LCP ' + m.lcp + '  CLS ' + m.cls + '  INP ' + m.inp + '  FCP ' + m.fcp + '  SI ' + m.si + '  TBT ' + m.tbt);
    prompt.push('CWV desktop: LCP ' + d.lcp + '  CLS ' + d.cls + '  INP ' + d.inp + '  FCP ' + d.fcp + '  SI ' + d.si + '  TBT ' + d.tbt);
    prompt.push('');

    const mobileLH  = extractLighthouseDetail(result.mobileData);
    const desktopLH = extractLighthouseDetail(result.desktopData);
    if (mobileLH)  { prompt.push('LIGHTHOUSE DETAIL (mobile)');  prompt.push(mobileLH);  prompt.push(''); }
    if (desktopLH) { prompt.push('LIGHTHOUSE DETAIL (desktop)'); prompt.push(desktopLH); prompt.push(''); }

    // Include site audit data when it's for the homepage
    if (result.pageUrl === SITE_URL && siteAudit) {
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
  }

  // If the homepage is not in failingResults but the site audit has issues, include them
  const homepageInFailing = failingResults.some(function(r) { return r.pageUrl === SITE_URL; });
  if (!homepageInFailing && siteAudit) {
    const hasAuditIssues = siteAudit.consoleErrors.length > 0 || siteAudit.failedRequests.length > 0 || siteAudit.brokenLinks.length > 0;
    if (hasAuditIssues) {
      prompt.push('SITE AUDIT ISSUES (' + SITE_URL + ')');
      if (siteAudit.consoleErrors.length > 0) {
        prompt.push('Console errors:');
        siteAudit.consoleErrors.slice(0, 10).forEach(function(e) { prompt.push('  ' + e); });
        prompt.push('');
      }
      if (siteAudit.failedRequests.length > 0) {
        prompt.push('Failed requests:');
        siteAudit.failedRequests.slice(0, 10).forEach(function(r) { prompt.push('  ' + r); });
        prompt.push('');
      }
      if (siteAudit.brokenLinks.length > 0) {
        prompt.push('Broken links:');
        siteAudit.brokenLinks.forEach(function(l) { prompt.push('  ' + l); });
        prompt.push('');
      }
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

// --- Issue body -------------------------------------------------------------

function getActiveColumns() {
  const catLabels = { performance: 'Perf', accessibility: 'A11y', 'best-practices': 'BP', seo: 'SEO' };
  const cols = [];
  for (const [cat, thresholds] of Object.entries(CATEGORY_THRESHOLDS)) {
    if (thresholds.mobile  > 0) cols.push({ cat, strategy: 'mobile',  label: catLabels[cat] + ' M', threshold: thresholds.mobile  });
    if (thresholds.desktop > 0) cols.push({ cat, strategy: 'desktop', label: catLabels[cat] + ' D', threshold: thresholds.desktop });
  }
  return cols;
}

function buildScoresTable(pageResults) {
  const cols = getActiveColumns();
  if (cols.length === 0) return '';

  const header = '| Page | ' + cols.map(function(c) { return c.label; }).join(' | ') + ' |';
  const sep    = '|' + '---|'.repeat(cols.length + 1);

  const rows = pageResults.map(function(result) {
    const pagePath = result.pageUrl.replace(/^https?:\/\/[^/]+/, '') || '/';
    if (result.psiError) {
      return '| `' + pagePath + '` | ' + cols.map(function() { return 'ERR ❌'; }).join(' | ') + ' |';
    }
    const cells = cols.map(function(col) {
      const scores = col.strategy === 'mobile' ? result.mobile : result.desktop;
      const score = scores ? scores[col.cat] : null;
      if (score === null || score === undefined) return 'N/A';
      const pass = score >= col.threshold;
      const cell = score + ' ' + (pass ? '✅' : '❌');
      return pass ? cell : '**' + cell + '**';
    });
    return '| `' + pagePath + '` | ' + cells.join(' | ') + ' |';
  });

  return [header, sep].concat(rows).join('\n');
}

function buildBody(pageResults, siteAudit, schemaFailures, diagnosis, fixPr) {
  const lines = [];

  // Multi-page PSI scores table
  lines.push('## PSI scores');
  lines.push('');
  lines.push(buildScoresTable(pageResults));
  lines.push('');

  // Threshold legend
  const thresholdParts = [];
  for (const [cat, thresholds] of Object.entries(CATEGORY_THRESHOLDS)) {
    const parts = [];
    if (thresholds.mobile  > 0) parts.push('mobile >= ' + thresholds.mobile);
    if (thresholds.desktop > 0) parts.push('desktop >= ' + thresholds.desktop);
    if (parts.length > 0) thresholdParts.push(cat + ': ' + parts.join(', '));
  }
  lines.push('Thresholds: ' + thresholdParts.join(' | '));
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

// --- GitHub Actions job summary ---------------------------------------------
// Written unconditionally after every run so findings are visible even when
// all scores pass. No extra API calls — data comes from already-fetched PSI responses.

function writeSummary(pageResults, schemaFailures, siteAudit) {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryFile) return;

  const lines = ['## PSI Monitor — ' + today, ''];

  // Scores table
  const table = buildScoresTable(pageResults);
  if (table) {
    lines.push(table);
    lines.push('');
    const thresholdParts = [];
    for (const [cat, thresholds] of Object.entries(CATEGORY_THRESHOLDS)) {
      const parts = [];
      if (thresholds.mobile  > 0) parts.push('mobile >= ' + thresholds.mobile);
      if (thresholds.desktop > 0) parts.push('desktop >= ' + thresholds.desktop);
      if (parts.length > 0) thresholdParts.push(cat + ': ' + parts.join(', '));
    }
    if (thresholdParts.length > 0) lines.push('_Thresholds: ' + thresholdParts.join(' | ') + '_');
    lines.push('');
  }

  // Per-page Lighthouse findings — always shown so optimisations are visible
  // even on perfect-score runs. ✅ passing · ⚠️ borderline · ❌ failing.
  for (const result of pageResults) {
    if (!result.mobileData && !result.desktopData) continue;
    const pagePath = result.pageUrl.replace(/^https?:\/\/[^/]+/, '') || '/';

    lines.push('### `' + pagePath + '`');
    lines.push('_[Full report](' + 'https://pagespeed.web.dev/analysis?url=' + encodeURIComponent(result.pageUrl) + ')_');
    lines.push('');

    if (result.mobileData) {
      const findings = extractAllFindings(result.mobileData);
      lines.push('<details>');
      lines.push('<summary>Mobile findings</summary>');
      lines.push('');
      lines.push(findings || '_No findings._');
      lines.push('');
      lines.push('</details>');
      lines.push('');
    }

    if (result.desktopData) {
      const findings = extractAllFindings(result.desktopData);
      lines.push('<details>');
      lines.push('<summary>Desktop findings</summary>');
      lines.push('');
      lines.push(findings || '_No findings._');
      lines.push('');
      lines.push('</details>');
      lines.push('');
    }
  }

  // Schema validation
  if (schemaFailures && schemaFailures.length > 0) {
    lines.push('### Schema validation — ' + schemaFailures.length + ' failure(s)');
    for (const f of schemaFailures) {
      if (f.error) {
        lines.push('- **' + f.url + '**: error — ' + f.error);
      } else {
        lines.push('- **' + f.url + '**: missing `' + f.missing.join('`, `') + '`');
        lines.push('  Found: ' + (f.found.length > 0 ? f.found.join(', ') : '(none)'));
      }
    }
    lines.push('');
  } else if (schemaFailures !== null) {
    lines.push('### Schema validation — all passed ✅');
    lines.push('');
  }

  // Site audit
  if (siteAudit) {
    const hasIssues = siteAudit.consoleErrors.length > 0 || siteAudit.failedRequests.length > 0 || siteAudit.brokenLinks.length > 0;
    if (hasIssues) {
      lines.push('### Site audit — issues found');
      if (siteAudit.consoleErrors.length   > 0) lines.push('- Console errors: ' + siteAudit.consoleErrors.length);
      if (siteAudit.failedRequests.length  > 0) lines.push('- Failed requests: ' + siteAudit.failedRequests.length);
      if (siteAudit.brokenLinks.length     > 0) lines.push('- Broken links: ' + siteAudit.brokenLinks.length);
    } else {
      lines.push('### Site audit — no issues ✅');
    }
    lines.push('');
  }

  try {
    appendFileSync(summaryFile, lines.join('\n') + '\n');
    console.log('Written to GitHub Actions job summary.');
  } catch (err) {
    console.error('Failed to write job summary (non-fatal): ' + err.message);
  }
}

// --- Main -------------------------------------------------------------------

async function main() {
  if (!SITE_URL) throw new Error('SITE_URL env var is required');

  console.log('Auditing ' + PAGES.length + ' page(s): ' + PAGES.join(', '));

  // --- First pass: PSI for all pages ---
  const pageResults = [];
  for (let i = 0; i < PAGES.length; i++) {
    const result = await auditPage(PAGES[i]);
    pageResults.push(result);
    logPageResult(result, false);
    // Brief pause between pages to avoid rate limits (skip after last page)
    if (i < PAGES.length - 1) await sleep(5000);
  }
  console.log('');

  // --- Batch retry for pages that failed PSI thresholds ---
  // Flaky lab measurements are common; retry once (waiting 2 min paid once regardless
  // of how many pages failed) before raising an alarm.
  const failingIndices = pageResults
    .map(function(r, i) { return { r, i }; })
    .filter(function({ r }) { return r.failures.length > 0 && !r.psiError; })
    .map(function({ i }) { return i; });

  let psiFlaky = false;
  if (failingIndices.length > 0) {
    console.log(failingIndices.length + ' page(s) below threshold. Waiting 2 minutes before retry to rule out lab noise...');
    await sleep(2 * 60 * 1000);

    for (const idx of failingIndices) {
      const retryResult = await auditPage(PAGES[idx]);
      pageResults[idx] = retryResult;
      logPageResult(retryResult, true);
    }

    const stillFailingCount = failingIndices.filter(function(idx) { return pageResults[idx].failures.length > 0; }).length;
    const recoveredCount = failingIndices.length - stillFailingCount;
    console.log('Retry: ' + recoveredCount + ' recovered (lab noise), ' + stillFailingCount + ' still failing.');
    if (stillFailingCount === 0) {
      psiFlaky = true;
    }
  }

  // --- Schema validation runs before the site audit's link checker makes raw
  // HTTP requests that can trigger Cloudflare bot mitigation on the runner IP ---
  let schemaFailures = null;
  try {
    schemaFailures = await validateSchema();
  } catch (err) {
    console.error('Schema validation error (non-fatal): ' + err.message);
  }

  // --- Playwright site audit (homepage only, always runs) ---
  let siteAudit = null;
  try {
    siteAudit = await runSiteAudit();
  } catch (err) {
    console.error('Site audit error (non-fatal): ' + err.message);
  }

  // --- Write job summary (always, even on passing runs) ---
  writeSummary(pageResults, schemaFailures, siteAudit);

  // --- Determine overall pass/fail ---
  const psiPass = pageResults.every(function(r) { return r.failures.length === 0; });
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
        body: 'All checks recovered on ' + today + ': all ' + PAGES.length + '/' + PAGES.length + ' pages passing, no site audit issues. Closing.',
      });
      await gh('PATCH', '/repos/' + OWNER + '/' + REPO + '/issues/' + openIssue.number, { state: 'closed' });
      console.log('Closed issue #' + openIssue.number);
    }
    return;
  }

  // --- Something failed: get Claude diagnosis ---
  const failingResults = pageResults.filter(function(r) { return r.failures.length > 0 && !r.psiError; });
  const psiErrorResults = pageResults.filter(function(r) { return r.psiError; });
  console.log('Issues confirmed. Calling Claude for diagnosis...');

  let diagnosis = '(No ANTHROPIC_API_KEY set, diagnosis skipped)';
  let patch = null;
  if (ANTHROPIC_API_KEY) {
    const result = await diagnose(failingResults, siteAudit, schemaFailures);
    if (result) {
      diagnosis = result.diagnosis;
      patch = result.patch;
    } else {
      diagnosis = '(Claude diagnosis unavailable -- Anthropic API error. Check workflow logs for details.)';
    }
  }

  // --- Open/update the issue first so we have an issue number for the PR ---
  await ensureLabel();
  const openIssue = await findOpenIssue();
  let issueNumber;

  if (openIssue) {
    issueNumber = openIssue.number;
  } else {
    const passingCount = pageResults.filter(function(r) { return r.failures.length === 0 && !r.psiError; }).length;
    const parts = [];
    if (!psiPass) parts.push(passingCount + '/' + PAGES.length + ' pages passing');
    if (!auditPass) parts.push('audit issues');
    if (!schemaPass) parts.push('schema failures');
    const title = 'Site health regression (' + today + '): ' + parts.join(', ');
    const issue = await gh('POST', '/repos/' + OWNER + '/' + REPO + '/issues', {
      title: title,
      body: buildBody(pageResults, siteAudit, schemaFailures, diagnosis, null),
      labels: [LABEL],
    });
    issueNumber = issue.number;
    console.log('Opened issue #' + issueNumber);
  }

  // --- Attempt auto-fix PR if Claude returned a patch ---
  const fixPr = patch ? await proposeFix(patch, issueNumber) : null;

  // --- Update issue body/comment with PR link if a fix was proposed ---
  const body = buildBody(pageResults, siteAudit, schemaFailures, diagnosis, fixPr);
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
