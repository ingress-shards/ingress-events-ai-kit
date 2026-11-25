import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { cleanArtifactsForCommand } from '../scripts/clean-artifacts.mjs';
import { evaluateCommand, isIngressWorkspace } from '../scripts/evaluate-command.mjs';
import { initUmbrella } from '../scripts/init-umbrella.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = resolve(TEST_DIR, '..');

const FAKE_UMBRELLA_WIN = 'C:\\dev\\ingress-shards';
const FAKE_UMBRELLA_POSIX = '/workspace/ingress-shards';
const CORE_CWD = `${FAKE_UMBRELLA_WIN}\\ingress-events-core`;
const OBSERVER_CWD = `${FAKE_UMBRELLA_WIN}\\iitc-plugin-site-observer`;
const MAP_CWD = `${FAKE_UMBRELLA_WIN}\\ingress-shards.github.io`;
const KIT_CWD = '/workspace/tools/ingress-events-ai-kit';
const UNRELATED_CWD = '/workspace/unrelated-app';

test('isIngressWorkspace matches Ingress repos, arbitrary parent folders with product repos, and ignores unrelated projects', () => {
  assert.equal(isIngressWorkspace(FAKE_UMBRELLA_WIN), true);
  assert.equal(isIngressWorkspace(FAKE_UMBRELLA_POSIX), true);
  assert.equal(isIngressWorkspace(CORE_CWD), true);
  assert.equal(isIngressWorkspace(OBSERVER_CWD), true);
  assert.equal(isIngressWorkspace(MAP_CWD), true);
  assert.equal(isIngressWorkspace('', [KIT_CWD]), true);
  assert.equal(isIngressWorkspace(UNRELATED_CWD, [UNRELATED_CWD]), false);

  const customParent = mkdtempSync(join(tmpdir(), 'custom-dev-'));
  try {
    mkdirSync(join(customParent, 'ingress-events-core'));
    assert.equal(isIngressWorkspace(customParent), true);
  } finally {
    rmSync(customParent, { recursive: true, force: true });
  }
});

test('passes through commands in unrelated workspaces', () => {
  const result = evaluateCommand('Get-ChildItem && git push', {
    cwd: UNRELATED_CWD,
    workspacePaths: [UNRELATED_CWD]
  });
  assert.equal(result.action, 'ask');
});

test('denies shell commands referencing .secrets', () => {
  for (const cmd of ['git add .secrets', 'echo .secrets', 'node script.mjs .secrets', 'echo x>.secrets', 'sort <.secrets']) {
    const result = evaluateCommand(cmd, { cwd: FAKE_UMBRELLA_WIN });
    assert.equal(result.action, 'deny', `Expected deny for: ${cmd}`);
  }
});

test('denies PowerShell cmdlets including Set-Location', () => {
  for (const cmd of ['Get-ChildItem src', 'dir | Select-String foo', 'Test-Path package.json', 'Set-Location ingress-events-core']) {
    const result = evaluateCommand(cmd, { cwd: FAKE_UMBRELLA_WIN });
    assert.equal(result.action, 'deny', `Expected deny for: ${cmd}`);
  }
});

test('denies shell file-inspection commands, inline node -e/-p, and piped bypasses', () => {
  for (const cmd of [
    'cat package.json',
    'head -n 20 README.md',
    'sed -n "1,10p" package.json',
    'type package.json',
    'node -e "console.log(1)"',
    'node -p "1"',
    'node -pe "1"',
    'node --eval="console.log(1)"',
    'node -r dotenv/config -e "console.log(1)"',
    'node --input-type=module -e "console.log(1)"',
    'echo ok && node --eval "console.log(1)"',
    'git status | head -n 5',
    'yes | node -e "console.log(1)"',
    'echo ok\nnode -p "1"'
  ]) {
    const result = evaluateCommand(cmd, { cwd: FAKE_UMBRELLA_WIN });
    assert.equal(result.action, 'deny', `Expected deny for: ${cmd}`);
  }
  assert.equal(evaluateCommand('type-check', { cwd: FAKE_UMBRELLA_WIN }).action, 'ask');
});

