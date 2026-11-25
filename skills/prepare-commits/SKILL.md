---
name: prepare-commits
description: >-
  Use when the user says "Prepare git commits" or asks to draft conventional
  commits for semantic-release across ingress-events-core,
  iitc-plugin-site-observer, or ingress-shards.github.io.
---

# Prepare Git Commits

## 1. Pre-Flight Verification
Before drafting any commits, confirm the workspace is clean and validated:
1. Ensure local validation (`yarn --cwd <repo> validate` or `npm --prefix <repo> run validate`) has passed after the last edit.
2. Check for leftover build artifacts (`tsconfig.tsbuildinfo`, `yarn-error.log`) and remove them if present.
3. Inspect pending changes using `git -C <repo> status -s` and `git -C <repo> diff` (never pass ad-hoc file paths to `git diff`).
4. Fetch and check the current released version via git tags: `git -C <repo> fetch --tags` then `git -C <repo> tag --sort=-v:refname` (never edit `"version": "0.0.0-semantically-released"` in `package.json`).

## 2. Conventional Commits (`semantic-release`)
Versions are determined strictly from commit messages on `main`:
- `feat:` → **minor** bump (`1.16.0` → `1.17.0`)
- `fix:` → **patch** bump (`1.16.0` → `1.16.1`)
- `refactor:`, `ci:`, `docs(README):` → **patch** bump (per repo `release.config.cjs`)
- `BREAKING CHANGE:` in commit footer → **major** bump (`1.16.0` → `2.0.0`)
- Other `docs:`, `chore:`, `test:`, `style:` → no release bump unless paired with a releasing type

## 3. Branch & PR Strategy
- `main` is the **only** branch that publishes releases and deployments.
- Feature/fix branches and pull requests trigger CI validation checks only; prerelease/alpha versions are never published.
- Pull requests generate a downloadable `dist` build artifact in GitHub Actions for verification (`npm run preview` or `yarn run preview` where applicable).

## 4. Output Format
Present an implementation plan containing:
1. Logical commit groups (one handshake may split into multiple atomic commits).
2. Exact proposed commit message(s) (subject + body/footer where needed).
3. Exact `git -C <repo> add` and `git -C <repo> commit` (and `push` if requested) commands to run.

Do **not** execute any mutating git commands until the user explicitly replies **"Execute git commands"**.
