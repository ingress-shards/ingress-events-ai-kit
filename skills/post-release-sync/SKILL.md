---
name: post-release-sync
description: >-
  Use when the user asks to sync local repositories with origin after a release,
  summarize repo/tag/branch status across Ingress Shards repos, or prune merged
  local branches.
---

# Post-Release Workspace Sync

Use the bundled cross-platform script [scripts/sync.mjs](./scripts/sync.mjs) instead of shell `xargs`/`grep` pipelines so it works identically on Windows and Linux across all **4** Ingress Shards repositories (`ingress-events-core`, `iitc-plugin-site-observer`, `ingress-shards.github.io`, `ingress-events-ai-kit`).

Resolve `<skill-dir>` as the directory containing this `SKILL.md` file. `--all` automatically locates sibling repositories from `cwd`, `dirname(cwd)`, or the kit's parent directory—so `ingress-events-ai-kit` does not need to live in the same parent folder as your code repositories.

## 1. Inspect Workspace First (Read-Only)
Always run `--dry-run` first (zero `.git/` writes; queries local Git state plus read-only `git ls-remote`) and present the summary and suggested sync plan to the user:

```bash
node "<skill-dir>/scripts/sync.mjs" --all --dry-run
```

Or target a single repository:

```bash
node "<skill-dir>/scripts/sync.mjs" --repo "<path-to-repo>" --dry-run
```

The `--dry-run` summary reports per repository:
- Active branch, working tree cleanliness, and sync disposition (`up to date`, `ready to sync`, or `skip` reason)
- Active branch vs. `main`/`origin/main` (`X ahead, Y behind`) when on a non-`main` branch
- Latest SemVer tag locally vs. on GitHub (via Git's native `versionsort.suffix=-`)
- Exact `main` status vs. GitHub (`in-sync`, `X behind`, `Y ahead`, `X ahead, Y behind (diverged)`, `behind (unfetched on GitHub)`, or missing)
- Open branches (plus `[worktree]` annotations for branches checked out in sibling worktrees)
- Prunable branches already merged into `main` (safe `git branch -d`) vs. `[gone]` branches whose remote was deleted on GitHub (likely squash-merged; flagged for manual `git -C <repo> branch -D <branch>` review)
- A tailored **Suggested Sync Plan** (including `fetch origin main:main` + `rebase main` steps when an active branch is behind `main`)

### Presentation Format
Present **one compact vertical key-value table per repository** (headings down the left column, repo name in the top header cell with no `Field | Status` row—never a wide multi-repo table), followed by the **Suggested Sync Plan**:

```markdown
| `<repo>` | |
| :--- | :--- |
| **Branch** | `<branch>` (clean / dirty) |
| **Branch vs `main`** | X ahead, Y behind *(omit if on `main`)* |
| **`main` vs GitHub** | in-sync / X behind / Y ahead |
| **Latest tag** | local / github |
| **Open branches** | ... |
| **Prunable (`-d`)** | ... |
| **Remote gone (`-D` review)** | ... |
| **Action** | ... |
```

## 2. Execute Only After Approval
Because syncing checks out `main`, fast-forwards, refreshes local tags, and deletes merged branches, **never run without `--dry-run` until the user says `"Execute git commands"`**:

```bash
node "<skill-dir>/scripts/sync.mjs" --all
```

## Safety Guards & What `sync.mjs` Does Per Repo
- **Auto-skips unsafe repos:** Repositories with a dirty working tree, an active unmerged branch checked out, an `ahead`/`diverged` local `main`, or a missing local/remote `main` are bypassed safely with a note.
- **For ready repos:**
  1. `git fetch origin --tags --force --prune --prune-tags` (syncs branches/tags and prunes deleted remote tags/refs in one pass)
  2. `git checkout main` (when on a merged/`[gone]` branch) and `git pull --ff-only origin main`
  3. Deletes local branches already merged into `main` via `git branch -d` (excluding `main`, the current branch, and sibling worktree branches)
  4. Prints manual `git -C <repo> branch -D <branch>` commands for any remaining `[gone]` branches (never auto-force-deletes with `-D`)