test('denies git diff with file or path arguments while allowing flag-only git diff', () => {
  const denied = [
    'git diff README.md',
    'git -C ingress-events-core diff src/index.ts',
    'git diff --stat package.json',
    'git diff -- README.md'
  ];
  for (const cmd of denied) {
    assert.equal(evaluateCommand(cmd, { cwd: FAKE_UMBRELLA_WIN }).action, 'deny', `Expected deny for: ${cmd}`);
  }

  assert.equal(evaluateCommand('git -C ingress-events-core diff --stat', { cwd: FAKE_UMBRELLA_WIN }).action, 'allow');

  const asked = [
    'git diff',
    'git -C ingress-events-core diff',
    'git diff --staged',
    'git diff --cached',
    'git diff --name-only'
  ];
  for (const cmd of asked) {
    assert.equal(evaluateCommand(cmd, { cwd: FAKE_UMBRELLA_WIN }).action, 'ask', `Expected ask for: ${cmd}`);
  }
});

test('denies local Docker validation and chained cd commands (leading or piped)', () => {
  assert.equal(evaluateCommand('yarn --cwd ingress-events-core validate:docker', { cwd: FAKE_UMBRELLA_WIN }).action, 'deny');
  assert.equal(evaluateCommand('docker build .', { cwd: FAKE_UMBRELLA_WIN }).action, 'deny');
  assert.equal(evaluateCommand('cd ingress-events-core && yarn validate', { cwd: FAKE_UMBRELLA_WIN }).action, 'deny');
  assert.equal(evaluateCommand('cd ingress-events-core; yarn validate', { cwd: FAKE_UMBRELLA_WIN }).action, 'deny');
  assert.equal(evaluateCommand('echo ok && cd ingress-events-core && yarn validate', { cwd: FAKE_UMBRELLA_WIN }).action, 'deny');
});

test('denies cross-stack npm and yarn mixups while allowing @ingress-shards/ingress-events-core installs in map app', () => {
  assert.equal(evaluateCommand('npm --prefix ingress-events-core test', { cwd: FAKE_UMBRELLA_WIN }).action, 'deny');
  assert.equal(evaluateCommand('npm --prefix iitc-plugin-site-observer run validate', { cwd: FAKE_UMBRELLA_WIN }).action, 'deny');
  assert.equal(evaluateCommand('npm test', { cwd: CORE_CWD }).action, 'deny');
  assert.equal(evaluateCommand('npm run validate', { cwd: OBSERVER_CWD }).action, 'deny');
  assert.equal(evaluateCommand('echo | npm --prefix ingress-events-core test', { cwd: FAKE_UMBRELLA_WIN }).action, 'deny');

  assert.equal(evaluateCommand('yarn --cwd ingress-shards.github.io validate', { cwd: FAKE_UMBRELLA_WIN }).action, 'deny');
  assert.equal(evaluateCommand('yarn validate', { cwd: MAP_CWD }).action, 'deny');

  assert.equal(
    evaluateCommand('npm install @ingress-shards/ingress-events-core@^0.9.1', { cwd: MAP_CWD }).action,
    'ask'
  );
  assert.equal(
    evaluateCommand('npm --prefix ingress-shards.github.io install @ingress-shards/ingress-events-core@^0.9.1', {
      cwd: FAKE_UMBRELLA_WIN
    }).action,
    'ask'
  );
});

test('auto-allows exact known-safe single commands while keeping chained or non-allowlisted commands as ask', () => {
  const autoAllowed = [
    { cmd: 'yarn --cwd ingress-events-core validate', cwd: FAKE_UMBRELLA_WIN },
    { cmd: 'corepack yarn --cwd iitc-plugin-site-observer validate', cwd: FAKE_UMBRELLA_WIN },
    { cmd: 'npm --prefix ingress-shards.github.io run validate', cwd: FAKE_UMBRELLA_WIN },
    { cmd: 'npm --prefix ingress-events-ai-kit test', cwd: FAKE_UMBRELLA_WIN },
    { cmd: 'git -C ingress-events-core status -s', cwd: FAKE_UMBRELLA_WIN },
    { cmd: 'git -C ingress-events-core diff --stat', cwd: FAKE_UMBRELLA_WIN },
    { cmd: 'node --test', cwd: KIT_CWD },
    { cmd: 'yarn validate', cwd: CORE_CWD },
    { cmd: 'npm run validate', cwd: MAP_CWD }
  ];

  for (const { cmd, cwd } of autoAllowed) {
    const result = evaluateCommand(cmd, { cwd });
    assert.equal(result.action, 'allow', `Expected allow for: ${cmd}`);
  }

  const stillAsk = [
    { cmd: 'yarn --cwd ingress-events-core validate && echo ok', cwd: FAKE_UMBRELLA_WIN },
    { cmd: 'yarn --cwd ingress-events-core build', cwd: FAKE_UMBRELLA_WIN },
    { cmd: 'npm --prefix ingress-shards.github.io run prepare:data', cwd: FAKE_UMBRELLA_WIN }
  ];

  for (const { cmd, cwd } of stillAsk) {
    const result = evaluateCommand(cmd, { cwd });
    assert.equal(result.action, 'ask', `Expected ask for: ${cmd}`);
  }
});

