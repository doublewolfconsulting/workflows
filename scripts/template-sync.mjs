#!/usr/bin/env node
/**
 * Template Sync — agentic loop that keeps a client site in sync with the DW static template
 *
 * Runs monthly via GitHub Actions (caller sets the cron).
 *
 * Claude runs in a multi-turn tool-calling loop. It reads files from both repos,
 * identifies infrastructure improvements to port, applies them, verifies with a
 * build, commits to branches, opens PRs, and creates a findings PR when done.
 *
 * Required env vars:
 *   ANTHROPIC_API_KEY   -- repository secret
 *   GITHUB_TOKEN        -- provided automatically by GitHub Actions
 *   CLIENT_REPO         -- e.g. doublewolfconsulting/mash
 *   CLIENT_DIR          -- absolute path where the client repo is checked out
 *   CLIENT_WORKING_DIR  -- subdirectory where the website lives (empty or '.' for root)
 *   TEMPLATE_DIR        -- absolute path where consulting.doublewolf-static is checked out
 *   TEMPLATE_REPO       -- defaults to doublewolfconsulting/consulting.doublewolf-static
 *
 * Optional env vars:
 *   TEMPLATE_WRITE_TOKEN -- PAT with write access to TEMPLATE_REPO. If not set,
 *                           client-to-template improvements are raised as issues
 *                           instead of PRs in the template repo.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { execSync } from 'child_process';

const ANTHROPIC_API_KEY   = process.env.ANTHROPIC_API_KEY;
const GITHUB_TOKEN        = process.env.GITHUB_TOKEN;
const CLIENT_REPO         = process.env.CLIENT_REPO || '';
const CLIENT_DIR          = process.env.CLIENT_DIR || '';
const CLIENT_WORKING_DIR  = process.env.CLIENT_WORKING_DIR || '.';
const TEMPLATE_DIR        = process.env.TEMPLATE_DIR || '';
const TEMPLATE_REPO       = process.env.TEMPLATE_REPO || 'doublewolfconsulting/consulting.doublewolf-static';
// Optional: PAT with write access to the template repo for bi-directional sync.
// Falls back to GITHUB_TOKEN (which typically lacks cross-repo write access).
const TEMPLATE_WRITE_TOKEN = process.env.TEMPLATE_WRITE_TOKEN || GITHUB_TOKEN;

const [CLIENT_OWNER, CLIENT_REPO_NAME] = CLIENT_REPO.split('/');
const [TEMPLATE_OWNER, TEMPLATE_REPO_NAME] = TEMPLATE_REPO.split('/');
const LABEL = 'template-sync';

const now = new Date();
const MONTH_YEAR = now.toLocaleString('en-AU', { month: 'long', year: 'numeric', timeZone: 'Asia/Singapore' });
const YYYYMM = now.toISOString().slice(0, 7).replace('-', '');

// Normalise CLIENT_WORKING_DIR: treat empty string and '.' the same way
const CLIENT_SITE = (CLIENT_WORKING_DIR && CLIENT_WORKING_DIR !== '.')
  ? join(CLIENT_DIR, CLIENT_WORKING_DIR)
  : CLIENT_DIR;

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

// GitHub API call using a specific token (for template repo write operations)
async function ghWithToken(token, method, path, body) {
  const res = await fetch('https://api.github.com' + path, {
    method,
    headers: {
      'Authorization': 'Bearer ' + token,
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

// --- Path safety helpers -----------------------------------------------------

function isUnderAllowedDir(filePath) {
  const abs = resolve(filePath);
  const clientAbs = resolve(CLIENT_DIR);
  const templateAbs = resolve(TEMPLATE_DIR);
  return abs.startsWith(clientAbs + '/') || abs === clientAbs ||
         abs.startsWith(templateAbs + '/') || abs === templateAbs;
}

function isUnderClientDir(filePath) {
  const abs = resolve(filePath);
  const clientAbs = resolve(CLIENT_DIR);
  return abs.startsWith(clientAbs + '/') || abs === clientAbs;
}

function isUnderTemplateDir(filePath) {
  const abs = resolve(filePath);
  const templateAbs = resolve(TEMPLATE_DIR);
  return abs.startsWith(templateAbs + '/') || abs === templateAbs;
}

// --- Tool definitions --------------------------------------------------------

const tools = [
  {
    name: 'read_file',
    description: 'Read a file from the client or template directory. Returns file content or an error.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file to read.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_directory',
    description: 'List files and directories at a path. Optionally filter by a substring pattern.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the directory to list.' },
        pattern: { type: 'string', description: 'Optional substring to filter entries by name.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file in the client directory only (never the template). Creates parent directories if needed.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file to write (must be under CLIENT_DIR).' },
        content: { type: 'string', description: 'Content to write to the file.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'write_template_file',
    description: 'Write content to a file in the template directory only (for porting client improvements back to the template). Creates parent directories if needed.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file to write (must be under TEMPLATE_DIR).' },
        content: { type: 'string', description: 'Content to write to the file.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'run_build',
    description: 'Run `npm run build` in the client site directory. Returns success status and combined stdout/stderr output.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'git_status',
    description: 'Run `git status --short` in the client directory to see what files have changed.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'git_create_branch',
    description: 'Create a new branch from main in the client repo. Branch name must start with "sync/template-".',
    input_schema: {
      type: 'object',
      properties: {
        branch_name: { type: 'string', description: 'Name for the new branch. Must start with "sync/template-".' },
      },
      required: ['branch_name'],
    },
  },
  {
    name: 'git_commit_and_push',
    description: 'Stage listed files, commit with a message, and push to origin in the client repo.',
    input_schema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'File paths relative to CLIENT_DIR to stage.',
        },
        message: { type: 'string', description: 'Commit message.' },
        branch: { type: 'string', description: 'Branch to push to.' },
      },
      required: ['files', 'message', 'branch'],
    },
  },
  {
    name: 'create_pr',
    description: 'Create a pull request in the client repo.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'PR title.' },
        body: { type: 'string', description: 'PR body (markdown).' },
        head: { type: 'string', description: 'Source branch name.' },
        base: { type: 'string', description: 'Target branch (defaults to "main").' },
      },
      required: ['title', 'body', 'head'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create a GitHub issue. Defaults to the client repo; pass repo to create in a different repo (e.g. the template repo). Use this as a fallback when PR creation fails.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body (markdown).' },
        labels: {
          type: 'array',
          items: { type: 'string' },
          description: 'Labels to apply.',
        },
        repo: {
          type: 'string',
          description: 'Repo in owner/name format. Defaults to CLIENT_REPO.',
        },
      },
      required: ['title', 'body'],
    },
  },
  {
    name: 'git_create_template_branch',
    description: 'Create a new branch in the template repo for porting client improvements back. Branch name must start with "sync/client-".',
    input_schema: {
      type: 'object',
      properties: {
        branch_name: { type: 'string', description: 'Name for the new branch. Must start with "sync/client-".' },
      },
      required: ['branch_name'],
    },
  },
  {
    name: 'git_commit_and_push_template',
    description: 'Stage listed files, commit with a message, and push to the template repo remote.',
    input_schema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'File paths relative to TEMPLATE_DIR to stage.',
        },
        message: { type: 'string', description: 'Commit message.' },
        branch: { type: 'string', description: 'Branch to push to.' },
      },
      required: ['files', 'message', 'branch'],
    },
  },
  {
    name: 'create_template_pr',
    description: 'Create a pull request in the template repo to port an improvement from the client. Falls back to creating an issue if PR creation fails.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'PR title.' },
        body: { type: 'string', description: 'PR body (markdown).' },
        head: { type: 'string', description: 'Source branch name.' },
        base: { type: 'string', description: 'Target branch (defaults to "main").' },
      },
      required: ['title', 'body', 'head'],
    },
    cache_control: { type: 'ephemeral' },
  },
];

// --- Tool execution ----------------------------------------------------------

async function executeTool(name, input) {
  try {
    switch (name) {
      case 'read_file': {
        const { path } = input;
        if (!isUnderAllowedDir(path)) {
          return { error: 'Path is outside CLIENT_DIR and TEMPLATE_DIR: ' + path };
        }
        if (!existsSync(path)) {
          return { error: 'File not found: ' + path };
        }
        try {
          const content = readFileSync(path, 'utf8');
          return { content };
        } catch (err) {
          return { error: 'Could not read file: ' + err.message };
        }
      }

      case 'list_directory': {
        const { path, pattern } = input;
        if (!isUnderAllowedDir(path)) {
          return { error: 'Path is outside CLIENT_DIR and TEMPLATE_DIR: ' + path };
        }
        if (!existsSync(path)) {
          return { error: 'Directory not found: ' + path };
        }
        try {
          let entries = readdirSync(path).map(function(entry) {
            const fullEntry = join(path, entry);
            const isDir = statSync(fullEntry).isDirectory();
            return isDir ? entry + '/' : entry;
          });
          if (pattern) {
            entries = entries.filter(function(e) { return e.includes(pattern); });
          }
          return { entries };
        } catch (err) {
          return { error: 'Could not list directory: ' + err.message };
        }
      }

      case 'write_file': {
        const { path, content } = input;
        if (!isUnderClientDir(path)) {
          return { error: 'write_file may only write to CLIENT_DIR. Path is outside: ' + path };
        }
        try {
          const dir = dirname(path);
          if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
          }
          writeFileSync(path, content, 'utf8');
          return { success: true };
        } catch (err) {
          return { error: 'Could not write file: ' + err.message };
        }
      }

      case 'write_template_file': {
        const { path, content } = input;
        if (!isUnderTemplateDir(path)) {
          return { error: 'write_template_file may only write to TEMPLATE_DIR. Path is outside: ' + path };
        }
        try {
          const dir = dirname(path);
          if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
          }
          writeFileSync(path, content, 'utf8');
          return { success: true };
        } catch (err) {
          return { error: 'Could not write file: ' + err.message };
        }
      }

      case 'run_build': {
        try {
          const output = execSync('npm run build', {
            cwd: CLIENT_SITE,
            timeout: 120000,
            stdio: 'pipe',
            encoding: 'utf8',
          });
          return { success: true, output: output || '(no output)' };
        } catch (err) {
          const output = (err.stdout || '') + (err.stderr || '') || err.message;
          return { success: false, output: output.slice(0, 2000) };
        }
      }

      case 'git_status': {
        try {
          const output = execSync('git status --short', {
            cwd: CLIENT_DIR,
            encoding: 'utf8',
          });
          return { output: output || '(clean)' };
        } catch (err) {
          return { output: err.message };
        }
      }

      case 'git_create_branch': {
        const { branch_name } = input;
        if (!branch_name.startsWith('sync/template-')) {
          return { error: 'branch_name must start with "sync/template-", got: ' + branch_name };
        }
        try {
          execSync(
            'git remote set-url origin https://x-access-token:' + GITHUB_TOKEN + '@github.com/' + CLIENT_REPO + '.git',
            { cwd: CLIENT_DIR }
          );
          execSync('git checkout main', { cwd: CLIENT_DIR });
          execSync('git pull origin main', { cwd: CLIENT_DIR });
          execSync('git checkout -b ' + branch_name, { cwd: CLIENT_DIR });
          return { success: true };
        } catch (err) {
          return { error: err.message };
        }
      }

      case 'git_commit_and_push': {
        const { files, message, branch } = input;
        try {
          execSync(
            'git remote set-url origin https://x-access-token:' + GITHUB_TOKEN + '@github.com/' + CLIENT_REPO + '.git',
            { cwd: CLIENT_DIR }
          );
          for (const file of files) {
            execSync('git add ' + JSON.stringify(file), { cwd: CLIENT_DIR });
          }
          execSync('git commit -m ' + JSON.stringify(message), { cwd: CLIENT_DIR });
          execSync('git push origin ' + branch, { cwd: CLIENT_DIR });
          return { success: true };
        } catch (err) {
          return { error: err.message };
        }
      }

      case 'create_pr': {
        const { title, body, head, base } = input;
        try {
          const pr = await gh('POST', '/repos/' + CLIENT_OWNER + '/' + CLIENT_REPO_NAME + '/pulls', {
            title,
            body,
            head,
            base: base || 'main',
          });
          return { url: pr.html_url, number: pr.number };
        } catch (err) {
          return { error: err.message };
        }
      }

      case 'create_issue': {
        const { title, body, labels = [], repo } = input;
        const targetRepo = repo || CLIENT_REPO;
        const [owner, repoName] = targetRepo.split('/');
        try {
          await ensureLabel(owner, repoName);
          const issue = await gh('POST', '/repos/' + owner + '/' + repoName + '/issues', {
            title,
            body,
            labels: [...new Set([LABEL, ...labels])],
          });
          return { url: issue.html_url, number: issue.number };
        } catch (err) {
          return { error: err.message };
        }
      }

      case 'git_create_template_branch': {
        const { branch_name } = input;
        if (!branch_name.startsWith('sync/client-')) {
          return { error: 'branch_name must start with "sync/client-", got: ' + branch_name };
        }
        try {
          execSync(
            'git remote set-url origin https://x-access-token:' + TEMPLATE_WRITE_TOKEN + '@github.com/' + TEMPLATE_REPO + '.git',
            { cwd: TEMPLATE_DIR }
          );
          execSync('git checkout main', { cwd: TEMPLATE_DIR });
          execSync('git pull origin main', { cwd: TEMPLATE_DIR });
          execSync('git checkout -b ' + branch_name, { cwd: TEMPLATE_DIR });
          return { success: true };
        } catch (err) {
          return { error: err.message };
        }
      }

      case 'git_commit_and_push_template': {
        const { files, message, branch } = input;
        try {
          execSync(
            'git remote set-url origin https://x-access-token:' + TEMPLATE_WRITE_TOKEN + '@github.com/' + TEMPLATE_REPO + '.git',
            { cwd: TEMPLATE_DIR }
          );
          for (const file of files) {
            execSync('git add ' + JSON.stringify(file), { cwd: TEMPLATE_DIR });
          }
          execSync('git commit -m ' + JSON.stringify(message), { cwd: TEMPLATE_DIR });
          execSync('git push origin ' + branch, { cwd: TEMPLATE_DIR });
          return { success: true };
        } catch (err) {
          return { error: err.message };
        }
      }

      case 'create_template_pr': {
        const { title, body, head, base } = input;
        try {
          const pr = await ghWithToken(
            TEMPLATE_WRITE_TOKEN,
            'POST',
            '/repos/' + TEMPLATE_OWNER + '/' + TEMPLATE_REPO_NAME + '/pulls',
            { title, body, head, base: base || 'main' }
          );
          return { url: pr.html_url, number: pr.number };
        } catch (err) {
          // Fall back to creating an issue in the template repo
          console.warn('create_template_pr failed (' + err.message + '), falling back to issue');
          try {
            await ensureLabel(TEMPLATE_OWNER, TEMPLATE_REPO_NAME);
            const issue = await gh('POST', '/repos/' + TEMPLATE_OWNER + '/' + TEMPLATE_REPO_NAME + '/issues', {
              title,
              body: '> Note: PR creation failed (likely missing TEMPLATE_WRITE_TOKEN). This is a tracking issue instead.\n\n' + body,
              labels: [LABEL],
            });
            return { url: issue.html_url, number: issue.number, type: 'issue_fallback' };
          } catch (issueErr) {
            return { error: 'PR creation failed: ' + err.message + '. Issue fallback also failed: ' + issueErr.message };
          }
        }
      }

      default:
        return { error: 'Unknown tool: ' + name };
    }
  } catch (err) {
    return { error: 'Tool execution error: ' + err.message };
  }
}

// --- Claude API call ---------------------------------------------------------

async function callClaude(messages, toolDefs, systemPrompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 16000,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      tools: toolDefs,
      messages,
    }),
  });

  if (!res.ok) {
    throw new Error('Anthropic API error ' + res.status + ': ' + await res.text());
  }

  return res.json();
}

// --- System prompt -----------------------------------------------------------

function buildSystemPrompt() {
  return [
    'You are a template sync agent for Double Wolf Consulting. Your job is to keep client websites in sync with the upstream DW static template by porting infrastructure improvements.',
    '',
    'WHAT TO PORT (shared infrastructure only):',
    '- Bug fixes and safety guards in scripts/build.js (null checks, filter(Boolean), length guards)',
    '- Generator function improvements in scripts/build.js that do not depend on client-specific content',
    '- New CSS utilities in styles/input.css that are generally useful',
    '- Test improvements in scripts/site-test.mjs',
    '- Improvements to scripts/main.js that apply to all sites (not client-specific UI)',
    '',
    'WHAT NOT TO TOUCH:',
    '- Client-specific config (site.config.js values, brand colours, copy, page names)',
    '- Client-specific HTML content or layout',
    '- Client-specific CSS variables (colours, fonts)',
    '- Anything that exists in the client but not the template (the client may be ahead of the template)',
    '- Workflows, deployment config, secrets',
    '',
    'HOW TO WORK:',
    '1. Start by reading the key files from both repos: scripts/build.js, scripts/main.js, scripts/site-test.mjs, styles/input.css',
    '2. Compare them carefully and identify specific improvements to port',
    '3. For each improvement, make the minimal targeted change',
    '4. After each file change, run the build to verify',
    '5. If the build fails, revert the change (write_file back to original) and note it as manual',
    '6. Group related changes into logical commits and PRs (one PR per theme, e.g. "fix: null-safety guards in build.js")',
    '7. For each PR you create in the client repo, include a retainer time estimate at the end of the PR body.',
    '   Format: `**Retainer:** X.Xh`.',
    '   Base the estimate on the complexity of the changes:',
    '     - minor guard/null-fix = 0.25h',
    '     - moderate function improvement = 0.5h',
    '     - significant new feature or multi-file change = 1-2h',
    '   Be consistent and conservative.',
    '8. When done with client-side changes, assess whether any improvements found in the client should be ported back to the template.',
    '   If yes, use write_template_file, git_create_template_branch, git_commit_and_push_template, and create_template_pr.',
    '   Branch names in the template repo must start with sync/client-.',
    '   After changing template files, note in the PR body that the caller must run `npm run build` in the template repo to verify (you cannot run builds in the template repo during this workflow run).',
    '9. When all auto-applicable changes are done, create a single findings PR in the client repo titled "chore: template sync findings -- ' + MONTH_YEAR + '".',
    '   This PR has NO code changes (open it from main). Its body must include:',
    '   - What was auto-applied (with links to the individual PRs)',
    '   - What was skipped and why (changes that could not be auto-applied)',
    '   - What needs manual review in a future session',
    '   - Any client improvements ported back to the template (with PR/issue links)',
    '   This PR can be merged immediately (empty diff) or used as a discussion thread.',
    '   Only fall back to creating an issue if PR creation itself fails.',
    '',
    'COMMIT AND PR RULES:',
    '- Branch names in the client repo must start with sync/template-',
    '- Branch names in the template repo must start with sync/client-',
    '- Commit format: type: description (e.g. fix: add filter(Boolean) to sameAs arrays)',
    '- No em dashes anywhere in commit messages, PR titles, or PR bodies',
    '- No "Co-Authored-By: Claude" or any AI attribution in commits or PRs',
    '- PR titles should be short and descriptive',
    '',
    'Context:',
    '- CLIENT_DIR: ' + CLIENT_DIR,
    '- CLIENT_SITE (website root): ' + CLIENT_SITE,
    '- TEMPLATE_DIR: ' + TEMPLATE_DIR,
    '- CLIENT_REPO: ' + CLIENT_REPO,
    '- TEMPLATE_REPO: ' + TEMPLATE_REPO,
    '- YYYYMM (for branch names): ' + YYYYMM,
    '- TEMPLATE_WRITE_TOKEN available: ' + (process.env.TEMPLATE_WRITE_TOKEN ? 'yes' : 'no (will fall back to issue for template repo PRs)'),
  ].join('\n');
}

// --- Initial message ---------------------------------------------------------

function buildInitialMessage() {
  return [
    'Compare the DW static template at ' + TEMPLATE_DIR + ' against the client site at ' + CLIENT_SITE + '.',
    '',
    'Template repo: ' + TEMPLATE_REPO,
    'Client repo: ' + CLIENT_REPO,
    '',
    'Start by reading these files from both locations:',
    '- scripts/build.js',
    '- scripts/main.js',
    '- scripts/site-test.mjs',
    '- styles/input.css',
    '',
    'Then analyse the differences and port infrastructure improvements from the template to the client.',
    'Create individual PRs for each logical group of auto-applied changes.',
    'If you find improvements in the client that should go back to the template, create PRs in the template repo using git_create_template_branch, write_template_file, git_commit_and_push_template, and create_template_pr.',
    'When done, create a single findings PR in the client repo (no code changes) summarising everything.',
  ].join('\n');
}

// --- Agent loop --------------------------------------------------------------

async function runSyncAgent() {
  const systemPrompt = buildSystemPrompt();
  const initialMessage = buildInitialMessage();

  const messages = [{ role: 'user', content: initialMessage }];
  const MAX_TURNS = 50;
  let turn = 0;

  while (turn < MAX_TURNS) {
    turn++;
    console.log('--- Turn ' + turn + ' ---');

    const response = await callClaude(messages, tools, systemPrompt);

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') {
      console.log('Agent completed.');
      break;
    }

    if (response.stop_reason === 'tool_use') {
      const toolResults = [];
      for (const block of response.content) {
        if (block.type === 'tool_use') {
          const inputPreview = JSON.stringify(block.input).slice(0, 100);
          console.log('Tool call: ' + block.name + ' ' + inputPreview);
          const result = await executeTool(block.name, block.input);
          if (result.error) {
            console.warn('Tool error (' + block.name + '): ' + result.error);
          }
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(result),
          });
        }
      }
      // After turn 1 (the initial file reads), mark the last tool result as a
      // cache breakpoint. Turns 2-50 will read the large file contents from
      // cache at 0.1x input cost instead of re-billing them at full rate.
      if (turn === 1 && toolResults.length > 0) {
        toolResults[toolResults.length - 1].cache_control = { type: 'ephemeral' };
      }
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    // max_tokens: response was truncated mid-generation — push it and continue
    // so Claude can resume from where it left off.
    if (response.stop_reason === 'max_tokens') {
      console.warn('max_tokens hit on turn ' + turn + ' — continuing so Claude can resume.');
      messages.push({ role: 'user', content: [{ type: 'text', text: 'Your previous response was cut off due to length. Please continue from where you left off.' }] });
      continue;
    }

    // Unexpected stop reason
    console.warn('Unexpected stop_reason: ' + response.stop_reason);
    break;
  }

  if (turn >= MAX_TURNS) {
    console.error('Agent reached turn limit (' + MAX_TURNS + ') without completing.');
    try {
      const [owner, repoName] = CLIENT_REPO.split('/');
      await ensureLabel(owner, repoName);
      await gh('POST', '/repos/' + owner + '/' + repoName + '/issues', {
        title: 'Template sync: ' + MONTH_YEAR + ' (incomplete)',
        body: [
          'The template sync agent reached the turn limit (' + MAX_TURNS + ' turns) without completing.',
          '',
          'Check the GitHub Actions run logs for details on how far it got.',
          '',
          'Run date: ' + new Date().toISOString().split('T')[0],
        ].join('\n'),
        labels: [LABEL],
      });
    } catch (err) {
      console.error('Could not create turn-limit issue: ' + err.message);
    }
  }
}

// --- Main -------------------------------------------------------------------

async function main() {
  if (!CLIENT_REPO)  throw new Error('CLIENT_REPO env var is required');
  if (!CLIENT_DIR)   throw new Error('CLIENT_DIR env var is required');
  if (!TEMPLATE_DIR) throw new Error('TEMPLATE_DIR env var is required');

  console.log('Template sync (agentic) -- ' + MONTH_YEAR);
  console.log('Client repo:  ' + CLIENT_REPO);
  console.log('Client site:  ' + CLIENT_SITE);
  console.log('Template dir: ' + TEMPLATE_DIR);
  console.log('TEMPLATE_WRITE_TOKEN: ' + (process.env.TEMPLATE_WRITE_TOKEN ? 'set' : 'not set (template PRs will fall back to issues)'));
  console.log('');

  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is required for agentic template sync');
  }

  await runSyncAgent();

  console.log('');
  console.log('Template sync complete.');
}

main().catch(function(err) {
  console.error(err);
  process.exit(1);
});
