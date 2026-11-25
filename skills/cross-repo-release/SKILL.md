---
name: cross-repo-release
description: >-
  Use when developing changes in ingress-events-core that are consumed by
  iitc-plugin-site-observer or ingress-shards.github.io, or when releasing a
  new core version to consumers.
---

# Cross-Repo Development & Release Flow

`ingress-events-core` is published to GitHub Packages (`https://npm.pkg.github.com`) via `semantic-release` on `main`. Consumers must keep strict SemVer dependencies—never commit Yarn `portal:` or local file links.

## 1. Local Iteration (No Registry Publish Needed)
1. Build `ingress-events-core`:
   ```bash
   yarn --cwd ingress-events-core build
   ```
   `yarn build` automatically runs `scripts/sync-to-siblings.js`, copying `dist/` and `package.json` into sibling `node_modules/@ingress-shards/ingress-events-core` folders and clearing build caches.
2. Validate affected consumers locally:
   - `yarn --cwd iitc-plugin-site-observer validate`
   - `npm --prefix ingress-shards.github.io run validate`

## 2. Releasing `ingress-events-core`
1. Run `yarn --cwd ingress-events-core validate`.
2. Use `prepare-commits` to commit with Conventional Commits (`feat:` / `fix:`) and merge into `main` so GitHub Actions + `semantic-release` publish the new `@ingress-shards/ingress-events-core` version and tag.

## 3. Updating Consumers After Release
1. Note the new tag version from `ingress-events-core`.
2. Update `@ingress-shards/ingress-events-core` in `iitc-plugin-site-observer` (`yarn up`) and/or `ingress-shards.github.io` (`npm install @ingress-shards/ingress-events-core@^<version>`).
3. Run each consumer's `validate` script and prepare commits via `prepare-commits`.
4. Run `post-release-sync` once merges finish.
