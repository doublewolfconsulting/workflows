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
 *   ADDITIONAL_CONTEXT  optional
 */

import { execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const required = ['ANTHROPIC_API_KEY', 'PR_NUMBER', 'PR_TITLE', 'HEAD_REF', 'BASE_REF'];
for (const v of required) {
  if (!process.env[v]) { console.error(`Missing env var: ${v}`); process.exit(1); }
}

const { ANTHROPIC_API_KEY, PR_NUMBER, PR_TITLE, HEAD_REF, BASE_REF, ADDITIONAL_CONTEXT = '' } = process.env;

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
- If everything is correct: decision="approve", body="LGTM". You MUST use decision="approve" when your conclusion is that there are no blocking issues. Using decision="request_changes" with a body that says LGTM or no blocking issues found is a violation of these rules.
- If issues found: decision="request_changes", body lists ONLY genuine blocking issues, one per line as: FILE · what is wrong · correct value · source (1-2 sentences max). CRITICAL: Do NOT include an item and then say "not a blocking issue" or "withdrawn" or "no action needed" — that is self-contradictory. If an item is not blocking, omit it from the body entirely before writing it. Never write an item you plan to retract. The body must contain only lines asserting a genuine unresolved problem.
- JSON formatting: use \\n for line breaks in the body string. Never escape single quotes (write ' not \\'). Never include raw newlines inside a JSON string value.
- Do not invent issues that are not in the diff
- The diff shows only what changed in this PR. Lines prefixed with '+' are additions; lines prefixed with '-' are removals. Only flag issues found in '+' lines or unchanged context lines. NEVER flag content from '-' lines as a current problem — removed content is gone. Do not say "may not have been removed" or "confirm if still present" — if you cannot confirm something is in a '+' or context line, do not flag it.
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
    max_tokens: 4096,
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

// Normalize decision/body mismatch: if body signals LGTM but decision is request_changes, correct it.
// Filter out lines the reviewer itself marked as non-blocking/withdrawn — these should not be in the body per prompt rules,
// but the model sometimes includes them anyway. If nothing genuine remains, normalize to approve.
// A line is a genuine blocking issue if it:
// 1. Contains the FILE · ISSUE format (at least one ·)
// 2. Does NOT contain any retraction/resolution signal
// We use broad substring checks to catch all variants of "no issue", "no blocking", etc.
const RETRACTION_SIGNALS = [
  'no issue', 'no blocking', 'no error', 'not blocking', 'not a blocking',
  'not a factual', 'no factual', 'no action needed', 'withdraw', 'resolved',
  'which is correct', 'this is correct', 'is correct', 'clarity issue',
  'minor but', 'minor and not', 'must be verified', 'confirm the final',
  'lgtm', 'internally consistent', 'acceptable', 'is acceptable'
];
// Word-boundary match, not raw substring — a plain .includes('resolved') also matches
// inside "unresolved" (and 'acceptable' inside "unacceptable"), which would misfire on
// a line describing a genuinely UNresolved/unacceptable problem as if it were retracted.
function hasRetractionSignal(text) {
  const l = text.toLowerCase();
  return RETRACTION_SIGNALS.some(sig => {
    const escaped = sig.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`).test(l);
  });
}
const bodyLines = result.body.split('\n');
const genuineIssueLines = bodyLines.filter(line => {
  const l = line.trim().toLowerCase();
  if (!l) return false;
  // Must have file·issue format
  if (!l.includes(' · ')) return false;
  // Must not contain any retraction signal
  return !hasRetractionSignal(l);
});
const bodyLower = result.body.trim().toLowerCase();
const looksLikeApproval = (
  bodyLower.startsWith('lgtm') ||
  bodyLower.startsWith('no blocking issues') ||
  bodyLower.startsWith('no issues') ||
  genuineIssueLines.length === 0
);
if (result.decision === 'request_changes' && looksLikeApproval) {
  console.warn('Decision/body mismatch — no genuine blocking issues found after filtering retractions. Normalizing to approve.');
  result.decision = 'approve';
  result.body = 'LGTM';
}

console.log(`Decision: ${result.decision}`);
console.log(`Body:\n${result.body}`);

// Add visual indicators: ✅ per line for approve. For request_changes, a line only
// gets ❌ if it's a genuine issue — lines the model included anyway despite the prompt
// telling it not to (e.g. "X is correct, no issue") get ✅ instead, using the same
// RETRACTION_SIGNALS check already used above to decide the overall decision. Without
// this, every line in a request_changes body got ❌ regardless of what it said, making
// self-described non-blocking commentary look like failures.
let body = result.body;
if (result.decision === 'approve') {
  body = body.split('\n').map(line => line.trim() ? `✅ ${line}` : line).join('\n');
} else {
  body = body.split('\n').map(line => {
    if (!line.trim()) return line;
    return `${hasRetractionSignal(line) ? '✅' : '❌'} ${line}`;
  }).join('\n');
}

// Write body to a temp file to avoid shell quoting issues with special characters
const bodyFile = join(tmpdir(), `pr-review-${PR_NUMBER}.txt`);
writeFileSync(bodyFile, body, 'utf8');
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
