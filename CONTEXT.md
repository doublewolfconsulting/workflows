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

### Task 2 — Add layout structure tests to the static site

**File:** `scripts/site-test.mjs` in `doublewolfconsulting/consulting.doublewolf-static`
(not in this repo — that script lives in the caller's repo)

**Context:** `consulting.doublewolf-static` has a `site.config.js` with a layout config.
The test script already reads it at runtime (`cfg`). Before adding anything, verify whether
`testOtherPages` already asserts HTTP 200 for all `cfg.pages` entries — do not duplicate.

**Tests to add** (for every page in `cfg.pages`):

1. `<body data-page="X">` matches `page.layout.dataPage`
2. `<main>` contains `cfg.layout.innerPage.mainClass` as a class (skip homepage)
3. `<h1>` contains `cfg.layout.innerPage.h1Class` as a class (skip homepage)
4. Breadcrumb `<nav aria-label="Breadcrumb">` is present if `page.layout.hasBreadcrumb`, absent if not
5. Breadcrumb item count equals `page.layout.breadcrumbDepth`
   (count `<li>` elements containing an `<a>` or `<span>`, not SVG separators)
6. For pages where `page.layout.h2s` is non-empty:
   each string in `h2s` appears somewhere in the page HTML
7. For `/now` specifically:
   JSON-LD `<script type="application/ld+json">` contains a `BreadcrumbList` with exactly
   3 `ListItem` entries, with `item` values ending in `/`, `/about`, and `/now`

**Why:** `cfg.layout.innerPage` holds ground-truth class strings for all inner pages.
`cfg.pages[key].layout` is the per-page structural spec. The `/now` page has a unique
3-item breadcrumb (Home > About > Now) so it gets an explicit JSON-LD check.

## Completed tasks

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
