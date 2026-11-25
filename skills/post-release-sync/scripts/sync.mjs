import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_REPOS = [
  'ingress-events-core',
  'iitc-plugin-site-observer',
  'ingress-shards.github.io'
];

function parseArgs(argv) {
  const repos = [];
  let all = false;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--all') {
      all = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--repo') {
      const target = argv[i + 1];
      if (!target || target.startsWith('-')) {
        throw new Error('--repo requires a repository path');
      }
      repos.push(resolve(target));
      i++;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (all) {
    const scriptDir = dirname(fileURLToPath(import.meta.url));
    const hasAnyRepo = (dir) => DEFAULT_REPOS.some((name) => existsSync(resolve(dir, name)));
    const cwd = process.cwd();
    const cwdParent = dirname(cwd);

    let baseDir = resolve(scriptDir, '../../../..');
    if (hasAnyRepo(cwd)) {
      baseDir = cwd;
    } else if (hasAnyRepo(cwdParent)) {
      baseDir = cwdParent;
    }

    for (const name of DEFAULT_REPOS) {
      const candidate = resolve(baseDir, name);
      if (existsSync(resolve(candidate, '.git')) && !repos.includes(candidate)) {
        repos.push(candidate);
      }
    }
  }

  return { repos, dryRun };
}

function runGit(repoPath, args, { dryRun = false, allowFail = false } = {}) {
  const display = `git -C "${repoPath}" ${args.join(' ')}`;
  if (dryRun) {
    console.log(`[dry-run] ${display}`);
    return '';
  }

  try {
    return execFileSync('git', args, { cwd: repoPath, encoding: 'utf8' }).trim();
  } catch (error) {
    if (allowFail) {
      return '';
    }
    const message = error?.stderr?.toString().trim() || error?.message || String(error);
    throw new Error(`${display} failed: ${message}`);
  }
}

function syncRepo(repoPath, dryRun) {
  console.log(`\n=== Syncing ${repoPath} ===`);

  if (!existsSync(resolve(repoPath, '.git'))) {
    throw new Error(`Not a git repository: ${repoPath}`);
  }

  runGit(repoPath, ['fetch', 'origin', '--tags', '--prune', '--prune-tags'], { dryRun });
  runGit(repoPath, ['checkout', 'main'], { dryRun });
  runGit(repoPath, ['pull', '--ff-only'], { dryRun });

  if (dryRun) {
    console.log(`[dry-run] delete local tags in "${repoPath}" and run: git fetch origin --tags`);
    console.log(`[dry-run] prune local branches merged into main in "${repoPath}"`);
  } else {
    const tagsRaw = runGit(repoPath, ['tag', '-l'], { allowFail: true });
    const tags = tagsRaw ? tagsRaw.split(/\r?\n/).filter(Boolean) : [];
    if (tags.length > 0) {
      runGit(repoPath, ['tag', '-d', ...tags]);
    }
    runGit(repoPath, ['fetch', 'origin', '--tags']);

    const mergedRaw = runGit(repoPath, ['branch', '--merged', 'main'], { allowFail: true });
    const branches = mergedRaw
      ? mergedRaw
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith('*') && !line.startsWith('+') && line !== 'main')
      : [];
    for (const branch of branches) {
      runGit(repoPath, ['branch', '-d', branch]);
    }
  }

  runGit(repoPath, ['remote', 'prune', 'origin'], { dryRun });
}

function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[sync] ${error.message}`);
    console.error('Usage: node sync.mjs [--all] [--repo <path>] [--dry-run]');
    process.exitCode = 1;
    return;
  }

  const { repos, dryRun } = parsed;
  if (repos.length === 0) {
    console.error('Usage: node sync.mjs [--all] [--repo <path>] [--dry-run]');
    process.exitCode = 1;
    return;
  }

  for (const repoPath of repos) {
    try {
      syncRepo(repoPath, dryRun);
    } catch (error) {
      console.error(`[sync] Error in ${repoPath}:`, error.message);
      process.exitCode = 1;
    }
  }
}

main();