test('strict read-only git allowlist flags non-read-only commands (including wrappers and pipes) with force_ask', () => {
  const nonReadOnly = [
    'git -C ingress-events-core commit -m "feat: add ornament"',
    'git -C ingress-events-core push origin main',
    'git -C ingress-events-core pull --ff-only',
    'git -C ingress-events-core add .',
    'git -C ingress-events-core rm foo.ts',
    'git -C ingress-events-core mv a.ts b.ts',
    'git -C ingress-events-core restore foo.ts',
    'git -C ingress-events-core checkout main',
    'git -C ingress-events-core checkout -b feat/new',
    'git -C ingress-events-core switch main',
    'git -C ingress-events-core switch -c feat/new',
    'git -C iitc-plugin-site-observer merge feature/test',
    'git -C ingress-shards.github.io rebase main',
    'git -C ingress-events-core reset --hard HEAD',
    'git -C ingress-events-core tag -d v1.0.0',
    'git -C ingress-events-core tag v1.0.1',
    'git -C ingress-events-core branch -D old-branch',
    'git -C ingress-events-core branch -l feat-reflog',
    'git -C ingress-events-core branch new-feat',
    'git -C ingress-events-core remote prune origin',
    'git -C ingress-events-core remote -v update',
    'git init',
    'git -C ingress-events-core stash pop',
    'echo ok | git push',
    'git.exe commit -m "x"',
    '/usr/bin/git push',
    'FOO=1 git push',
    'env -i git push',
    'git config --show-origin user.name val'
  ];

  for (const cmd of nonReadOnly) {
    const result = evaluateCommand(cmd, { cwd: FAKE_UMBRELLA_WIN });
    assert.equal(result.action, 'force_ask', `Expected force_ask for: ${cmd}`);
  }

  const readOnly = [
    'git -C ingress-events-core diff',
    'git -C ingress-events-core log -n 5',
    'git -C ingress-events-core show --stat',
    'git -C ingress-events-core fetch origin --tags',
    'git -C ingress-events-core grep foo',
    'git -C ingress-events-core rev-parse HEAD',
    'git -C ingress-events-core branch',
    'git -C ingress-events-core branch -a',
    'git -C ingress-events-core branch --list',
    'git -C ingress-events-core branch --merged main',
    'git -C ingress-events-core branch --show-current',
    'git -C ingress-events-core tag --list',
    'git -C ingress-events-core tag -l',
    'git -C ingress-events-core tag --sort=-v:refname',
    'git -C ingress-events-core stash list',
    'git -C ingress-events-core remote -v'
  ];

  for (const cmd of readOnly) {
    const result = evaluateCommand(cmd, { cwd: FAKE_UMBRELLA_WIN });
    assert.equal(result.action, 'ask', `Expected ask for read-only git: ${cmd}`);
  }
});

test('sync.mjs requires force_ask without --dry-run (even piped) and passes through with --dry-run', () => {
  assert.equal(
    evaluateCommand('node "/tools/skills/post-release-sync/scripts/sync.mjs" --all --dry-run', {
      cwd: FAKE_UMBRELLA_POSIX
    }).action,
    'ask'
  );
  assert.equal(
    evaluateCommand('node "/tools/skills/post-release-sync/scripts/sync.mjs" --all', {
      cwd: FAKE_UMBRELLA_POSIX
    }).action,
    'force_ask'
  );
  assert.equal(
    evaluateCommand('echo ok | node "/tools/skills/post-release-sync/scripts/sync.mjs" --all', {
      cwd: FAKE_UMBRELLA_POSIX
    }).action,
    'force_ask'
  );
});

