# Workflows Repo — Claude Context

This repo (`doublewolfconsulting/workflows`) hosts reusable GitHub Actions workflows
and shared scripts. The primary consumer is `doublewolfconsulting/consulting.doublewolf-static`.

## Architecture

- `.github/workflows/site-test.yml` — reusable workflow (`workflow_call`) that:
  1. Checks out the caller's repo + this workflows repo into `_wf/`
  2. Installs dependencies for both
  3. Installs Playwright + system deps
  4. Builds the caller's site (`npm run build`)
  5. Serves `dist/` on port 3000 via `_wf/node_modules/.bin/serve`
  6. Runs `node scripts/site-test.mjs` from the **caller's** repo
     (`NODE_PATH=_wf/node_modules` makes Playwright available)

- `scripts/` — shared scripts (PSI monitor, Google Doc sync, etc.)

## Pending tasks

None.

## Recently completed

### Auto Review reusable workflow (feat/auto-review-reusable, 2026-07-18)

Added `.github/workflows/auto-review.yml` — a reusable `workflow_call` workflow that runs Claude Code as an automated PR reviewer. Uses `CLAUDE_CODE_OAUTH_TOKEN` (Max subscription, not API-billed). Callers control path triggers and pass `additional_context` to inject repo-specific ground-truth facts into the review prompt.

### PR Checks reusable workflow (feat/pr-checks-reusable, 2026-07-18)

Added `.github/workflows/pr-checks.yml` — a reusable `workflow_call` workflow with three parallel jobs:

1. **PR body** (`pr-body`): validates required sections (configurable, default `## Summary,## Test plan`), minimum body length (50 chars), and absence of AI/Claude attribution phrases
2. **Branch name** (`branch-name`): validates branch matches a configurable ERE pattern (default `^(feature|feat|fix|docs|chore|refactor|test)/`); long-lived branches (`main`, `development`, `staging`) are always skipped
3. **Doc consistency** (`doc-consistency`): skipped when `prohibited_patterns` input is empty; otherwise diffs the PR against `base_ref`, filters changed files by `doc_path_filter` prefix, and runs each `PATTERN|||MESSAGE` pair as a case-insensitive `grep -E` check — reports failures as GitHub error annotations with up to 5 matching lines shown

No secrets or external services required. Callers pass repo-specific prohibited patterns as a newline-separated multiline input; comment lines (starting with `#`) are skipped.

### index-notify: URL_DELETED support (28 June 2026)

- Added optional `deleted_urls` input to both `workflow_call` and `workflow_dispatch` triggers (default `''`)
- Made `urls` input optional (was `required: true`) to handle the case where only deletions occur
- Added `if: inputs.urls != ''` guard on existing "Submit to Google Indexing API" and "Submit to IndexNow" steps
- Added "Submit deletions to Google Indexing API" step: `if: inputs.deleted_urls != ''`, loops over `deleted_urls`, POSTs `"type": "URL_DELETED"`, `continue-on-error: true`
- IndexNow has no deletion concept — deleted URLs only go to Google Indexing API
- Updated README.md inputs table to document `deleted_urls`

## Recently completed

### Template sync workflow upgrades (feat/template-sync-workflow, 2026-06-27)

Three upgrades to `scripts/template-sync.mjs` and `.github/workflows/template-sync.yml`:

1. **PRs instead of issues for findings**: auto-applied changes still get individual PRs.
   The summary (skipped items, manual review items, port-back recommendations) is now a
   single findings PR with no code changes rather than a GitHub issue. Falls back to an
   issue only if PR creation fails.

2. **Retainer estimates in every PR body**: the agent estimates hours for each auto-generated
   PR (`**Retainer:** X.Xh`) based on change complexity (minor guard = 0.25h, moderate
   improvement = 0.5h, significant multi-file change = 1-2h).

3. **Bi-directional sync via PRs**: when the agent identifies client improvements to port
   back to the template, it now creates PRs in the template repo directly using four new
   tools (`write_template_file`, `git_create_template_branch`,
   `git_commit_and_push_template`, `create_template_pr`). Requires `TEMPLATE_WRITE_TOKEN`
   secret (optional PAT with write access to the template repo). Falls back to issues if
   the token is absent.

Caller workflow added to `doublewolfconsulting/mash` at `.github/workflows/template-sync.yml`
(runs 1st of every month at 09:00 SGT, `working_directory: Deliverables/Website`).

## Completed tasks

### Task 3 — Add working_directory input to site-test reusable workflow (done 2026-06-20, PR #24)

**Problem:** Callers with website source not at repo root (e.g. Mash at `Deliverables/Website/`)
could not use the workflow — passing `working_directory` input caused a validation error:
`working_directory is not defined in the referenced workflow`.

**Fix:** Added `inputs.working_directory` (type: string, default: `.`) to the `workflow_call`
trigger. All caller-repo steps now use `working-directory: ${{ inputs.working_directory }}`.
The `serve` binary path and `NODE_PATH` use `${{ github.workspace }}` absolute paths so they
resolve correctly regardless of working directory.

### Task 2 — Add layout structure tests to the static site (done 2026-06-15)

**File:** `scripts/site-test.mjs` in `doublewolfconsulting/consulting.doublewolf-static`
(lives in the caller's repo, not here)

Added `testLayout(page, key)` and `testNowJsonLd(page)` helpers. Called from
`testHomepage`, `testFaq`, `testAbout`, and `testOtherPages`. Tests:

1. `<body data-page="X">` matches `page.layout.dataPage` (all pages)
2. `<main>` and `<h1>` carry canonical class strings from `cfg.layout.innerPage` (inner pages only)
3. Breadcrumb nav present/absent and correct depth per `page.layout.hasBreadcrumb` / `breadcrumbDepth`
4. h2 section headings present for pages with `page.layout.h2s` defined (currently `/now`)
5. `/now`: JSON-LD BreadcrumbList has exactly 3 items ending in `/`, `/about`, `/now`

### Task 1 — Fix Playwright browser install timeout (done 2026-06-13, revised 2026-06-13)

**Problem (revised):** The hang is in the post-download extraction/verification phase of
`npx playwright install chromium` itself — not in `--with-deps` / apt-get. The 170 MB
download completes in ~1s, then extraction hangs for exactly 15 minutes until job timeout.
**Fix:** Add browser caching keyed on `_wf/package-lock.json` (Playwright version) so
extraction only happens once. Skip the install step on cache hit. Add `timeout-minutes: 2`
on both browser and deps steps as a safety net.
```yaml
- name: Cache Playwright browsers
  uses: actions/cache@v4
  id: playwright-cache
  with:
    path: ~/.cache/ms-playwright
    key: playwright-${{ hashFiles('_wf/package-lock.json') }}

- name: Install Playwright browser
  if: steps.playwright-cache.outputs.cache-hit != 'true'
  run: npx playwright install chromium
  working-directory: _wf
  timeout-minutes: 2

- name: Install Playwright system dependencies
  run: npx playwright install-deps chromium
  working-directory: _wf
  timeout-minutes: 2
  env:
    DEBIAN_FRONTEND: noninteractive
```
