# Reusable GitHub Workflows

A collection of reusable GitHub Actions workflows.

Dependabot is configured to open weekly PRs for npm and GitHub Actions version bumps.

---

## PR Review

**File:** `.github/workflows/auto-review.yml`

Runs Claude as an automated reviewer on every non-draft PR. Gets the PR diff, makes a **single API call** to Claude Sonnet 4.6 with the diff + repo context, then approves or requests changes. No agentic loop — predictable cost of ~$0.02–0.05 per review. No `@claude review` needed.

### Usage

```yaml
# .github/workflows/auto-review.yml
name: PR Review

on:
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened, ready_for_review]

jobs:
  review:
    if: github.event.pull_request.draft == false
    concurrency:
      group: pr-review-${{ github.event.pull_request.number }}
      cancel-in-progress: true
    permissions:
      contents: read
      pull-requests: write
      issues: write
      id-token: write
      actions: read
    uses: doublewolfconsulting/workflows/.github/workflows/auto-review.yml@main
    with:
      additional_context: |
        Any repo-specific facts Claude should verify changed files against.
        E.g. correct field names, S3 paths, schedule times, fund counts.
    secrets:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

### Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `additional_context` | No | `''` | Repo-specific ground-truth facts, coding standards, architecture notes injected into the prompt. |

### Secrets

| Secret | Description |
|--------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key (same key used by PSI monitor and template sync). Sonnet 4.6 is pinned to keep costs low. |

### Setup

In the caller repo, go to **Settings → Actions → General → Workflow permissions** and enable **"Allow GitHub Actions to create and approve pull requests"**.

### How it works

1. `gh pr diff` fetches the PR diff
2. A single Claude Sonnet 4.6 API call receives the diff + `additional_context` as ground truth
3. Claude responds with `{"decision": "approve"|"request_changes", "body": "..."}`
4. The script normalizes the response (see below), then `gh pr review` posts the result

For each issue found (typo, wrong fact, stale reference, inconsistency), the body states precisely: `FILE · what is wrong · correct value · source`. Each line is prefixed ✅ (approve) or ❌ (request changes) for visual clarity in the GitHub PR timeline.

**Response normalization** — the script applies two layers after receiving Claude's response, before posting:

- **Decision/body mismatch**: if Claude returns `request_changes` but the body starts with "LGTM" or "no blocking issues", the decision is corrected to `approve`.
- **Retraction filtering**: body lines that contain the `FILE · ISSUE` format AND a retraction signal ("no blocking", "is correct", "withdrawn", "resolved", "acceptable", "internally consistent", etc.) are stripped. If no genuine blocking lines remain after filtering, the decision is normalized to `approve`.

These handle the model occasionally including an item, analysing it as non-blocking, and still setting `request_changes`.

- **Issues found** → REQUEST CHANGES with detailed findings. The status check **fails** (exit 1), blocking the merge.
- **Everything correct** → APPROVED, body "LGTM". Status check passes.
- Each line in the posted review is prefixed ✅ or ❌ individually — even in a REQUEST CHANGES review, a line the model describes as resolved/not-blocking gets ✅, not a blanket ❌ across the whole body.
- Draft PRs are skipped. Concurrency cancel ensures no stale reviews on multi-push PRs.

### Known limitations

- **Diff-only context**: the reviewer sees only changed lines, not the full codebase. It cannot detect cross-file issues — a function deleted in this PR but still called in another unchanged file, a constant redefined elsewhere, or a schema change that breaks an unrelated query. Complement with type checking, linting, and tests.
- **No code execution**: cannot run builds, tests, or scripts. "This looks correct" is static analysis, not verified behaviour. Automated test suites catch what the reviewer cannot.
- **`additional_context` is the key lever**: without project-specific ground truth (correct field names, API shapes, config counts, canonical values), the reviewer operates on general heuristics only. The more concrete and specific the context, the higher the signal-to-noise.
- **Large PRs degrade quality**: very large diffs approach context limits and reduce review depth. Smaller, focused PRs get more reliable feedback.
- **Retraction filter is heuristic**: the normalization layer catches the most common false-positive patterns observed in production, but a REQUEST CHANGES review should still be read by a human before acting on it. The filter errs on the side of approving ambiguous cases.
- **Not a replacement for human review on high-stakes changes**: ideal for catching typos, stale values, wrong facts, and obvious inconsistencies. For complex architectural decisions, security-sensitive changes, or business logic, human review remains essential.

---

## PR Checks

**File:** `.github/workflows/pr-checks.yml`

Runs on every PR against `main`. Validates PR hygiene and catches known doc consistency errors before review. No secrets or external services required.

Three jobs run in parallel:

1. **PR body** — required sections present (configurable), minimum length
2. **Branch name** — must match naming convention (configurable regex); long-lived branches (`main`, `development`, `staging`) are always allowed
3. **Doc consistency** — changed files under a configurable path prefix are scanned for `prohibited_patterns` (must not be present) and `required_patterns` (must be present). Both are optional.

### Usage

```yaml
# .github/workflows/pr-checks.yml
name: PR Checks

