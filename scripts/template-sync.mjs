#!/usr/bin/env node
/**
 * Template Sync — compare a client site against the DW static template
 *
 * Runs monthly via GitHub Actions (caller sets the cron).
 *
 * 1. Reads shared infrastructure files from both the client site and template
 * 2. Calls Claude to produce a structured gap analysis
 * 3. Auto-applies high-confidence mechanical changes and creates PRs
 * 4. Opens a GitHub issue in the client repo with the full sync report
 * 5. If any high-priority improvements flow from client → template, opens an
 *    issue in the template repo too
 *
 * Required env vars:
 *   ANTHROPIC_API_KEY   -- repository secret
 *   GITHUB_TOKEN        -- provided automatically by GitHub Actions
 *   CLIENT_REPO         -- e.g. doublewolfconsulting/mash
 *   CLIENT_DIR          -- absolute path where the client repo is checked out
 *   CLIENT_WORKING_DIR  -- subdirectory where the website lives (empty or '.' for root)
 *   TEMPLATE_DIR        -- absolute path where consulting.doublewolf-static is checked out
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GITHUB_TOKEN      = process.env.GITHUB_TOKEN;
const CLIENT_REPO       = process.env.CLIENT_REPO || '';
const CLIENT_DIR        = process.env.CLIENT_DIR || '';
const CLIENT_WORKING_DIR = process.env.CLIENT_WORKING_DIR || '.';
const TEMPLATE_DIR      = process.env.TEMPLATE_DIR || '';

const [CLIENT_OWNER, CLIENT_REPO_NAME] = CLIENT_REPO.split('/');
const TEMPLATE_REPO = 'doublewolfconsulting/consulting.doublewolf-static';
const LABEL = 'template-sync';

const now = new Date();
const MONTH_YEAR = now.toLocaleString('en-AU', { month: 'long', year: 'numeric', timeZone: 'Asia/Singapore' });
const YYYYMM = now.toISOString().slice(0, 7).replace('-', '');

// Normalise CLIENT_WORKING_DIR: treat empty string and '.' the same way
const CLIENT_SITE = (CLIENT_WORKING_DIR && CLIENT_WORKING_DIR !== '.')
  ? join(CLIENT_DIR, CLIENT_WORKING_DIR)
  : CLIENT_DIR;

// Files to compare between template and client
const SHARED_FILES = [
  'scripts/build.js',
  'scripts/site-test.mjs',
  'scripts/main.js',
  'styles/input.css',
];

// --- GitHub API helper -------------------------------------------------------

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
  if (!res.ok) throw new Error('GitHub API ' + method + ' ' + path + ' => ' + res.status + ': ' + await res.text());
  if (res.status === 204) return null;
  return res.json();
}

// --- File reading ------------------------------------------------------------

function readFile(dir, relPath) {
  const fullPath = join(dir, relPath);
  if (!existsSync(fullPath)) return null;
  try {
    return readFileSync(fullPath, 'utf8');
  } catch {
    return null;
  }
}

// --- Claude gap analysis -----------------------------------------------------

async function analyseWithClaude(templateFiles, clientFiles) {
  const sections = [
    'You are an expert JavaScript developer reviewing two codebases: an upstream template and a client site forked from it.',
    'Compare the shared infrastructure files below and return a JSON object describing the sync state.',
    '',
    'Rules:',
    '- Focus ONLY on shared infrastructure: build pipeline logic, test assertions, CSS utilities, JS guards and helpers.',
    '- Do NOT flag differences in client-specific content: brand colours, config values, page names, company-specific sections.',
    '- For templateToClient items: only include changes where the template clearly has a bug fix or improvement the client should receive.',
    '- Do NOT include items that conflict with documented client-specific customisations (e.g. Mash has a second font, generateHowWeWorkHTML, guarded booking URL test).',
    '- For oldString/newString: the oldString must be an exact, unique substring of the target file. Include enough surrounding lines to guarantee uniqueness, but not an entire function if avoidable.',
    '- If a change is too complex or ambiguous to express as a single string replacement, set canAutoApply: false and omit oldString/newString.',
    '- Prioritise correctness over completeness. If uncertain, set canAutoApply: false.',
    '',
    'Return ONLY a raw JSON object (no markdown fences, no explanation). Shape:',
    '{',
    '  "summary": "one paragraph describing overall sync state",',
    '  "templateToClient": [',
    '    {',
    '      "priority": "high|medium|low",',
    '      "type": "bug_fix|feature|config|docs",',
    '      "file": "scripts/build.js",',
    '      "description": "human-readable description",',
    '      "pr_title": "fix: short title",',
    '      "oldString": "exact string to find (omit if canAutoApply is false)",',
    '      "newString": "replacement string (omit if canAutoApply is false)",',
    '      "canAutoApply": true',
    '    }',
    '  ],',
    '  "clientToTemplate": [',
    '    {',
    '      "priority": "high|medium|low",',
    '      "file": "scripts/build.js",',
    '      "description": "what the client has that the template should get",',
    '      "recommendation": "one sentence on what to do"',
    '    }',
    '  ]',
    '}',
    '',
  ];

  sections.push('=== TEMPLATE FILES ===');
  for (const [relPath, content] of Object.entries(templateFiles)) {
    sections.push('--- template/' + relPath + ' ---');
    sections.push(content !== null ? content : '(file does not exist in template)');
    sections.push('');
  }

  sections.push('=== CLIENT FILES ===');
  for (const [relPath, content] of Object.entries(clientFiles)) {
    sections.push('--- client/' + relPath + ' ---');
    sections.push(content !== null ? content : '(file does not exist in client)');
    sections.push('');
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [{ role: 'user', content: sections.join('\n') }],
    }),
  });

  if (!res.ok) {
    throw new Error('Anthropic API error ' + res.status + ': ' + await res.text());
  }

  const data = await res.json();
  const text = data.content[0].text.trim();

  // Strip any accidental markdown fences
  const cleaned = text.replace(/^```json\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(cleaned);
}

// --- Label management --------------------------------------------------------

async function ensureLabel(owner, repo) {
  const existing = await gh('GET', '/repos/' + owner + '/' + repo + '/labels/' + encodeURIComponent(LABEL));
  if (!existing) {
    await gh('POST', '/repos/' + owner + '/' + repo + '/labels', {
      name: LABEL,
      color: '0075ca',
      description: 'Monthly template sync report',
    });
    console.log('Created label "' + LABEL + '" in ' + owner + '/' + repo);
  }
}

// --- Auto-apply a single change and create a PR ------------------------------

async function applyAndCreatePR(item, index) {
  const relPath = item.file;
  const fullPath = join(CLIENT_SITE, relPath);

  if (!existsSync(fullPath)) {
    console.warn('Auto-apply skip: file not found: ' + relPath);
    return { applied: false, reason: 'File not found in client site: ' + relPath };
  }

  let content;
  try {
    content = readFileSync(fullPath, 'utf8');
  } catch (err) {
    return { applied: false, reason: 'Could not read file: ' + err.message };
  }

  // Count occurrences to ensure uniqueness
  const occurrences = content.split(item.oldString).length - 1;
  if (occurrences === 0) {
    console.warn('Auto-apply skip: search string not found in ' + relPath);
    return { applied: false, reason: 'Search string not found in ' + relPath };
  }
  if (occurrences > 1) {
    console.warn('Auto-apply skip: search string matches ' + occurrences + ' times in ' + relPath + ' (not unique)');
    return { applied: false, reason: 'Search string is not unique in ' + relPath + ' (' + occurrences + ' matches)' };
  }

  const branch = 'sync/template-' + YYYYMM + '-' + index;
  const token = process.env.GITHUB_TOKEN;

  try {
    // Configure remote with token so pushes work inside Actions
    execSync(
      'git remote set-url origin https://x-access-token:' + token + '@github.com/' + CLIENT_REPO + '.git',
      { cwd: CLIENT_DIR }
    );
    execSync('git fetch origin main', { cwd: CLIENT_DIR });
    execSync('git checkout -B ' + branch + ' origin/main', { cwd: CLIENT_DIR });

    // Apply the replacement
    const updated = content.replace(item.oldString, item.newString);
    writeFileSync(fullPath, updated, 'utf8');

    // Verify the build still passes
    try {
      execSync('npm run build', { cwd: CLIENT_SITE, timeout: 120000, stdio: 'pipe' });
    } catch (buildErr) {
      // Revert the file and report failure
      writeFileSync(fullPath, content, 'utf8');
      execSync('git checkout -- ' + relPath, { cwd: CLIENT_DIR });
      console.warn('Auto-apply: build failed for ' + relPath + ': ' + buildErr.message.slice(0, 200));
      return { applied: false, reason: 'Build failed after applying change: ' + buildErr.message.slice(0, 200) };
    }

    // Commit and push
    const commitRelPath = CLIENT_WORKING_DIR && CLIENT_WORKING_DIR !== '.'
      ? CLIENT_WORKING_DIR + '/' + relPath
      : relPath;
    execSync('git add ' + commitRelPath, { cwd: CLIENT_DIR });
    execSync(
      'git commit -m "' + item.pr_title + '"',
      { cwd: CLIENT_DIR }
    );
    execSync('git push --force origin ' + branch, { cwd: CLIENT_DIR });

    // Create the PR
    const pr = await gh('POST', '/repos/' + CLIENT_OWNER + '/' + CLIENT_REPO_NAME + '/pulls', {
      title: item.pr_title,
      body: [
        '**Template sync auto-PR** — ' + MONTH_YEAR,
        '',
        '**File:** `' + relPath + '`',
        '',
        item.description,
        '',
        'Generated by the monthly template sync workflow. Review before merging.',
      ].join('\n'),
      head: branch,
      base: 'main',
    });

    console.log('Created PR #' + pr.number + ' for ' + relPath + ' (' + branch + ')');
    return { applied: true, pr };

  } catch (err) {
    console.error('Auto-apply error for ' + relPath + ': ' + err.message);
    // Try to clean up
    try { execSync('git checkout -- .', { cwd: CLIENT_DIR }); } catch {}
    try { execSync('git checkout main', { cwd: CLIENT_DIR }); } catch {}
    return { applied: false, reason: 'Unexpected error: ' + err.message };
  }
}

// --- Build issue body --------------------------------------------------------

function buildIssueBody(analysis, appliedPRs, skippedItems) {
  const lines = [];

  lines.push('## Summary');
  lines.push('');
  lines.push(analysis.summary);
  lines.push('');

  // Applied PRs
  lines.push('## Applied automatically');
  lines.push('');
  if (appliedPRs.length === 0) {
    lines.push('None.');
  } else {
    for (const { item, pr } of appliedPRs) {
      lines.push('- **' + item.file + '**: ' + item.description);
      lines.push('  PR: ' + pr.html_url);
    }
  }
  lines.push('');

  // Items that need manual review (templateToClient where canAutoApply is false or was skipped)
  const manualItems = [
    ...(analysis.templateToClient || [])
      .filter(function(i) { return !i.canAutoApply; })
      .map(function(i) { return { item: i, reason: 'Marked as manual (complex change)' }; }),
    ...skippedItems,
  ];

  lines.push('## Requires manual review');
  lines.push('');
  if (manualItems.length === 0) {
    lines.push('None.');
  } else {
    for (const { item, reason } of manualItems) {
      lines.push('### `' + item.file + '` (' + (item.priority || 'unknown') + ' priority)');
      lines.push('');
      lines.push(item.description);
      lines.push('');
      lines.push('**Why manual:** ' + reason);
      lines.push('');
    }
  }

  // Port back to template
  lines.push('## Port back to template');
  lines.push('');
  const portBack = analysis.clientToTemplate || [];
  if (portBack.length === 0) {
    lines.push('No improvements identified for porting back.');
  } else {
    for (const item of portBack) {
      lines.push('### `' + item.file + '` (' + item.priority + ' priority)');
      lines.push('');
      lines.push(item.description);
      lines.push('');
      lines.push('**Recommendation:** ' + item.recommendation);
      lines.push('');
    }
  }

  lines.push('---');
  lines.push('');
  lines.push('Run date: ' + new Date().toISOString().split('T')[0]);

  return lines.join('\n');
}

// --- Main -------------------------------------------------------------------

async function main() {
  if (!CLIENT_REPO)  throw new Error('CLIENT_REPO env var is required');
  if (!CLIENT_DIR)   throw new Error('CLIENT_DIR env var is required');
  if (!TEMPLATE_DIR) throw new Error('TEMPLATE_DIR env var is required');

  console.log('Template sync — ' + MONTH_YEAR);
  console.log('Client repo:  ' + CLIENT_REPO);
  console.log('Client site:  ' + CLIENT_SITE);
  console.log('Template dir: ' + TEMPLATE_DIR);
  console.log('');

  // Step 1: Read files from both repos
  const templateFiles = {};
  const clientFiles   = {};

  for (const relPath of SHARED_FILES) {
    templateFiles[relPath] = readFile(TEMPLATE_DIR, relPath);
    clientFiles[relPath]   = readFile(CLIENT_SITE, relPath);

    const tStatus = templateFiles[relPath] !== null ? 'present' : 'absent';
    const cStatus = clientFiles[relPath]   !== null ? 'present' : 'absent';
    console.log(relPath + ': template=' + tStatus + ', client=' + cStatus);
  }
  console.log('');

  // Step 2: Claude analysis
  let analysis;
  if (!ANTHROPIC_API_KEY) {
    console.warn('ANTHROPIC_API_KEY not set, skipping Claude analysis');
    analysis = {
      summary: '(Claude analysis skipped: ANTHROPIC_API_KEY not set)',
      templateToClient: [],
      clientToTemplate: [],
    };
  } else {
    console.log('Calling Claude for gap analysis...');
    try {
      analysis = await analyseWithClaude(templateFiles, clientFiles);
      console.log(
        'Analysis complete: ' +
        (analysis.templateToClient || []).length + ' template-to-client items, ' +
        (analysis.clientToTemplate || []).length + ' client-to-template items'
      );
    } catch (err) {
      console.error('Claude analysis failed: ' + err.message);
      analysis = {
        summary: '(Claude analysis failed: ' + err.message + ')',
        templateToClient: [],
        clientToTemplate: [],
      };
    }
  }
  console.log('');

  // Step 3: Auto-apply high-confidence changes
  const appliedPRs  = [];
  const skippedItems = [];
  const autoItems = (analysis.templateToClient || []).filter(function(i) { return i.canAutoApply; });

  if (autoItems.length > 0) {
    console.log('Auto-applying ' + autoItems.length + ' change(s)...');
  }

  for (let i = 0; i < autoItems.length; i++) {
    const item = autoItems[i];
    console.log('  [' + (i + 1) + '/' + autoItems.length + '] ' + item.file + ': ' + item.description.slice(0, 80));
    const result = await applyAndCreatePR(item, i + 1);
    if (result.applied) {
      appliedPRs.push({ item, pr: result.pr });
    } else {
      skippedItems.push({ item, reason: result.reason });
    }
  }

  if (autoItems.length > 0) {
    console.log('Auto-apply: ' + appliedPRs.length + ' applied, ' + skippedItems.length + ' skipped');
    console.log('');
  }

  // Step 4: Create issue in client repo
  await ensureLabel(CLIENT_OWNER, CLIENT_REPO_NAME);

  const issueTitle = 'Template sync: ' + MONTH_YEAR;
  const issueBody  = buildIssueBody(analysis, appliedPRs, skippedItems);

  const issue = await gh('POST', '/repos/' + CLIENT_OWNER + '/' + CLIENT_REPO_NAME + '/issues', {
    title: issueTitle,
    body: issueBody,
    labels: [LABEL],
  });
  console.log('Created issue #' + issue.number + ' in ' + CLIENT_REPO + ': ' + issue.html_url);

  // Step 5: If high-priority port-back items exist, open an issue in the template repo
  const highPriorityPortBack = (analysis.clientToTemplate || []).filter(function(i) {
    return i.priority === 'high';
  });

  if (highPriorityPortBack.length > 0) {
    const [TEMPLATE_OWNER, TEMPLATE_REPO_NAME] = TEMPLATE_REPO.split('/');
    try {
      await ensureLabel(TEMPLATE_OWNER, TEMPLATE_REPO_NAME);

      const templateIssueLines = [
        'The monthly template sync identified improvements in `' + CLIENT_REPO + '` that should be ported back to this template.',
        '',
        'Source issue: ' + issue.html_url,
        '',
        '## High-priority items',
        '',
      ];
      for (const item of highPriorityPortBack) {
        templateIssueLines.push('### `' + item.file + '`');
        templateIssueLines.push('');
        templateIssueLines.push(item.description);
        templateIssueLines.push('');
        templateIssueLines.push('**Recommendation:** ' + item.recommendation);
        templateIssueLines.push('');
      }
      templateIssueLines.push('---');
      templateIssueLines.push('Run date: ' + new Date().toISOString().split('T')[0]);

      const templateIssue = await gh('POST', '/repos/' + TEMPLATE_OWNER + '/' + TEMPLATE_REPO_NAME + '/issues', {
        title: 'Template sync: improvements from ' + CLIENT_REPO + ' — ' + MONTH_YEAR,
        body: templateIssueLines.join('\n'),
        labels: [LABEL],
      });
      console.log('Created template issue #' + templateIssue.number + ': ' + templateIssue.html_url);
    } catch (err) {
      console.error('Could not create template repo issue (non-fatal): ' + err.message);
    }
  }

  console.log('');
  console.log('Template sync complete.');
}

main().catch(function(err) {
  console.error(err);
  process.exit(1);
});
