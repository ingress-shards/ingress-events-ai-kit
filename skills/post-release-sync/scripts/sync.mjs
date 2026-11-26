import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_REPOS = [
  'ingress-events-core',
  'iitc-plugin-site-observer',
  'ingress-shards.github.io',
  'ingress-events-ai-kit'
];

function normalizePathKey(targetPath) {
  const resolved = resolve(targetPath);
  let canonical = resolved;
  try {
    if (existsSync(resolved)) canonical = realpathSync.native ? realpathSync.native(resolved) : realpathSync(resolved);
  } catch { /* fallback to resolved */ }
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

export function parseArgs(argv, { cwd = process.cwd(), scriptDir = dirname(fileURLToPath(import.meta.url)) } = {}) {
  const repos = [], seen = new Set();
  let all = false, dryRun = false;
  const addRepo = (p) => {
    const resolved = resolve(p), key = normalizePathKey(resolved);
    if (!seen.has(key)) { seen.add(key); repos.push(resolved); }
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--all') all = true;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--repo') {
      const target = argv[++i];
      if (!target || target.startsWith('-')) throw new Error('--repo requires a repository path');
      addRepo(target);
    } else throw new Error(`Unknown argument: ${arg}`);
  }

  if (all) {
    const hasRepo = (dir) => DEFAULT_REPOS.some((name) => existsSync(resolve(dir, name)));
    const baseDir = hasRepo(cwd) ? cwd : hasRepo(dirname(cwd)) ? dirname(cwd) : resolve(scriptDir, '../../../..');
    for (const name of DEFAULT_REPOS) {
      const candidate = resolve(baseDir, name);
      if (existsSync(resolve(candidate, '.git'))) addRepo(candidate);
    }
  }
  return { repos, dryRun };
}

export function runGit(repoPath, args, { allowFail = false, timeout = 15000 } = {}) {
  try {
    const stdout = execFileSync('git', args, { cwd: repoPath, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, stdout };
  } catch (error) {
    const msg = error?.stderr?.toString().trim() || error?.message || String(error);
    if (allowFail) return { ok: false, stdout: error?.stdout?.toString() || '' };
    throw new Error(`git -C "${repoPath}" ${args.join(' ')} failed: ${msg}`);
  }
}

export function parseLsRemote(output) {
  const heads = new Map();
  let latestTag = null;
  for (const line of String(output ?? '').split(/\r?\n/)) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (!sha || !ref) continue;
    if (ref.startsWith('refs/heads/')) heads.set(ref.slice(11), sha);
    else if (ref.startsWith('refs/tags/') && !ref.endsWith('^{}') && latestTag === null) latestTag = ref.slice(10);
  }
  return { heads, latestTag };
}

const gitLines = (runGitFn, repoPath, args, opts) =>
  (runGitFn(repoPath, args, { allowFail: true, ...opts }).stdout || '').split(/\r?\n/).filter(Boolean);

function revCounts(runGitFn, repoPath, left, right) {
  const res = runGitFn(repoPath, ['rev-list', '--left-right', '--count', `${left}...${right}`], { allowFail: true });
  if (!res.ok) return null;
  const [l, r] = res.stdout.trim().split(/\s+/).map(Number);
  return Number.isFinite(l) && Number.isFinite(r) ? { left: l, right: r } : null;
}

