# Claude Code Instructions — doublewolfconsulting/workflows

## Standing rules

- **Always update README.md** when changing a workflow or script — keep the "What it does"
  steps, inputs table, and any version references in sync with the actual files.
- **Always update CONTEXT.md** after completing or adding a task — mark done items complete,
  add new pending tasks with full spec.
- Use squash merges via PR (never push directly to main).
- Branch names: `claude/<short-description>`.

## Current work

See `CONTEXT.md` for pending tasks and recent completed work.

## Repo layout

- `.github/workflows/` — reusable workflows consumed by other org repos
- `.github/dependabot.yml` — weekly npm + GitHub Actions version bumps
- `scripts/` — shared scripts (PSI monitor, template sync, Google Doc sync, etc.)
- `package.json` — Playwright + serve (managed here so callers don't need them)

### scripts/template-sync.mjs

Monthly script that compares a client site against the DW static template. Reads four shared
infrastructure files (`scripts/build.js`, `scripts/site-test.mjs`, `scripts/main.js`,
`styles/input.css`) from both repos, calls Claude (`claude-sonnet-4-6`) for a structured gap
analysis, auto-applies high-confidence mechanical changes (each on its own branch + PR), and
creates a `template-sync` labelled issue in the client repo. If any high-priority improvements
flow client-to-template, also opens an issue in `consulting.doublewolf-static`.

Env vars: `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `CLIENT_REPO`, `CLIENT_DIR`,
`CLIENT_WORKING_DIR`, `TEMPLATE_DIR`.
