---
name: post-release-sync
description: >-
  Use when the user asks to sync local repositories with origin after a release,
  refresh git tags, or prune merged local branches across Ingress Shards repos.
---

# Post-Release Workspace Sync

Use the bundled cross-platform script [scripts/sync.mjs](./scripts/sync.mjs) instead of shell `xargs`/`grep` pipelines so it works identically on Windows and Linux.

Resolve `<skill-dir>` as the directory containing this `SKILL.md` file. `--all` automatically locates sibling product repositories from `cwd`, `dirname(cwd)`, or the kit's parent directory—so `ingress-events-ai-kit` does not need to live in the same parent folder as your code repositories.

## 1. Preview First (Read-Only)
Always run a dry-run preview first and present the planned commands to the user:

```bash
node "<skill-dir>/scripts/sync.mjs" --all --dry-run
```

Or target a single repository:

```bash
node "<skill-dir>/scripts/sync.mjs" --repo "<path-to-repo>" --dry-run
```

## 2. Execute Only After Approval
Because syncing checks out `main`, fast-forwards, deletes local tags, and prunes merged branches, **never run without `--dry-run` until the user says `"Execute git commands"`**:

```bash
node "<skill-dir>/scripts/sync.mjs" --all
```

## What `sync.mjs` Does Per Repo
1. `git fetch origin --tags --prune --prune-tags`
2. `git checkout main` and `git pull --ff-only`
3. Deletes stale local tags and re-fetches `origin --tags`
4. Deletes local branches already merged into `main` (excluding `main` and the current branch)
5. `git remote prune origin`