test('guard-antigravity.mjs emits valid Antigravity PreToolUse JSON', () => {
  const script = resolve(KIT_ROOT, 'scripts/guard-antigravity.mjs');

  const denyOut = JSON.parse(
    execFileSync('node', [script], {
      input: JSON.stringify({
        cwd: FAKE_UMBRELLA_WIN,
        workspacePaths: [FAKE_UMBRELLA_WIN],
        toolCall: { args: { CommandLine: 'Get-ChildItem' } }
      }),
      encoding: 'utf8'
    })
  );
  assert.equal(denyOut.decision, 'deny');
  assert.ok(denyOut.reason);

  const forceAskOut = JSON.parse(
    execFileSync('node', [script], {
      input: JSON.stringify({
        cwd: FAKE_UMBRELLA_WIN,
        toolCall: { args: { CommandLine: 'git -C ingress-events-core commit -m "fix: bug"' } }
      }),
      encoding: 'utf8'
    })
  );
  assert.equal(forceAskOut.decision, 'force_ask');

  const allowOut = JSON.parse(
    execFileSync('node', [script], {
      input: JSON.stringify({
        cwd: FAKE_UMBRELLA_WIN,
        toolCall: { args: { CommandLine: 'yarn --cwd ingress-events-core validate' } }
      }),
      encoding: 'utf8'
    })
  );
  assert.deepEqual(allowOut, { decision: 'allow' });

  const askOut = JSON.parse(
    execFileSync('node', [script], {
      input: JSON.stringify({
        cwd: FAKE_UMBRELLA_WIN,
        toolCall: { args: { CommandLine: 'yarn --cwd ingress-events-core build' } }
      }),
      encoding: 'utf8'
    })
  );
  assert.deepEqual(askOut, { decision: 'ask' });
});