export function inspectRepo(repoPath, { runGitFn = runGit } = {}) {
  if (!existsSync(resolve(repoPath, '.git'))) throw new Error(`Not a git repository: ${repoPath}`);
  const repoName = basename(resolve(repoPath));
  const headRes = runGitFn(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true });
  if (!headRes.ok) {
    return { repoPath, repoName, valid: false, currentBranch: null, isDirty: false, dirtyCount: 0, localLatestTag: null, remoteLatestTag: null, remoteReachable: false, mainStatus: 'invalid', mainAhead: 0, mainBehind: 0, mainUnfetched: false, branchVsMain: null, openBranches: [], mergedBranches: [], goneBranches: [], otherWorktreeBranches: new Set(), disposition: 'invalid' };
  }

  const selfKey = normalizePathKey(repoPath);
  const currentBranch = headRes.stdout.trim();
  const statusLines = gitLines(runGitFn, repoPath, ['--no-optional-locks', 'status', '--porcelain']);
  const localLatestTag = gitLines(runGitFn, repoPath, ['-c', 'versionsort.suffix=-', 'tag', '--sort=-v:refname']).map((l) => l.trim())[0] ?? null;
  const mergedSet = new Set(gitLines(runGitFn, repoPath, ['branch', '--merged', 'main']).map((l) => l.replace(/^[*+]\s*/, '').trim()).filter((n) => n && n !== 'main'));
  const lsRes = runGitFn(repoPath, ['-c', 'versionsort.suffix=-', 'ls-remote', '--heads', '--tags', '--refs', '--sort=-v:refname', 'origin'], { allowFail: true, timeout: 10000 });
  const remote = lsRes.ok ? parseLsRemote(lsRes.stdout) : null;
  const branches = gitLines(runGitFn, repoPath, ['for-each-ref', '--format=%(refname:short)\t%(objectname)\t%(upstream:short)\t%(upstream:track)\t%(worktreepath)', 'refs/heads']).map((line) => {
    const [name = '', sha = '', upstream = '', track = '', wtPath = ''] = line.split('\t');
    return { name, sha, upstream, track, inOtherWorktree: Boolean(wtPath) && normalizePathKey(wtPath) !== selfKey };
  });

  const localMain = branches.find((b) => b.name === 'main');
  const remoteMainSha = remote?.heads.get('main');
  let mainStatus = 'in-sync', mainAhead = 0, mainBehind = 0, mainUnfetched = false;
  if (!localMain) mainStatus = 'missing-local-main';
  else if (!remote) mainStatus = 'unreachable';
  else if (!remoteMainSha) mainStatus = 'no-remote-main';
  else if (localMain.sha !== remoteMainSha) {
    const exact = revCounts(runGitFn, repoPath, 'main', remoteMainSha);
    if (exact) {
      ({ left: mainAhead, right: mainBehind } = exact);
      mainStatus = mainAhead && mainBehind ? `${mainAhead} ahead, ${mainBehind} behind (diverged)` : mainAhead ? `${mainAhead} ahead` : `${mainBehind} behind`;
    } else {
      mainUnfetched = true;
      const cached = revCounts(runGitFn, repoPath, 'main', 'refs/remotes/origin/main');
      mainAhead = cached?.left ?? 0; mainBehind = cached?.right ?? 0;
      mainStatus = mainAhead ? `${mainAhead} ahead + unfetched on GitHub (diverged)` : mainBehind ? `${mainBehind}+ behind (unfetched on GitHub)` : 'behind (unfetched on GitHub)';
    }
  }

  let branchVsMain = null;
  if (currentBranch !== 'main' && currentBranch !== 'HEAD' && localMain) {
    const remoteCounts = remoteMainSha ? revCounts(runGitFn, repoPath, remoteMainSha, 'HEAD') : null;
    if (remoteCounts) branchVsMain = { base: localMain.sha === remoteMainSha ? 'main' : 'origin/main', behind: remoteCounts.left, ahead: remoteCounts.right, unfetched: false };
    else {
      const localCounts = revCounts(runGitFn, repoPath, 'main', 'HEAD');
      if (localCounts) branchVsMain = { base: 'main', behind: localCounts.left, ahead: localCounts.right, unfetched: mainUnfetched };
    }
  }

  const openBranches = [], mergedBranches = [], goneBranches = [], otherWorktreeBranches = new Set();
  for (const b of branches) {
    if (b.inOtherWorktree) otherWorktreeBranches.add(b.name);
    if (b.name === 'main') continue;
    const isMerged = mergedSet.has(b.name);
    const hasOrigin = b.upstream.startsWith('origin/') || b.track.includes('gone');
    const isGone = remote ? hasOrigin && !remote.heads.has(b.name) : b.track.includes('gone');
    if (isMerged && !b.inOtherWorktree) mergedBranches.push(b);
    else if (!isMerged && !b.inOtherWorktree && isGone) goneBranches.push(b);
    else openBranches.push(b);
  }

  const canLeaveCurrent = currentBranch === 'main' || mergedBranches.some((b) => b.name === currentBranch) || goneBranches.some((b) => b.name === currentBranch);
  let disposition = 'up-to-date';
  if (statusLines.length > 0) disposition = 'skip-dirty';
  else if (mainStatus === 'missing-local-main' || mainStatus === 'no-remote-main') disposition = 'skip-no-main';
  else if (mainAhead > 0) disposition = 'skip-diverged';
  else if (!canLeaveCurrent) disposition = 'skip-active-branch';
  else if (mainBehind > 0 || mainUnfetched || (remote && remote.latestTag !== localLatestTag) || mergedBranches.length > 0 || currentBranch !== 'main') disposition = 'ready';

  return { repoPath, repoName, valid: true, currentBranch, isDirty: statusLines.length > 0, dirtyCount: statusLines.length, localLatestTag, remoteLatestTag: remote?.latestTag ?? null, remoteReachable: Boolean(remote), mainStatus, mainAhead, mainBehind, mainUnfetched, branchVsMain, openBranches, mergedBranches, goneBranches, otherWorktreeBranches, disposition };
}

