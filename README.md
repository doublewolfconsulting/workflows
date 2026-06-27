# Reusable GitHub Workflows

A collection of reusable GitHub Actions workflows.

Dependabot is configured to open weekly PRs for npm and GitHub Actions version bumps.

---

## PSI Monitor

**File:** `.github/workflows/psi-monitor.yml`

Runs on a schedule: checks [PageSpeed Insights](https://developers.google.com/speed/docs/insights/v5/about) scores, runs a Playwright site audit, and validates JSON-LD schema if `schema_config` is provided. On any failure, uses Claude to diagnose the root cause and opens a GitHub issue. If confidence is high, also opens a draft PR with a proposed fix.

### Usage

```yaml
# .github/workflows/psi-monitor.yml
on:
  schedule:
    - cron: '0 1 * * 1'  # every Monday at 09:00 SGT (01:00 UTC)
  workflow_dispatch:

jobs:
  monitor:
    uses: doublewolfconsulting/workflows/.github/workflows/psi-monitor.yml@main
    with:
      site_url: 'https://example.com'
      mobile_threshold: 90
      desktop_threshold: 90
      context_files: 'CLAUDE.md src/index.html'  # space-separated, repo-relative
      schema_config: '{"https://example.com/":["Organization","WebSite","WebPage"]}'  # optional
    secrets: inherit
```

### Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `site_url` | Yes | (none) | The URL to audit (e.g. `https://example.com`) |
| `mobile_threshold` | No | `90` | Minimum mobile PSI score |
| `desktop_threshold` | No | `90` | Minimum desktop PSI score |
| `context_files` | No | `CLAUDE.md` | Space-separated repo-relative paths to include in Claude's context when diagnosing failures |
| `schema_config` | No | (none) | JSON object mapping URLs to arrays of expected JSON-LD type values. Fails the run if any expected type is missing from the page. Nested types (e.g. `AggregateRating` inside `Organization`) are detected via full recursive traversal. Example: `{"https://example.com/":["Organization","WebSite"]}` |

### Setup

1. **Google PSI API key**: get one from the [Google Cloud Console](https://console.cloud.google.com/) with the *PageSpeed Insights API* enabled. Add it as a repository secret named `GOOGLE_PSI_API_KEY`.

2. **Anthropic API key**: get one from [console.anthropic.com](https://console.anthropic.com/). Add it as a repository secret named `ANTHROPIC_API_KEY`.

3. **`GITHUB_TOKEN`**: provided automatically by Actions. The workflow needs `contents: write`, `issues: write`, and `pull-requests: write` permissions, granted via the `permissions:` block in the shared workflow.

### How it works

Three checks run on every execution. All three must pass or a `site-health` issue is opened.

#### 1. PSI scores

Fetches Google PageSpeed Insights for both mobile and desktop. If either score falls below the configured threshold, the run retries once after 5 minutes before raising an alarm. This avoids false positives from transient measurement noise.

#### 2. Playwright site audit

Launches a headless Chromium browser against the live site and runs a Playwright script that checks rendering, navigation, and basic accessibility. Failures indicate something broke in production that PSI alone would not catch.

#### 3. Schema validation

If `schema_config` is provided, navigates to each URL via Playwright and extracts all JSON-LD type values (including types nested inside parent objects, e.g. `AggregateRating` inside `Organization`). Fails if any expected type is missing.

#### On failure

The failing checks are passed to `claude-sonnet-4-6` alongside the files listed in `context_files`. Claude diagnoses the root cause and proposes a fix. The workflow then:

- Opens a GitHub issue labelled `site-health` with the PSI scores, Playwright output, schema failures, and Claude's diagnosis
- If Claude's confidence is high and the fix matches a known pattern, opens a draft PR with the proposed change
- On subsequent failures while the issue is open, appends a comment rather than opening a new issue
- Auto-closes the issue when all checks pass again

#### Internals

The workflow checks out both the caller's repo (for context files and git operations) and this workflows repo (for the script and its dependencies) into a `_wf/` subfolder. No script or `package.json` is needed in the calling repo. The Playwright Chromium binary is cached between runs (keyed on `_wf/package-lock.json`) and only downloaded and extracted on a cache miss.

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
    steps:
      # ... your deploy steps ...
      - name: Detect changed pages
        id: detect-urls
        run: |
          echo "urls=https://example.com/ https://example.com/faq" >> "$GITHUB_OUTPUT"

  index-notify:
    needs: deploy
    if: needs.deploy.outputs.urls != ''
    uses: YOUR_ORG/YOUR_WORKFLOWS_REPO/.github/workflows/index-notify.yml@main
    with:
      urls: ${{ needs.deploy.outputs.urls }}
    secrets:
      GOOGLE_OAUTH_CLIENT_ID: ${{ secrets.GOOGLE_OAUTH_CLIENT_ID }}
      GOOGLE_OAUTH_CLIENT_SECRET: ${{ secrets.GOOGLE_OAUTH_CLIENT_SECRET }}
      GOOGLE_INDEXING_REFRESH_TOKEN: ${{ secrets.GOOGLE_INDEXING_REFRESH_TOKEN }}
      INDEXNOW_KEY: ${{ secrets.INDEXNOW_KEY }}
```

For emergency manual submission without a full deploy, trigger via the GitHub Actions UI with explicit URLs.

### Inputs

| Input | Required | Description |
|-------|----------|-------------|
| `urls` | Yes | Space-separated URLs to submit (e.g. `https://example.com/ https://example.com/faq`) |

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