test('guard-claude.mjs emits valid Claude Code PreToolUse JSON', () => {
  const script = resolve(KIT_ROOT, 'scripts/guard-claude.mjs');

  const denyOut = JSON.parse(
    execFileSync('node', [script], {
      input: JSON.stringify({
        cwd: FAKE_UMBRELLA_WIN,
        tool_input: { command: 'yarn --cwd ingress-shards.github.io validate' }
      }),
      encoding: 'utf8'
    })
  );
  assert.equal(denyOut.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(denyOut.hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(denyOut.hookSpecificOutput.permissionDecisionReason);

  const askOut = JSON.parse(
    execFileSync('node', [script], {
      input: JSON.stringify({
        cwd: FAKE_UMBRELLA_WIN,
        tool_input: { command: 'git -C ingress-events-core push' }
      }),
      encoding: 'utf8'
    })
  );
  assert.equal(askOut.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(askOut.hookSpecificOutput.permissionDecision, 'ask');

  const allowOut = JSON.parse(
    execFileSync('node', [script], {
      input: JSON.stringify({
        cwd: FAKE_UMBRELLA_WIN,
        tool_input: { command: 'npm --prefix ingress-shards.github.io run validate' }
      }),
      encoding: 'utf8'
    })
  );
  assert.deepEqual(allowOut, {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow'
    }
  });

  const passOut = JSON.parse(
    execFileSync('node', [script], {
      input: JSON.stringify({
        cwd: FAKE_UMBRELLA_WIN,
        tool_input: { command: 'npm --prefix ingress-shards.github.io run build' }
      }),
      encoding: 'utf8'
    })
  );
  assert.deepEqual(passOut, {});
});

test('clean-artifacts.mjs removes build artifacts only on build/validate inside Ingress workspaces', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'ingress-clean-test-'));
  try {
    const tsBuildInfo = join(tempDir, 'tsconfig.tsbuildinfo');
    const yarnErrorLog = join(tempDir, 'yarn-error.log');
    writeFileSync(tsBuildInfo, '{}');
    writeFileSync(yarnErrorLog, 'err');

    assert.deepEqual(
      cleanArtifactsForCommand('git status -s', { cwd: FAKE_UMBRELLA_WIN, targetDirs: [tempDir] }),
      []
    );
    assert.equal(existsSync(tsBuildInfo), true);
    assert.equal(existsSync(yarnErrorLog), true);

    assert.deepEqual(
      cleanArtifactsForCommand('yarn validate', {
        cwd: UNRELATED_CWD,
        targetDirs: [tempDir]
      }),
      []
    );
    assert.equal(existsSync(tsBuildInfo), true);

    const removed = cleanArtifactsForCommand('yarn --cwd ingress-events-core validate', {
      cwd: FAKE_UMBRELLA_WIN,
      targetDirs: [tempDir]
    });
    assert.equal(removed.length, 2);
    assert.equal(existsSync(tsBuildInfo), false);
    assert.equal(existsSync(yarnErrorLog), false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('manifests parse cleanly, standards-review is removed, and all 5 skills have valid frontmatter', () => {
  const jsonFiles = [
    'package.json',
    'plugin.json',
    '.claude-plugin/plugin.json',
    'hooks.json',
    'hooks/hooks.json'
  ];

  for (const relPath of jsonFiles) {
    const parsed = JSON.parse(readFileSync(resolve(KIT_ROOT, relPath), 'utf8'));
    assert.equal(typeof parsed, 'object');
  }

  assert.equal(existsSync(resolve(KIT_ROOT, 'skills/standards-review')), false);

  const skillNames = [
    'prepare-commits',
    'post-release-sync',
    'cross-repo-release',
    'season-setup',
    'weekend-data-update'
  ];
  for (const skillName of skillNames) {
    const content = readFileSync(resolve(KIT_ROOT, 'skills', skillName, 'SKILL.md'), 'utf8');
    assert.match(content, /^---\r?\n[\s\S]*?\r?\n---/);
    assert.match(content, new RegExp(`^name:\\s*${skillName}\\s*$`, 'm'));
    assert.match(content, /^description:\s*\S+/m);
  }
});

test('skill relative script links resolve inside their own skill directory', () => {
  const skillNames = [
    'prepare-commits',
    'post-release-sync',
    'cross-repo-release',
    'season-setup',
    'weekend-data-update'
  ];
  for (const skillName of skillNames) {
    const skillDir = resolve(KIT_ROOT, 'skills', skillName);
    const content = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
    const matches = content.matchAll(/\]\(\.\/(scripts\/[^)]+)\)/g);
    for (const match of matches) {
      const scriptPath = resolve(skillDir, match[1]);
      assert.equal(existsSync(scriptPath), true, `Missing referenced script in ${skillName}: ${match[1]}`);
    }
  }
});

test('rules/AGENTS.md retains critical invariants and new architecture/learning directives', () => {
  const rulesText = readFileSync(resolve(KIT_ROOT, 'rules/AGENTS.md'), 'utf8');
  const requiredPhrases = [
    'make it so',
    'Prepare git commits',
    'Execute git commands',
    'independent',
    'parity',
    'SOLID',
    'Inversion of Control',
    'Explain Design Decisions',
    'Kit evolution',
    '/learn',
    '.secrets',
    'git mv',
    'git grep',
    'git diff <file>',
    'portal:',
    '150 lines',
    'eslint.config.js',
    'tsconfig.tsbuildinfo',
    '0.0.0-semantically-released',
    'walkthrough'
  ];
  for (const phrase of requiredPhrases) {
    assert.ok(rulesText.includes(phrase), `rules/AGENTS.md missing required phrase: ${phrase}`);
  }
});

test('no personal usernames or machine-specific paths exist in ingress-events-ai-kit files', () => {
  const forbiddenPattern = new RegExp(`Users[\\\\/]Lew` + `is|yeggs-git` + `hub`, 'i');
  const filesToCheck = [];

  function collectFiles(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') {
        continue;
      }
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        collectFiles(fullPath);
      } else if (/\.(md|mjs|json)$/i.test(entry.name)) {
        filesToCheck.push(fullPath);
      }
    }
  }

  collectFiles(KIT_ROOT);
  for (const filePath of filesToCheck) {
    const text = readFileSync(filePath, 'utf8');
    assert.equal(forbiddenPattern.test(text), false, `Found hardcoded personal path in ${filePath}`);
  }
});

test('post-release-sync scripts/sync.mjs --dry-run runs standalone in temp dirs and rejects missing --repo value', () => {
  const syncScript = resolve(KIT_ROOT, 'skills/post-release-sync/scripts/sync.mjs');
  const tempParent = mkdtempSync(join(tmpdir(), 'ingress-sync-test-'));

  try {
    const tempCore = join(tempParent, 'ingress-events-core');
    mkdirSync(join(tempCore, '.git'), { recursive: true });

    const fromParentOut = execFileSync('node', [syncScript, '--all', '--dry-run'], {
      cwd: tempParent,
      encoding: 'utf8'
    });
    assert.match(fromParentOut, /\[dry-run\]/);
    assert.match(fromParentOut, /ingress-events-core/);

    const fromSiblingOut = execFileSync('node', [syncScript, '--all', '--dry-run'], {
      cwd: tempCore,
      encoding: 'utf8'
    });
    assert.match(fromSiblingOut, /\[dry-run\]/);
    assert.match(fromSiblingOut, /ingress-events-core/);

    const singleRepoOut = execFileSync('node', [syncScript, '--repo', tempCore, '--dry-run'], {
      cwd: tmpdir(),
      encoding: 'utf8'
    });
    assert.match(singleRepoOut, /\[dry-run\]/);
    assert.match(singleRepoOut, /ingress-events-core/);

    const missingRepo = spawnSync('node', [syncScript, '--repo', '--dry-run'], {
      cwd: tempParent,
      encoding: 'utf8'
    });
    assert.notEqual(missingRepo.status, 0);
    assert.match(missingRepo.stderr, /--repo requires a repository path/);
  } finally {
    rmSync(tempParent, { recursive: true, force: true });
  }
});