const fmtBranches = (list, markWorktree = false) => list.length ? list.map((b) => (markWorktree && b.inOtherWorktree ? `${b.name} [worktree]` : b.name)).join(', ') : 'none';

export function formatSummary(reports, { dryRun = true, scriptPath = '' } = {}) {
  const pre = dryRun ? '[dry-run] ' : '';
  const lines = [`${pre}Workspace Summary (${reports.length} repo${reports.length === 1 ? '' : 's'})`];
  for (const r of reports) {
    lines.push(`\n=== ${r.repoName} (${r.repoPath}) ===`);
    if (!r.valid) { lines.push(`${pre}Status: skip (uninitialized git metadata)`); continue; }
    const label = r.disposition === 'up-to-date' ? 'up to date' : r.disposition === 'ready' ? 'ready to sync' : r.disposition === 'skip-dirty' ? 'skip (dirty working tree)' : r.disposition === 'skip-no-main' ? `skip (${r.mainStatus})` : r.disposition === 'skip-diverged' ? `skip (main ${r.mainStatus})` : `skip (active branch "${r.currentBranch}")`;
    lines.push(`${pre}Branch: ${r.currentBranch} (${r.isDirty ? `dirty: ${r.dirtyCount}` : 'clean'}) -> ${label}`);
    if (r.branchVsMain) lines.push(`${pre}Branch vs ${r.branchVsMain.base}: ${r.branchVsMain.ahead} ahead, ${r.branchVsMain.behind} behind${r.branchVsMain.unfetched ? ' (+ unfetched on GitHub)' : ''}`);
    lines.push(`${pre}Latest tag: local=${r.localLatestTag ?? 'none'}, github=${r.remoteReachable ? (r.remoteLatestTag ?? 'none') : 'unreachable'}`);
    lines.push(`${pre}main vs GitHub: ${r.mainStatus}`);
    lines.push(`${pre}Open branches: ${fmtBranches(r.openBranches, true)}`);
    lines.push(`${pre}Prunable (merged, -d): ${fmtBranches(r.mergedBranches)}`);
    lines.push(`${pre}Remote gone (review -D): ${fmtBranches(r.goneBranches)}`);
  }

  const ready = reports.filter((r) => r.disposition === 'ready');
  const skipped = reports.filter((r) => r.disposition.startsWith('skip-'));
  const upToDate = reports.filter((r) => r.disposition === 'up-to-date');
  lines.push('\n=== Suggested Sync Plan ===', `Up to date: ${upToDate.length ? upToDate.map((r) => r.repoName).join(', ') : 'none'}`, `Ready to sync: ${ready.length ? ready.map((r) => r.repoName).join(', ') : 'none'}`);
  if (ready.length > 0) {
    const cmd = scriptPath ? `node "${scriptPath}"` : 'node "<skill-dir>/scripts/sync.mjs"';
    if (skipped.length === 0) lines.push(`  Run: ${cmd} --all`);
    else ready.forEach((r) => lines.push(`  Run: ${cmd} --repo "${r.repoPath}"`));
  }
  if (skipped.length > 0) {
    lines.push('Skipped:');
    for (const r of skipped) {
      if (r.disposition === 'skip-dirty') lines.push(`  - ${r.repoName}: dirty working tree — commit or stash changes before syncing`);
      else if (r.disposition === 'skip-active-branch') {
        if (r.mainBehind > 0 || r.mainUnfetched) {
          lines.push(`  - ${r.repoName}: active branch "${r.currentBranch}" is behind ${r.branchVsMain?.base ?? 'origin/main'} — update main & rebase:`);
          lines.push(`      git -C ${r.repoName} fetch origin main:main`, `      git -C ${r.repoName} rebase main`);
        } else if (r.branchVsMain?.behind > 0) {
          lines.push(`  - ${r.repoName}: active branch "${r.currentBranch}" is ${r.branchVsMain.behind} behind main — rebase via: git -C ${r.repoName} rebase main`);
        } else lines.push(`  - ${r.repoName}: active unmerged branch "${r.currentBranch}"`);
      } else lines.push(`  - ${r.repoName}: ${r.mainStatus}`);
    }
  }
  const goneCmds = reports.flatMap((r) => r.goneBranches.map((b) => `git -C ${r.repoName} branch -D ${b.name}`));
  if (goneCmds.length > 0) lines.push('Manual squash-merge cleanup (review before running):', ...goneCmds.map((c) => `  ${c}`));
  return lines.join('\n');
}

