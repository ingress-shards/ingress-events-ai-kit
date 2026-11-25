import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const UMBRELLA_AGENTS_MD = `# Ingress Shards — Workspace Directory

This folder is a local umbrella directory grouping four independent sibling Git repositories:
1. \`ingress-events-core\` — Shared TypeScript library & visual assets (Yarn 4)
2. \`iitc-plugin-site-observer\` — IITC userscript plugin (Yarn 4)
3. \`ingress-shards.github.io\` — Interactive shard map web app (NPM)
4. \`ingress-events-ai-kit\` — Shared AI rules, skills, and command guardrails (Node ESM, zero deps)

Shared coding standards, on-demand skills, and command guardrail hooks live in \`ingress-events-ai-kit\` (registered via \`~/.gemini/config/plugins.json\`), alongside each repository's own \`AGENTS.md\`.

Before editing files in a sub-repository, read \`<repo>/AGENTS.md\` for repo-specific stack, typing, and naming conventions (workspace rule discovery walks up, not down into child repos).

## Project Dispatch From Workspace Root
Use static project-targeting flags instead of \`cd <dir> && ...\` chaining:
- \`ingress-events-core\`: \`yarn --cwd ingress-events-core <command>\`
- \`iitc-plugin-site-observer\`: \`yarn --cwd iitc-plugin-site-observer <command>\`
- \`ingress-shards.github.io\`: \`npm --prefix ingress-shards.github.io <command>\`
- \`ingress-events-ai-kit\`: \`npm --prefix ingress-events-ai-kit <command>\`
- Git inspection: \`git -C <repo> <command>\`
`;

/**
 * Reads Yarn `packageManager` and `yarnPath` from sibling `ingress-events-core`.
 */
export function readCoreYarnConfig(targetDir) {
  const coreDir = join(resolve(targetDir), 'ingress-events-core');
  let packageManager = null;
  let yarnPath = null;

  const corePkgPath = join(coreDir, 'package.json');
  if (existsSync(corePkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(corePkgPath, 'utf8'));
      if (typeof pkg.packageManager === 'string' && pkg.packageManager.trim()) {
        packageManager = pkg.packageManager.trim();
      }
    } catch (error) {
      console.error(`[init-umbrella] Failed to parse ${corePkgPath}:`, error);
    }
  }

  const coreYarnrcPath = join(coreDir, '.yarnrc.yml');
  if (existsSync(coreYarnrcPath)) {
    try {
      const yarnrc = readFileSync(coreYarnrcPath, 'utf8');
      const match = yarnrc.match(/^yarnPath:\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))/m);
      const raw = match?.[1] ?? match?.[2] ?? match?.[3];
      const cleaned = raw?.trim().replace(/\\/g, '/').replace(/^\.\//, '');
      if (cleaned) yarnPath = cleaned;
    } catch (error) {
      console.error(`[init-umbrella] Failed to read ${coreYarnrcPath}:`, error);
    }
  }

  return { packageManager, yarnPath };
}

/**
 * Writes local-only umbrella workspace shims (`package.json`, `.yarnrc.yml`, `AGENTS.md`)
 * into `targetDir`, skipping existing files unless `force` is true.
 */
export function initUmbrella({ targetDir, force = false, dryRun = false } = {}) {
  if (!targetDir) throw new Error('targetDir is required');
  const resolvedTarget = resolve(targetDir);
  const { packageManager, yarnPath } = readCoreYarnConfig(resolvedTarget);
  const warnings = [];
  const pkgJson = { name: 'ingress-shards-umbrella', private: true, ...(packageManager ? { packageManager } : {}) };
  const files = [
    { name: 'package.json', content: `${JSON.stringify(pkgJson, null, 2)}\n` },
    { name: 'AGENTS.md', content: UMBRELLA_AGENTS_MD }
  ];

  if (yarnPath) {
    files.splice(1, 0, { name: '.yarnrc.yml', content: `yarnPath: ingress-events-core/${yarnPath}\nnodeLinker: node-modules\n` });
  } else {
    warnings.push('Skipped .yarnrc.yml because sibling ingress-events-core/.yarnrc.yml (yarnPath) was not found.');
  }
  if (!packageManager) {
    warnings.push('Omitted packageManager in package.json because no valid packageManager was found in sibling ingress-events-core/package.json.');
  }
  if (!dryRun && !existsSync(resolvedTarget)) {
    mkdirSync(resolvedTarget, { recursive: true });
  }

  const written = [];
  const skipped = [];
  const planned = [];
  for (const file of files) {
    const dest = join(resolvedTarget, file.name);
    if (existsSync(dest) && !force) {
      skipped.push(dest);
    } else if (dryRun) {
      planned.push(dest);
    } else {
      try {
        writeFileSync(dest, file.content, 'utf8');
        written.push(dest);
      } catch (error) {
        console.error(`[init-umbrella] Failed to write ${dest}:`, error);
        throw error;
      }
    }
  }
  return { targetDir: resolvedTarget, written, skipped, planned, warnings };
}

function parseCliArgs(argv) {
  let targetDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  let force = false;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--force') force = true;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg.startsWith('--dir=')) {
      const value = arg.slice(6);
      if (!value) throw new Error('--dir requires a directory path');
      targetDir = resolve(value);
    } else if (arg === '--dir') {
      const next = argv[i + 1];
      if (!next || next.startsWith('-')) throw new Error('--dir requires a directory path');
      targetDir = resolve(next);
      i++;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { targetDir, force, dryRun };
}

const entry = process.argv[1] ? resolve(process.argv[1]) : '';
const self = fileURLToPath(import.meta.url);
if (entry && (process.platform === 'win32' ? entry.toLowerCase() === self.toLowerCase() : entry === self)) {
  try {
    const result = initUmbrella(parseCliArgs(process.argv.slice(2)));
    for (const file of result.planned) console.log(`[dry-run] Would write: ${file}`);
    for (const file of result.written) console.log(`Wrote: ${file}`);
    for (const file of result.skipped) console.log(`Skipped (already exists): ${file}`);
    for (const warning of result.warnings) console.warn(`Warning: ${warning}`);
  } catch (error) {
    console.error(`[init-umbrella] ${error.message}`);
    console.error('Usage: node scripts/init-umbrella.mjs [--dir <path>] [--dry-run] [--force]');
    process.exitCode = 1;
  }
}
