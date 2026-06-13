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
- `scripts/` — shared scripts (PSI monitor, Google Doc sync, etc.)
- `package.json` — Playwright + serve (managed here so callers don't need them)
