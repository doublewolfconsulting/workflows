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

## Task

Review the diff against the repo ground truth. Check for:
- Factual errors (wrong numbers, wrong names, wrong paths, wrong schedules)
- Typos or stale references
- Code correctness or standard violations

Respond with a JSON object (no markdown fences) in exactly this shape:
{"decision":"approve","body":"review text"}

Rules:
- If everything is correct: decision="approve", body="LGTM"
- If there are issues: decision="request_changes", body lists each finding:
  FILE · LINE · what is wrong · correct value · which source confirms it
- Tag ${OWNER_HANDLE} in body ONLY for genuine business/scope decisions
- Do not invent issues that are not in the diff`;

const res = await fetch('https://api.anthropic.com/v1/messages', {
  method: 'POST',
  headers: {
    'x-api-key': ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  },
  body: JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
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

let result;
try {
  result = JSON.parse(text);
} catch {
  console.error('Failed to parse Claude response as JSON:', text);
  process.exit(1);
}

const { decision, body } = result;
if (!decision || !body) {
  console.error('Unexpected response shape:', result);
  process.exit(1);
}

console.log(`Decision: ${decision}`);
console.log(`Body:\n${body}`);

const flag = decision === 'approve' ? '--approve' : '--request-changes';
execSync(`gh pr review ${PR_NUMBER} ${flag} --body ${JSON.stringify(body)}`, { stdio: 'inherit' });
console.log('Review posted.');