function logGoneNotes(repoPath, report, runGitFn, log) {
  for (const b of report.goneBranches) {
    if (runGitFn(repoPath, ['rev-parse', '--verify', `refs/heads/${b.name}`], { allowFail: true }).ok) {
      log(`[note] Remote deleted "${b.name}" (likely squash-merged). Review: git -C ${report.repoName} branch -D ${b.name}`);
    }
  }
}

export function syncRepo(repoPath, { dryRun = false, runGitFn = runGit, log = console.log } = {}) {
  const report = inspectRepo(repoPath, { runGitFn });
  if (dryRun) return { report, skipped: false };
  log(`\n=== Syncing ${report.repoName} (${repoPath}) ===`);
  if (!report.valid || report.disposition.startsWith('skip-')) { log(`[skip] ${report.repoName}: ${report.disposition}`); return { report, skipped: true }; }
  if (report.disposition === 'up-to-date') { log(`[up-to-date] ${report.repoName}: already in sync`); logGoneNotes(repoPath, report, runGitFn, log); return { report, skipped: false }; }

  runGitFn(repoPath, ['fetch', 'origin', '--tags', '--force', '--prune', '--prune-tags']);
  if (report.currentBranch !== 'main') runGitFn(repoPath, ['checkout', 'main']);
  runGitFn(repoPath, ['pull', '--ff-only', 'origin', 'main']);
  for (const branch of gitLines(runGitFn, repoPath, ['branch', '--merged', 'main']).map((l) => l.trim()).filter((l) => !l.startsWith('*') && !l.startsWith('+') && l !== 'main' && !report.otherWorktreeBranches.has(l))) {
    runGitFn(repoPath, ['branch', '-d', branch]);
  }
  logGoneNotes(repoPath, report, runGitFn, log);
  return { report, skipped: false };
}

function main() {
  const scriptPath = fileURLToPath(import.meta.url);
  let parsed;
  try { parsed = parseArgs(process.argv.slice(2), { scriptDir: dirname(scriptPath) }); }
  catch (error) { console.error(`[sync] ${error.message}\nUsage: node sync.mjs [--all] [--repo <path>] [--dry-run]`); process.exitCode = 1; return; }
  if (parsed.repos.length === 0) { console.error('Usage: node sync.mjs [--all] [--repo <path>] [--dry-run]'); process.exitCode = 1; return; }

  if (parsed.dryRun) {
    const reports = [];
    for (const repo of parsed.repos) {
      try { reports.push(inspectRepo(repo)); } catch (err) { console.error(`[sync] Error inspecting ${repo}:`, err.message); process.exitCode = 1; }
    }
    if (reports.length > 0) console.log(formatSummary(reports, { dryRun: true, scriptPath }));
    return;
  }
  for (const repo of parsed.repos) {
    try { syncRepo(repo, { dryRun: false }); } catch (err) { console.error(`[sync] Error in ${repo}:`, err.message); process.exitCode = 1; }
  }
}

if (process.argv[1] && normalizePathKey(process.argv[1]) === normalizePathKey(fileURLToPath(import.meta.url))) main();
