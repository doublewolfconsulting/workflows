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
creates a findings PR in the client repo (no code changes) summarising what was applied, what
was skipped, and any client improvements to port back to the template. Falls back to an issue
only if PR creation fails.

Each auto-generated PR body includes a `**Retainer:** X.Xh` estimate based on change complexity.

Bi-directional sync: if client improvements should go back to the template, the agent creates
PRs directly in the template repo using `TEMPLATE_WRITE_TOKEN`. Falls back to issues if the
token is absent or lacks write access.

Required env vars: `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `CLIENT_REPO`, `CLIENT_DIR`,
`CLIENT_WORKING_DIR`, `TEMPLATE_DIR`.

Optional env vars:
- `TEMPLATE_WRITE_TOKEN` — PAT with write access to the template repo. If not set,
  client-to-template improvements are raised as issues in the template repo instead of PRs.
