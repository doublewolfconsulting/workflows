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

### Template sync workflow (feat/template-sync-workflow, 2026-06-26)

Added `scripts/template-sync.mjs` and `.github/workflows/template-sync.yml` — a reusable
monthly workflow that compares a client site against `consulting.doublewolf-static`. Reads
four shared infrastructure files, calls Claude for a gap analysis, auto-applies
high-confidence changes (one branch + PR per change), and opens a `template-sync` labelled
issue in the client repo. High-priority client-to-template improvements also open an issue in
the template repo.

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
