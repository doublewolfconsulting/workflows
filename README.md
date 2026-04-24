# Reusable GitHub Workflows

A collection of reusable GitHub Actions workflows.

---

## PSI Monitor

**File:** `.github/workflows/psi-monitor.yml`

Monitors your site's [Google PageSpeed Insights](https://developers.google.com/speed/docs/insights/v5/about) scores on a schedule and uses Claude to analyze regressions, then opens GitHub issues or pull requests when performance drops.

### Usage

```yaml
# .github/workflows/monitor.yml
on:
  schedule:
    - cron: '0 9 * * 1'  # every Monday at 9am
  workflow_dispatch:

jobs:
  psi:
    uses: Double-Wolf/workflows/.github/workflows/psi-monitor.yml@main
    secrets:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      GOOGLE_PSI_API_KEY: ${{ secrets.GOOGLE_PSI_API_KEY }}
```

### Setup

1. **Google PSI API key** — get one from the [Google Cloud Console](https://console.cloud.google.com/) with the *PageSpeed Insights API* enabled. Add it as a repository secret named `GOOGLE_PSI_API_KEY`.

2. **Anthropic API key** — get one from [console.anthropic.com](https://console.anthropic.com/). Add it as a repository secret named `ANTHROPIC_API_KEY`.

3. **`GITHUB_TOKEN`** — provided automatically by Actions. The workflow needs `contents: write`, `issues: write`, and `pull-requests: write` permissions, so make sure your repo's Actions settings allow it (or grant them explicitly via the calling workflow).

4. **`scripts/psi-monitor.mjs`** — add this script to your repository. It should export the logic for fetching PSI scores, comparing them, and creating issues/PRs. The workflow passes `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, and `GOOGLE_PSI_API_KEY` as environment variables.

### Requirements

- `package.json` + `package-lock.json` at the repo root (the workflow runs `npm ci`)
- Node.js 24 compatible code

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

1. **GCP project** — enable the *Web Search Indexing API*. Create an OAuth 2.0 client (Web application type) with `https://developers.google.com/oauthplayground` as an authorized redirect URI.

2. **Refresh token** — go to [OAuth 2.0 Playground](https://developers.google.com/oauthplayground/), click the settings gear, enable "Use your own OAuth credentials", enter your client ID and secret. Authorize scope `https://www.googleapis.com/auth/indexing` using the Google account that owns the GSC property. Exchange the authorization code and copy the refresh token. Add all four values as repository secrets.

3. **GSC ownership** — the Google account used in step 2 must be a verified owner of the property in Google Search Console. Service accounts cannot be granted GSC ownership via the UI.

4. **IndexNow key file** — serve a plain-text file at `https://{your-host}/{INDEXNOW_KEY}.txt` containing only the key string. This lets IndexNow verify site ownership.

### Notes

- Google Indexing API is officially documented for `JobPosting`/`BroadcastEvent` schema types but works for general pages. If Google stops accepting submissions, IndexNow continues to cover Bing and Yandex, and Google crawls the sitemap naturally.
- The `host` for the IndexNow payload is derived from the first URL in the list.
- `GOOGLE_INDEXING_REFRESH_TOKEN` is tied to the authorizing Google account. If that account loses GSC ownership or the token is revoked, re-authorize via OAuth Playground.

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
    uses: Double-Wolf/workflows/.github/workflows/sync-md-to-gdoc.yml@main
    with:
      md_file: docs/prd.md
      reference_doc: docs/template.docx  # optional
    secrets:
      WORKLOAD_IDENTITY_PROVIDER: ${{ secrets.WORKLOAD_IDENTITY_PROVIDER }}
      SERVICE_ACCOUNT_EMAIL: ${{ secrets.SERVICE_ACCOUNT_EMAIL }}
      GOOGLE_DOC_ID: ${{ secrets.GOOGLE_DOC_ID }}
```

### Inputs

| Input | Required | Description |
|-------|----------|-------------|
| `md_file` | Yes | Path to the Markdown file in your repo (e.g. `docs/prd.md`) |
| `reference_doc` | No | Path to a `.docx` template for Pandoc styling |

### Secrets

| Secret | Description |
|--------|-------------|
| `WORKLOAD_IDENTITY_PROVIDER` | Workload Identity Federation provider resource name |
| `SERVICE_ACCOUNT_EMAIL` | Google service account email |
| `GOOGLE_DOC_ID` | The file ID from the Google Doc URL |

### Setup

1. **Google Doc** — create the Doc and copy its file ID from the URL (`https://docs.google.com/document/d/<FILE_ID>/edit`). Add it as `GOOGLE_DOC_ID`.

2. **Google Cloud service account** — create a service account in Google Cloud, share the Google Doc with it (Editor), and configure [Workload Identity Federation](https://cloud.google.com/iam/docs/workload-identity-federation) for GitHub Actions. Add the provider resource name as `WORKLOAD_IDENTITY_PROVIDER` and the service account email as `SERVICE_ACCOUNT_EMAIL`.

3. **Permissions** — the calling workflow needs `id-token: write` and `contents: read`. These are set automatically by this workflow, but your repo's Actions settings must allow it.