test('init-umbrella.mjs dynamically reads core Yarn config, respects dry-run/force, and handles missing core', () => {
  const initScript = resolve(KIT_ROOT, 'scripts/init-umbrella.mjs');
  const tempUmbrella = mkdtempSync(join(tmpdir(), 'ingress-umbrella-test-'));
  const tempEmpty = mkdtempSync(join(tmpdir(), 'ingress-umbrella-empty-'));

  try {
    const coreDir = join(tempUmbrella, 'ingress-events-core');
    mkdirSync(coreDir, { recursive: true });
    writeFileSync(join(coreDir, 'package.json'), JSON.stringify({ packageManager: 'yarn@4.99.0' }));
    writeFileSync(join(coreDir, '.yarnrc.yml'), 'yarnPath: ".yarn\\releases\\yarn-4.99.0.cjs" # bundled yarn\n');

    // Dry-run plans all 3 files without writing
    const dryResult = initUmbrella({ targetDir: tempUmbrella, dryRun: true });
    assert.equal(dryResult.planned.length, 3);
    assert.equal(existsSync(join(tempUmbrella, 'package.json')), false);

    // Real write dynamically extracts yarn@4.99.0 and yarnPath
    const writeResult = initUmbrella({ targetDir: tempUmbrella });
    assert.equal(writeResult.written.length, 3);
    const writtenPkg = JSON.parse(readFileSync(join(tempUmbrella, 'package.json'), 'utf8'));
    assert.equal(writtenPkg.packageManager, 'yarn@4.99.0');
    const writtenYarnrc = readFileSync(join(tempUmbrella, '.yarnrc.yml'), 'utf8');
    assert.match(writtenYarnrc, /yarnPath: ingress-events-core\/\.yarn\/releases\/yarn-4\.99\.0\.cjs/);
    assert.equal(existsSync(join(tempUmbrella, 'AGENTS.md')), true);
    const writtenAgentsMd = readFileSync(join(tempUmbrella, 'AGENTS.md'), 'utf8');
    assert.match(writtenAgentsMd, /<repo>\/AGENTS\.md/);

    // Non-destructive default skips existing files; --force overwrites
    writeFileSync(join(tempUmbrella, 'package.json'), '{"custom":true}\n');
    const skipResult = initUmbrella({ targetDir: tempUmbrella });
    assert.equal(skipResult.skipped.length, 3);
    assert.equal(readFileSync(join(tempUmbrella, 'package.json'), 'utf8'), '{"custom":true}\n');

    const forceResult = initUmbrella({ targetDir: tempUmbrella, force: true });
    assert.equal(forceResult.written.length, 3);
    assert.equal(JSON.parse(readFileSync(join(tempUmbrella, 'package.json'), 'utf8')).packageManager, 'yarn@4.99.0');

    // Missing ingress-events-core gracefully skips .yarnrc.yml with warnings
    const emptyResult = initUmbrella({ targetDir: tempEmpty });
    assert.equal(emptyResult.written.length, 2);
    assert.equal(emptyResult.warnings.length, 2);
    assert.equal(existsSync(join(tempEmpty, '.yarnrc.yml')), false);

    // CLI dry-run and invalid --dir error exit
    const cliOut = execFileSync('node', [initScript, '--dir', tempUmbrella, '--dry-run'], { encoding: 'utf8' });
    assert.match(cliOut, /Skipped \(already exists\)/);

    const badCli = spawnSync('node', [initScript, '--dir', '--dry-run'], { encoding: 'utf8' });
    assert.notEqual(badCli.status, 0);
    assert.match(badCli.stderr, /--dir requires a directory path/);
  } finally {
    rmSync(tempUmbrella, { recursive: true, force: true });
    rmSync(tempEmpty, { recursive: true, force: true });
  }
});
