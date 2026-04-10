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