on:
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened]

jobs:
  checks:
    uses: doublewolfconsulting/workflows/.github/workflows/pr-checks.yml@main
    with:
      prohibited_patterns: |
        bad pattern|||Error message shown as GitHub annotation
        another pattern|||Another message
      required_patterns: |
        must-exist pattern|||Message if pattern is missing from a changed file
```

No secrets required.

### Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `required_sections` | No | `## Summary,## Test plan` | Comma-separated list of section headers that must appear in the PR body |
| `branch_pattern` | No | `^(feature\|feat\|fix\|docs\|chore\|refactor\|test\|claude)/` | ERE regex that branch names must match |
| `doc_path_filter` | No | `docs/` | File path prefix to scope doc consistency checks |
| `prohibited_patterns` | No | `''` (skips) | Newline-separated `PATTERN\|\|\|MESSAGE` pairs. Fails if pattern IS found in a changed docs file. |
| `required_patterns` | No | `''` (skips) | Newline-separated `PATTERN\|\|\|MESSAGE` pairs. Fails if pattern is NOT found in a changed docs file. |

### Pattern format

Both inputs use the same `PATTERN|||MESSAGE` format:

```
# Comment lines (starting with #) are ignored
15 fund|||Wrong fund count — use "3 funds (6 share classes)"
s3://boreas-documents|||Wrong S3 bucket — use boreas-fund-data/documents/
```

`PATTERN` is a case-insensitive `grep -E` expression matched against every changed file under `doc_path_filter`. Failures appear as GitHub error annotations at the file level, with up to 5 matching lines shown for prohibited patterns.

`doc-consistency` job is skipped entirely when both `prohibited_patterns` and `required_patterns` are empty.

### Setup

No secrets or external services needed. Add the caller workflow and optionally a `CODEOWNERS` file to enforce required reviewers via branch protection.

---

## PR Labels

**File:** `.github/workflows/pr-labels.yml`

Auto-labels PRs against `main` as `ai-authored` or `ai-assisted`, so it's visible at a glance
whether a PR came from an autonomous agent session or from a human who used AI tooling along
the way. Creates both labels in the repo on first use if they don't already exist. Purely
GitHub-metadata based — no Anthropic call, no secrets.

### Usage

```yaml
# .github/workflows/pr-labels.yml
name: PR Labels

on:
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened]

jobs:
  labels:
    permissions:
      contents: read
      pull-requests: write
      issues: write
    uses: doublewolfconsulting/workflows/.github/workflows/pr-labels.yml@main
```

No secrets required.

### Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `ai_authored_branch_prefix` | No | `claude/` | Branch-name prefix that marks a PR as fully AI-generated |
| `ai_assisted_patterns` | No | see workflow file | Newline-separated case-insensitive ERE patterns, checked against the PR body + every commit message. Any match labels the PR `ai-assisted`. `#`-comment lines are ignored. |

### How it works

1. **`ai-authored`** — if the PR's head branch starts with `ai_authored_branch_prefix`
   (default `claude/`), that's the whole signal: branch names are platform-assigned for
   autonomous sessions, not self-reported, so one check is enough.
2. **`ai-assisted`** — otherwise, checks the PR body *and* every commit message in the PR
   against a bank of patterns covering multiple signal types (commit trailers like
   `Co-Authored-By: Claude`, tool footers like "Generated with Claude Code", session links,
   generic phrasing) — not just one exact format, since relying on a single trailer convention
   is too easy to miss. Any single match anywhere in that combined text is sufficient.
