#!/usr/bin/env node
/**
 * PR Review — single Anthropic API call via fetch, no agentic loop.
 *
 * Usage: node scripts/pr-review.mjs
 * Env:
 *   ANTHROPIC_API_KEY   required
 *   PR_NUMBER           required
 *   PR_TITLE            required
 *   HEAD_REF            required
 *   BASE_REF            required
 *   OWNER_HANDLE        required
 *   ADDITIONAL_CONTEXT  optional
 */

import { execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const required = ['ANTHROPIC_API_KEY', 'PR_NUMBER', 'PR_TITLE', 'HEAD_REF', 'BASE_REF', 'OWNER_HANDLE'];
for (const v of required) {
  if (!process.env[v]) { console.error(`Missing env var: ${v}`); process.exit(1); }
}

const { ANTHROPIC_API_KEY, PR_NUMBER, PR_TITLE, HEAD_REF, BASE_REF, OWNER_HANDLE, ADDITIONAL_CONTEXT = '' } = process.env;

console.log(`Reviewing PR #${PR_NUMBER}: ${PR_TITLE}`);

// Get the diff
let diff;
try {
  diff = execSync(`gh pr diff ${PR_NUMBER} --patch`, { maxBuffer: 10 * 1024 * 1024 }).toString();
} catch (err) {
  console.error('Failed to get PR diff:', err.message);
  process.exit(1);
}

if (!diff.trim()) {
  console.log('Empty diff — approving.');
  execSync(`gh pr review ${PR_NUMBER} --approve --body "LGTM — no changes detected."`, { stdio: 'inherit' });
  process.exit(0);
}

const contextBlock = ADDITIONAL_CONTEXT.trim()
  ? `## Repo ground truth\n\n${ADDITIONAL_CONTEXT.trim()}\n\n`
  : '';

const prompt = `You are a precise code and documentation reviewer.

PR #${PR_NUMBER}: \`${HEAD_REF}\` → \`${BASE_REF}\`
Title: ${PR_TITLE}

${contextBlock}## Diff

\`\`\`diff
${diff}
\`\`\`

## Instructions

Review the diff against the repo ground truth. Check for:
- Factual errors (wrong numbers, wrong names, wrong paths, wrong schedules)
- Typos or stale references
- Code correctness or standard violations

OUTPUT RULES — these are strict:
- Your ENTIRE response must be ONLY a single JSON object. No preamble, no explanation, no markdown fences.
- Shape: {"decision":"approve","body":"text"} or {"decision":"request_changes","body":"text"}
- If everything is correct: decision="approve", body="LGTM"
- If issues found: decision="request_changes", body lists each as: FILE · LINE · what is wrong · correct value · source
- Tag ${OWNER_HANDLE} in body ONLY for genuine business/scope decisions that cannot be resolved from the docs
- Do not invent issues that are not in the diff
- The diff shows only what changed in this PR — facts already present in the file from prior commits are NOT in the diff but are still present in the final file state. Do not flag "missing" content unless you can confirm it was removed in this diff.
- prohibited_patterns in pr-checks.yml use grep -iE (case-insensitive) and are scoped to docs/ files only (doc_path_filter default). CLAUDE.md and root files are never scanned. Unqualified patterns for invented field names are intentional — any mention in docs/ is suspicious by design.`;

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
    messages: [{ role: 'user', content: prompt }],
  }),
});

if (!res.ok) {
  const err = await res.text();
  console.error('Anthropic API error:', res.status, err);
  process.exit(1);
}

const data = await res.json();
const text = data.content[0].text.trim();

// Parse JSON — try direct parse first, then extract the first {...} block as fallback
function extractJson(str) {
  try { return JSON.parse(str); } catch {}
  const start = str.indexOf('{');
  const end = str.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(str.slice(start, end + 1)); } catch {}
  }
  return null;
}

const result = extractJson(text);
if (!result || !result.decision || !result.body) {
  console.error('Failed to parse Claude response as JSON:', text);
  process.exit(1);
}

console.log(`Decision: ${result.decision}`);
console.log(`Body:\n${result.body}`);

// Write body to a temp file to avoid shell quoting issues with special characters
const bodyFile = join(tmpdir(), `pr-review-${PR_NUMBER}.txt`);
writeFileSync(bodyFile, result.body, 'utf8');
try {
  const flag = result.decision === 'approve' ? '--approve' : '--request-changes';
  execSync(`gh pr review ${PR_NUMBER} ${flag} --body-file ${JSON.stringify(bodyFile)}`, { stdio: 'inherit' });
  console.log('Review posted.');
} finally {
  try { unlinkSync(bodyFile); } catch {}
}

// Fail the status check when changes are requested so it blocks the merge.
if (result.decision !== 'approve') {
  console.error('Changes requested — failing check.');
  process.exit(1);
}
