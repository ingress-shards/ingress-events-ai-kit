import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIngressWorkspace } from './evaluate-command.mjs';

const ARTIFACT_FILES = ['tsconfig.tsbuildinfo', 'yarn-error.log'];
const REPO_NAMES = ['ingress-events-core', 'iitc-plugin-site-observer', 'ingress-shards.github.io'];

function resolveCandidateDirs(cwd, workspacePaths) {
  const dirs = new Set();
  const seeds = [cwd, ...(Array.isArray(workspacePaths) ? workspacePaths : [])].filter(Boolean);

  for (const seed of seeds) {
    let current = resolve(seed);
    for (let depth = 0; depth < 4; depth++) {
      dirs.add(current);
      for (const repoName of REPO_NAMES) {
        dirs.add(resolve(current, repoName));
      }
      const parent = dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }

  return [...dirs];
}

/**
 * Removes stray build artifacts (`tsconfig.tsbuildinfo`, `yarn-error.log`)
 * after `build` or `validate` commands inside Ingress Shards workspaces.
 */
export function cleanArtifactsForCommand(commandLine, { cwd = '', workspacePaths = [], targetDirs } = {}) {
  if (!commandLine || !isIngressWorkspace(cwd, workspacePaths)) {
    return [];
  }

  if (!/\b(build|validate)\b/i.test(commandLine)) {
    return [];
  }

  const dirs = Array.isArray(targetDirs) ? targetDirs : resolveCandidateDirs(cwd, workspacePaths);
  const removed = [];

  for (const dir of dirs) {
    if (!existsSync(dir)) {
      continue;
    }
    for (const artifact of ARTIFACT_FILES) {
      const targetPath = resolve(dir, artifact);
      try {
        if (existsSync(targetPath)) {
          rmSync(targetPath, { force: true });
          removed.push(targetPath);
        }
      } catch (error) {
        console.error(`[clean-artifacts] Failed to remove ${targetPath}:`, error);
      }
    }
  }

  return removed;
}

function isMainEntry() {
  if (!process.argv[1]) {
    return false;
  }
  const entry = resolve(process.argv[1]);
  const self = fileURLToPath(import.meta.url);
  return process.platform === 'win32'
    ? entry.toLowerCase() === self.toLowerCase()
    : entry === self;
}

if (isMainEntry()) {
  try {
    const raw = readFileSync(0, 'utf8');
    const input = raw ? JSON.parse(raw) : {};
    const cmd = input?.toolCall?.args?.CommandLine ?? input?.tool_input?.command ?? '';
    const cwd = input?.cwd ?? '';
    const workspacePaths = input?.workspacePaths ?? [];

    cleanArtifactsForCommand(cmd, { cwd, workspacePaths });
  } catch (error) {
    console.error('[clean-artifacts] Failed to process hook payload:', error);
  }
  process.stdout.write(JSON.stringify({}));
}