3. If neither signal is found, no label is applied or changed — a human can label a PR
   `ai-assisted` manually in that case.
4. The two labels are kept mutually exclusive: applying one removes the other if present.

Note: `pr-checks.yml`'s "PR body" check no longer fails on AI-attribution phrases (see below) —
that's what makes scanning the PR body here safe and useful instead of adversarial.

---

## Index Notify

**File:** `.github/workflows/index-notify.yml`

Submits URLs to the [Google Indexing API](https://developers.google.com/search/apis/indexing-api/v3/quickstart) and [IndexNow](https://www.indexnow.org/) (Bing, Yandex) after a deploy, replacing the manual "Request Indexing" button in Google Search Console.

Both submit steps use `continue-on-error: true`, so indexing failures never block a deploy.

### Usage

Expose detected URLs as a job output in your deploy workflow, then call this workflow as a second job:

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    outputs:
      urls: ${{ steps.detect-urls.outputs.urls }}
      deleted_urls: ${{ steps.detect-deleted.outputs.deleted_urls }}
    steps:
      # ... your deploy steps ...
      - name: Detect changed pages
        id: detect-urls
        run: |
          echo "urls=https://example.com/ https://example.com/faq" >> "$GITHUB_OUTPUT"
      - name: Detect deleted pages
        id: detect-deleted
        run: |
          echo "deleted_urls=https://example.com/old-page" >> "$GITHUB_OUTPUT"

  index-notify:
    needs: deploy
    if: needs.deploy.outputs.urls != '' || needs.deploy.outputs.deleted_urls != ''
    uses: YOUR_ORG/YOUR_WORKFLOWS_REPO/.github/workflows/index-notify.yml@main
    with:
      urls: ${{ needs.deploy.outputs.urls }}
      deleted_urls: ${{ needs.deploy.outputs.deleted_urls }}
    secrets:
      GOOGLE_OAUTH_CLIENT_ID: ${{ secrets.GOOGLE_OAUTH_CLIENT_ID }}
      GOOGLE_OAUTH_CLIENT_SECRET: ${{ secrets.GOOGLE_OAUTH_CLIENT_SECRET }}
      GOOGLE_INDEXING_REFRESH_TOKEN: ${{ secrets.GOOGLE_INDEXING_REFRESH_TOKEN }}
      INDEXNOW_KEY: ${{ secrets.INDEXNOW_KEY }}
```

For emergency manual submission without a full deploy, trigger via the GitHub Actions UI with explicit URLs.

### Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `urls` | No | `''` | Space-separated URLs to submit as updated (e.g. `https://example.com/ https://example.com/faq`) |
| `deleted_urls` | No | `''` | Space-separated URLs that have been removed; submitted as `URL_DELETED` to Google Indexing API (IndexNow has no deletion concept) |

### Secrets

| Secret | Description |
|--------|-------------|
| `GOOGLE_OAUTH_CLIENT_ID` | OAuth client ID (GCP project with Web Search Indexing API enabled) |
| `GOOGLE_OAUTH_CLIENT_SECRET` | OAuth client secret from the same GCP project |
| `GOOGLE_INDEXING_REFRESH_TOKEN` | Long-lived refresh token from OAuth Playground, authorized as GSC property owner |
| `INDEXNOW_KEY` | IndexNow key string (must match the key file served at `https://{host}/{key}.txt`) |

### Setup

1. **GCP project**: enable the *Web Search Indexing API*. Create an OAuth 2.0 client (Web application type) with `https://developers.google.com/oauthplayground` as an authorized redirect URI.

2. **Refresh token**: go to [OAuth 2.0 Playground](https://developers.google.com/oauthplayground/), click the settings gear, enable "Use your own OAuth credentials", enter your client ID and secret. Authorize scope `https://www.googleapis.com/auth/indexing` using the Google account that owns the GSC property. Exchange the authorization code and copy the refresh token. Add all four values as repository secrets.

3. **GSC ownership**: the Google account used in step 2 must be a verified owner of the property in Google Search Console. Service accounts cannot be granted GSC ownership via the UI.

4. **IndexNow key file**: serve a plain-text file at `https://{your-host}/{INDEXNOW_KEY}.txt` containing only the key string. This lets IndexNow verify site ownership.

### Notes

- Google Indexing API is officially documented for `JobPosting`/`BroadcastEvent` schema types but works for general pages. If Google stops accepting submissions, IndexNow continues to cover Bing and Yandex, and Google crawls the sitemap naturally.
- The `host` for the IndexNow payload is derived from the first URL in the list.
- `GOOGLE_INDEXING_REFRESH_TOKEN` is tied to the authorizing Google account. If that account loses GSC ownership or the token is revoked, re-authorize via OAuth Playground.

---

## PSI Monitor

**File:** `.github/workflows/psi-monitor.yml`

Runs on a schedule: checks [PageSpeed Insights](https://developers.google.com/speed/docs/insights/v5/about) scores (performance, accessibility, best-practices, SEO) across all configured pages, runs a Playwright site audit, and validates JSON-LD schema if `schema_config` is provided. On any failure, uses Claude to diagnose the root cause and opens a GitHub issue. Every run (pass or fail) writes a job summary to the Actions tab with full Lighthouse findings. If confidence is high, also opens a draft PR with a proposed fix.

### Usage

The recommended pattern derives both `schema_config` and `pages` from `site.config.js` in a pre-job, then passes them to the monitor:

```yaml
# .github/workflows/psi-monitor.yml
on:
  schedule:
    - cron: '0 1 * * 1'  # every Monday at 09:00 SGT (01:00 UTC)
  workflow_dispatch:

jobs:
  generate-config:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    outputs:
      schema_config: ${{ steps.gen.outputs.schema_config }}
      pages: ${{ steps.gen.outputs.pages }}
    steps:
      - uses: actions/checkout@v7
      - name: Derive schema_config and pages from site.config.js
        id: gen
        run: |
          CONFIG=$(node -e "
            const cfg = require('./site.config.js');
            const out = {};
            for (const [key, page] of Object.entries(cfg.pages)) {
              if (page.schemas) {
                const url = key === 'home' ? cfg.site.baseUrl + '/' : cfg.site.baseUrl + page.url;
                out[url] = page.schemas;
              }
            }
            console.log(JSON.stringify(out));
          ")
          PAGES=$(node -e "
            const cfg = require('./site.config.js');
            const pages = Object.entries(cfg.pages).map(([key, p]) =>
              key === 'home' ? cfg.site.baseUrl + '/' : cfg.site.baseUrl + p.url
            );
            console.log(JSON.stringify(pages));
          ")
          echo "schema_config=$CONFIG" >> $GITHUB_OUTPUT
          echo "pages=$PAGES" >> $GITHUB_OUTPUT

  monitor:
    needs: generate-config
    uses: doublewolfconsulting/workflows/.github/workflows/psi-monitor.yml@main
    with:
      site_url: 'https://example.com'
      pages: ${{ needs.generate-config.outputs.pages }}
      performance_mobile_threshold: 95
      performance_desktop_threshold: 95
      accessibility_mobile_threshold: 95
      accessibility_desktop_threshold: 95
      best_practices_mobile_threshold: 95
      best_practices_desktop_threshold: 95
      seo_mobile_threshold: 95
      seo_desktop_threshold: 95
      context_files: 'CLAUDE.md src/index.html'
      schema_config: ${{ needs.generate-config.outputs.schema_config }}
    secrets: inherit
    permissions:
      contents: write
      issues: write
      pull-requests: write
```

If you only need the homepage audited and don't need per-category thresholds, the minimal backwards-compatible form still works:

```yaml
jobs:
  monitor:
    uses: doublewolfconsulting/workflows/.github/workflows/psi-monitor.yml@main
    with:
      site_url: 'https://example.com'
      mobile_threshold: 90
      desktop_threshold: 90
    secrets: inherit
```

### Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `site_url` | Yes | (none) | Primary site URL (used for Playwright audit and as fallback when `pages` is omitted) |
| `pages` | No | `[site_url]` | JSON array of page URLs to audit. Omit for homepage-only. |
| `mobile_threshold` | No | `90` | Legacy: minimum mobile performance score. Used when `performance_mobile_threshold` is 0. |
| `desktop_threshold` | No | `90` | Legacy: minimum desktop performance score. Used when `performance_desktop_threshold` is 0. |
| `performance_mobile_threshold` | No | `0` | Performance threshold for mobile. 0 = fall back to `mobile_threshold`. |
| `performance_desktop_threshold` | No | `0` | Performance threshold for desktop. 0 = fall back to `desktop_threshold`. |
| `accessibility_mobile_threshold` | No | `0` | Accessibility threshold for mobile. 0 = skip check. |
| `accessibility_desktop_threshold` | No | `0` | Accessibility threshold for desktop. 0 = skip check. |
| `best_practices_mobile_threshold` | No | `0` | Best practices threshold for mobile. 0 = skip check. |
| `best_practices_desktop_threshold` | No | `0` | Best practices threshold for desktop. 0 = skip check. |
| `seo_mobile_threshold` | No | `0` | SEO threshold for mobile. 0 = skip check. |
| `seo_desktop_threshold` | No | `0` | SEO threshold for desktop. 0 = skip check. |
| `context_files` | No | `CLAUDE.md` | Space-separated repo-relative paths to include in Claude's context when diagnosing failures |
| `schema_config` | No | (none) | JSON object mapping URLs to arrays of expected JSON-LD type values. Example: `{"https://example.com/":["Organization","WebSite"]}` |

### Setup

1. **Google PSI API key**: get one from the [Google Cloud Console](https://console.cloud.google.com/) with the *PageSpeed Insights API* enabled. Add it as a repository secret named `GOOGLE_PSI_API_KEY`.

2. **Anthropic API key**: get one from [console.anthropic.com](https://console.anthropic.com/). Add it as a repository secret named `ANTHROPIC_API_KEY`.

3. **`GITHUB_TOKEN`**: provided automatically by Actions. The caller must include `permissions: contents: write, issues: write, pull-requests: write`.

### How it works

Four checks run on every execution. All must pass or a `site-health` issue is opened.

#### 1. PSI scores (multi-page, all categories)

Fetches Google PageSpeed Insights for every URL in `pages`, for both mobile and desktop (2 API calls per page). Extracts all four category scores — performance, accessibility, best-practices, SEO — from each response (no extra calls; PSI already returns all four). Checks each score against its configured threshold; a threshold of `0` skips that category.

If any page falls below a threshold, all failing pages are retried together after a single 2-minute wait (not per-page — sequential waits would compound with many pages). Two consecutive failures means the regression is real.

#### 2. GitHub Actions job summary

After every run — pass or fail — a job summary is written to the Actions tab ("Summary" panel on the run page). It shows the per-page scores table and full Lighthouse findings for every page with ✅/⚠️/❌ icons, including passing items. This surfaces optimisation opportunities (unused JS, image savings, long cache TTL, etc.) even when all scores are green.

#### 3. Playwright site audit

Launches a headless Chromium browser against `site_url` (homepage) and captures console errors, failed network requests (4xx/5xx), and broken internal links. Failures indicate something broke in production that PSI alone would not catch.

**Cloudflare Bot Fight Mode compatibility**: the browser runs in stealth mode (`--disable-blink-features=AutomationControlled`, custom user-agent, `navigator.webdriver` removed via `addInitScript`). Internal link checking uses a fresh `chromium.launch()` per link with `page.goto(waitUntil:'commit')` — this carries the correct `Sec-Fetch-Mode: navigate` headers. JS-level `fetch()` from `page.evaluate()` would receive 403s from Cloudflare because those requests use `Sec-Fetch-Mode: cors`, generating false positives.

#### 4. Schema validation

If `schema_config` is provided, validates JSON-LD schema on each configured URL using a fresh `chromium.launch()` per URL in stealth mode — reusing the same page or context across multiple rapid navigations triggers Cloudflare bot detection. HTML is retrieved via `page.content()` and scanned for `<script type="application/ld+json">` blocks; types are collected via full recursive traversal. Fails if any expected type is missing.

#### On failure

Only failing pages' Lighthouse detail is sent to `claude-sonnet-4-6` (not all pages), keeping token cost proportional to failures. Claude diagnoses the root cause and proposes a fix. The workflow then:

- Opens a GitHub issue labelled `site-health` with a per-page scores table (columns only for checked categories), Playwright output, schema failures, and Claude's diagnosis
- If Claude's confidence is high, opens a draft PR with the proposed change
- On subsequent failures while the issue is open, appends a comment rather than opening a new issue
- Auto-closes the issue when all checks pass again

#### Internals

The workflow checks out both the caller's repo and this workflows repo (`_wf/` subfolder). No script or `package.json` is needed in the calling repo. The Playwright Chromium binary is cached between runs (keyed on `_wf/package-lock.json`).

---

## Site Test

**File:** `.github/workflows/site-test.yml`

Provides the build environment and Playwright harness for running a site's own test script on every PR. The test logic lives in the calling repo at `scripts/site-test.mjs`; this workflow handles the infrastructure.

### What it does

1. Checks out the calling repo
2. Sets up Node 24 with npm caching
3. Installs calling repo and workflow dependencies
4. Restores the Playwright Chromium binary from cache (keyed on `_wf/package-lock.json`); downloads and extracts only on a cache miss
5. Installs Playwright system dependencies (`install-deps`) — always runs, not cached
6. Runs `npm run build`
7. Serves `dist/` on port 3000 via `npx serve` (handles extensionless URLs)
8. Runs `scripts/site-test.mjs` from the calling repo, with Playwright resolved from this workflow's `node_modules` via `NODE_PATH`

The calling repo owns all test logic. Fork the site, customise the test script, get the infrastructure for free.

### Usage

```yaml
# .github/workflows/build.yml
on:
  pull_request:
    branches:
      - main

jobs:
  build:
    # ... your existing build job ...

  site-test:
    uses: doublewolfconsulting/workflows/.github/workflows/site-test.yml@main
    permissions:
      contents: read
```

No inputs or secrets required.

### Setup requirements

The calling repo must have `scripts/site-test.mjs`, a Node.js script that tests the built site served on `http://localhost:3000`. Import `playwright` via `createRequire` (not ESM `import`); it is resolved from the workflows repo's `node_modules` via `NODE_PATH` at runtime without needing to be declared as a dependency in the calling repo.

---

## Sync Markdown to Google Doc

**File:** `.github/workflows/sync-md-to-gdoc.yml`

Converts a Markdown file to DOCX via [Pandoc](https://pandoc.org/) and uploads it to an existing Google Doc, keeping the Doc in sync with your repo on every push.

Post-processing applied to the DOCX before upload:

- Removes Word bookmarks
- Inserts empty paragraphs between body elements to preserve blank lines
- Makes tables full-width with black borders and consistent cell padding
- Justifies all body paragraphs and zeroes out extra spacing

### Usage

```yaml
# .github/workflows/sync-prd.yml
on:
  push:
    paths:
      - 'docs/prd.md'

jobs:
  sync:
    uses: doublewolfconsulting/workflows/.github/workflows/sync-md-to-gdoc.yml@main
    with:
      md_file: docs/prd.md
      reference_doc: docs/template.docx  # optional
      google_doc_id: "YOUR_GOOGLE_DOC_ID"
    secrets:
      WORKLOAD_IDENTITY_PROVIDER: ${{ secrets.WORKLOAD_IDENTITY_PROVIDER }}
      SERVICE_ACCOUNT_EMAIL: ${{ secrets.SERVICE_ACCOUNT_EMAIL }}
```

### Inputs

| Input | Required | Description |
|-------|----------|-------------|
| `md_file` | Yes | Path to the Markdown file in your repo (e.g. `docs/prd.md`) |
| `reference_doc` | No | Path to a `.docx` template for Pandoc styling |
| `google_doc_id` | Yes | The file ID from the Google Doc URL |

### Secrets

| Secret | Description |
|--------|-------------|
| `WORKLOAD_IDENTITY_PROVIDER` | Workload Identity Federation provider resource name |
| `SERVICE_ACCOUNT_EMAIL` | Google service account email |

### Setup

1. **Google Doc**: create the Doc and share it with the service account (Editor). Copy the file ID from the URL (`https://docs.google.com/document/d/<FILE_ID>/edit`) and pass it as the `google_doc_id` input directly in your workflow file. No secret needed.

2. **Google Cloud service account**: create a service account in Google Cloud and configure [Workload Identity Federation](https://cloud.google.com/iam/docs/workload-identity-federation) for GitHub Actions. Add the provider resource name as `WORKLOAD_IDENTITY_PROVIDER` and the service account email as `SERVICE_ACCOUNT_EMAIL`.

3. **Permissions**: the calling workflow needs `id-token: write` and `contents: read`. These are set automatically by this workflow, but your repo's Actions settings must allow it.

---

## Template Sync

**File:** `.github/workflows/template-sync.yml`

Runs on a caller-defined schedule (quarterly recommended): compares a client site against the `doublewolfconsulting/consulting.doublewolf-static` template. Uses Claude to produce a structured gap analysis, auto-applies high-confidence mechanical changes as individual PRs, and opens a `template-sync` labelled issue in the client repo with the full report.

### Usage

Add this file to the client repo:

```yaml
# .github/workflows/template-sync.yml
name: Template sync check
on:
  schedule:
    - cron: '0 1 1 */3 *'  # 1st of Jan, Apr, Jul, Oct at 09:00 SGT (01:00 UTC)
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write
  issues: write

jobs:
  sync:
    uses: doublewolfconsulting/workflows/.github/workflows/template-sync.yml@main
    with:
      client_repo: your-org/your-client-repo
      working_directory: Deliverables/Website  # omit or set to '.' if site is at repo root
    secrets: inherit
```

### Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `client_repo` | Yes | (none) | Client repo in `owner/name` format (e.g. `doublewolfconsulting/mash`) |
| `working_directory` | No | `.` | Subdirectory of the client repo where the website lives. Use `.` or leave blank if the website is at the repo root. |
| `template_repo` | No | `doublewolfconsulting/consulting.doublewolf-static` | Upstream template repo in `owner/name` format |

### Secrets

| Secret | Description |
|--------|-------------|
| `ANTHROPIC_API_KEY` | Must be added to the **client repo** secrets |
| `GITHUB_TOKEN` | Provided automatically by GitHub Actions |
| `TEMPLATE_WRITE_TOKEN` | Optional. PAT with write access to the template repo (`doublewolfconsulting/consulting.doublewolf-static`). Required for bi-directional sync (creating PRs in the template repo when the client is ahead). If not set, client improvements are raised as issues in the template repo instead. |

### What it does

1. Checks out the client repo, the template repo (`_template/`), and this workflows repo (`_wf/`)
2. Reads four shared infrastructure files from each: `scripts/build.js`, `scripts/site-test.mjs`, `scripts/main.js`, `styles/input.css`
3. Sends both sets of files to `claude-sonnet-4-6` for a gap analysis, asking it to identify changes that should flow template-to-client (bug fixes, improvements) and client-to-template (improvements the template should adopt)
4. For high-confidence mechanical changes (single string replacement, build passes): applies the change, commits to a new branch (`sync/template-YYYYMM-N`), and opens a PR in the client repo. Each PR body includes a `**Retainer:** X.Xh` estimate based on change complexity.
5. If any client improvements should be ported back to the template and `TEMPLATE_WRITE_TOKEN` is set, creates PRs directly in the template repo on branches prefixed `sync/client-`. Falls back to issues in the template repo if the token is absent.
6. Opens a single findings PR in the client repo (no code changes, opened from main) titled `chore: template sync findings -- [Month Year]`. Body includes: what was auto-applied (with PR links), what was skipped and why, what needs manual review, and any port-back links. Falls back to a `template-sync` labelled issue only if PR creation itself fails.

Claude is instructed to focus only on shared infrastructure (build pipeline, test assertions, CSS utilities) and to ignore client-specific content (brand colours, config values, page names, client-specific sections).

### Setup

1. Add `ANTHROPIC_API_KEY` as a secret in the client repo.
2. Ensure the client repo's Actions settings allow creating PRs: **Settings > Actions > General > Workflow permissions > Allow GitHub Actions to create and approve pull requests**.
3. Add the caller workflow file above. The workflow runs on the schedule defined in the caller (quarterly recommended) and can also be triggered manually via the GitHub Actions UI.
