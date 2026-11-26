import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { cleanArtifactsForCommand } from '../scripts/clean-artifacts.mjs';
import { compileAllowRule, evaluateCommand, isIngressWorkspace } from '../scripts/evaluate-command.mjs';
import { initUmbrella } from '../scripts/init-umbrella.mjs';
import {
  formatSummary,
  inspectRepo,
  parseLsRemote,
  syncRepo
} from '../skills/post-release-sync/scripts/sync.mjs';

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
  const result = evaluateCommand('npm --prefix ingress-events-core test && git push', {
    cwd: UNRELATED_CWD,
    workspacePaths: [UNRELATED_CWD]
  });
  assert.equal(result.action, 'ask');
});

test('denies shell commands referencing .secrets and local docker validation', () => {
  for (const cmd of [
    'git add .secrets',
    'echo .secrets',
    'node script.mjs .secrets',
    'node --env-file=.secrets script.mjs',
    'ENV=.secrets node script.mjs',
    'cat .secrets; ls',
    '(cat .secrets)',
    'echo ok;.secrets',
    '(.secrets)',
    'echo x>.secrets',
    'sort <.secrets',
    'docker build .',
    '/usr/bin/docker build .',
    'yarn --cwd ingress-events-core validate:docker',
    "git -C ingress-events-core log ' && docker build ."
  ]) {
    const result = evaluateCommand(cmd, { cwd: FAKE_UMBRELLA_WIN });
    assert.equal(result.action, 'deny', `Expected deny for: ${cmd}`);
  }

  assert.equal(
    evaluateCommand('git -C ingress-events-core commit -m "docs: no validate:docker"', {
      cwd: FAKE_UMBRELLA_WIN
    }).action,
    'force_ask'
  );
});

test('denies cross-stack npm and yarn mixups per segment while scoping explicit targets and deferring compliant commands to native rules', () => {
  const denied = [
    { cmd: 'npm --prefix ingress-events-core test', cwd: FAKE_UMBRELLA_WIN },
    { cmd: 'C:\\tools\\npm.cmd --prefix ingress-events-core test', cwd: FAKE_UMBRELLA_WIN },
    { cmd: 'npm --prefix=ingress-events-core test', cwd: FAKE_UMBRELLA_WIN },
    { cmd: 'npm -C ingress-events-core test', cwd: FAKE_UMBRELLA_WIN },
    { cmd: 'npm --prefix iitc-plugin-site-observer run validate', cwd: FAKE_UMBRELLA_WIN },
    { cmd: 'npm test', cwd: CORE_CWD },
    { cmd: 'npm --prefix . test', cwd: CORE_CWD },
    { cmd: 'npm run validate', cwd: OBSERVER_CWD },
    { cmd: 'yarn --cwd ingress-shards.github.io validate', cwd: FAKE_UMBRELLA_WIN },
    { cmd: 'corepack yarn --cwd ingress-shards.github.io validate', cwd: FAKE_UMBRELLA_WIN },
    { cmd: 'yarn --cwd=ingress-shards.github.io validate', cwd: FAKE_UMBRELLA_WIN },
    { cmd: 'yarn validate', cwd: MAP_CWD },
    { cmd: 'yarn --cwd . validate', cwd: MAP_CWD },
    { cmd: 'yarn --cwd ingress-events-ai-kit test', cwd: FAKE_UMBRELLA_WIN },
    { cmd: 'yarn test', cwd: KIT_CWD },
    { cmd: 'echo ok && npm --prefix ingress-events-core test', cwd: FAKE_UMBRELLA_WIN },
    { cmd: 'git -C ingress-shards.github.io status -s && npm test', cwd: CORE_CWD },
    { cmd: 'npm --prefix ingress-shards.github.io test && npm --prefix ingress-events-core test', cwd: FAKE_UMBRELLA_WIN }
  ];

  for (const { cmd, cwd } of denied) {
    assert.equal(evaluateCommand(cmd, { cwd }).action, 'deny', `Expected deny for: ${cmd}`);
  }

  const allowed = [
    { cmd: 'yarn --cwd ingress-events-core validate', cwd: FAKE_UMBRELLA_WIN },
    { cmd: 'npm --prefix ingress-shards.github.io run validate', cwd: FAKE_UMBRELLA_WIN },
    { cmd: 'git -C ingress-events-core status -s && npm test', cwd: MAP_CWD },
    { cmd: 'yarn --cwd new-sibling-repo validate:check', cwd: MAP_CWD },
    { cmd: 'yarn --cwd new-sibling-repo validate:check', cwd: KIT_CWD },
    { cmd: 'npm --prefix new-npm-repo test', cwd: CORE_CWD },
    { cmd: 'npm --prefix new-npm-repo test', cwd: OBSERVER_CWD }
  ];

  for (const { cmd, cwd } of allowed) {
    assert.equal(evaluateCommand(cmd, { cwd }).action, 'allow', `Expected allow for: ${cmd}`);
  }

  const deferredToAsk = [
    { cmd: 'yarn --cwd ingress-events-core build', cwd: FAKE_UMBRELLA_WIN },
    { cmd: 'yarn --cwd ingress-events-core validate 2>&1', cwd: FAKE_UMBRELLA_WIN },
    { cmd: 'npm --prefix ingress-shards.github.io run lint -c ingress-events-core', cwd: FAKE_UMBRELLA_WIN },
    { cmd: 'npm --prefix ingress-shards.github.io test -- src/foo.test.ts', cwd: FAKE_UMBRELLA_WIN },
    { cmd: 'node --test tests/foo.test.mjs', cwd: KIT_CWD },
    { cmd: 'npm install @ingress-shards/ingress-events-core@^0.9.1', cwd: MAP_CWD },
    {
      cmd: 'npm --prefix ingress-shards.github.io install @ingress-shards/ingress-events-core@^0.9.1',
      cwd: FAKE_UMBRELLA_WIN
    }
  ];

  for (const { cmd, cwd } of deferredToAsk) {
    assert.equal(evaluateCommand(cmd, { cwd }).action, 'ask', `Expected ask for: ${cmd}`);
  }
});

test('flags mutating git commands with force_ask, auto-allows allowlisted read-only git, and asks on others', () => {
  const nonReadOnly = [
    'git -C ingress-events-core commit -m "feat: add ornament"',
    'git -C ingress-events-core commit -m "docs: mention npm"',
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
    'git -C ingress-events-core worktree add ../wt feat/x',
    'git -C ingress-events-core clean -fd',
    'git -C ingress-events-core am patch.diff',
    'git -C ingress-events-core apply patch.diff',
    'git -C ingress-events-core tag -d v1.0.0',
    'git -C ingress-events-core tag v1.0.1',
    'git -C ingress-events-core tag --delete v1.0.0',
    'git -C ingress-events-core branch -D old-branch',
    'git -C ingress-events-core branch -l feat-reflog',
    'git -C ingress-events-core branch -lv',
    'git -C ingress-events-core branch --delete old-branch',
    'git -C ingress-events-core branch new-feat',
    'git -C ingress-events-core remote prune origin',
    'git -C ingress-events-core stash',
    'git -C ingress-events-core stash save "wip"',
    'git -C ingress-events-core stash pop',
    'git init',
    'git.exe commit -m "x"',
    '/usr/bin/git push',
    'FOO=1 git push',
    'env -i git push',
    'git -C ingress-events-core status -s && git -C ingress-events-core push',
    "git -C ingress-events-core log ' && git push",
    "git -C ingress-events-core log \\'; git push; echo \\'",
    'git -C ingress-events-core grep "foo\\"; git push; echo \\""'
  ];

  for (const cmd of nonReadOnly) {
    const result = evaluateCommand(cmd, { cwd: FAKE_UMBRELLA_WIN });
    assert.equal(result.action, 'force_ask', `Expected force_ask for: ${cmd}`);
  }

  const allowedReadOnly = [
    'git -C ingress-events-core status -s',
    'git -C ingress-events-core branch --show-current',
    'git -C ingress-events-core tag --sort=-v:refname',
    'git tag --sort=-v:refname',
    'git -C ingress-events-core diff',
    'git -C ingress-events-core diff --stat',
    'git -C ingress-events-core diff --staged',
    'git -C ingress-events-core diff v2...HEAD',
    'git -C ingress-events-core log -n 5',
    'git -C ingress-events-core show --stat',
    'git -C ingress-events-core grep "git push"',
    'git -C ingress-events-core grep "=>"',
    "git -C ingress-events-core grep '$(literal)'"
  ];

  for (const cmd of allowedReadOnly) {
    const result = evaluateCommand(cmd, { cwd: FAKE_UMBRELLA_WIN });
    assert.equal(result.action, 'allow', `Expected allow for read-only git: ${cmd}`);
  }

  const askedReadOnly = [
    'git -C ingress-events-core diff README.md',
    'git -C ingress-events-core fetch origin --tags',
    'git -C ingress-events-core branch -a',
    'git -C ingress-events-core branch --merged main',
    'git -C ingress-events-core tag --list',
    'git -C ingress-events-core tag',
    'git -C ingress-events-core tag --sort=-v:refname v1.0.0',
    'git -C ingress-events-core stash list',
    'git -C ingress-events-core stash show',
    'git -C ingress-events-core remote -v',
    'git -C ingress-events-core log $(git push)',
    'git -C ingress-events-core log "$(git push)"',
    'git -C ingress-events-core grep `git push`',
    'git -C ingress-events-core grep "`git push`"',
    'git -C ingress-events-core log (git push)',
    'git -C ingress-events-core log @(git push)',
    "git -C ingress-events-core log 'unclosed",
    "git -C ingress-events-core log \\'",
    'git -C ingress-events-core grep "foo\\"bar"',
    'git -C ingress-events-core log > README.md',
    'git -C ingress-events-core log 2>&1',
    'git -C ingress-events-core show HEAD < /etc/passwd'
  ];

  for (const cmd of askedReadOnly) {
    const result = evaluateCommand(cmd, { cwd: FAKE_UMBRELLA_WIN });
    assert.equal(result.action, 'ask', `Expected ask for read-only git: ${cmd}`);
  }
});

test('sync.mjs requires force_ask without --dry-run (per segment) and passes through with --dry-run', () => {
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
    evaluateCommand(
      'node "/tools/skills/post-release-sync/scripts/sync.mjs" --all --dry-run && node "/tools/skills/post-release-sync/scripts/sync.mjs" --all',
      { cwd: FAKE_UMBRELLA_POSIX }
    ).action,
    'force_ask'
  );
  assert.equal(
    evaluateCommand('echo --dry-run && node "/tools/skills/post-release-sync/scripts/sync.mjs" --all', {
      cwd: FAKE_UMBRELLA_POSIX
    }).action,
    'force_ask'
  );
});

test('guard-antigravity.mjs emits valid Antigravity PreToolUse JSON and returns auto_approve for allowlisted commands in Ingress workspaces', () => {
  const script = resolve(KIT_ROOT, 'scripts/guard-antigravity.mjs');

  const denyOut = JSON.parse(
    execFileSync('node', [script], {
      input: JSON.stringify({
        cwd: FAKE_UMBRELLA_WIN,
        workspacePaths: [FAKE_UMBRELLA_WIN],
        toolCall: { args: { CommandLine: 'echo .secrets' } }
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

  const allowInWorkspaceOut = JSON.parse(
    execFileSync('node', [script], {
      input: JSON.stringify({
        cwd: FAKE_UMBRELLA_WIN,
        toolCall: { args: { CommandLine: 'yarn --cwd ingress-events-core validate' } }
      }),
      encoding: 'utf8'
    })
  );
  assert.deepEqual(allowInWorkspaceOut, { decision: 'auto_approve' });

  const askInWorkspaceOut = JSON.parse(
    execFileSync('node', [script], {
      input: JSON.stringify({
        cwd: FAKE_UMBRELLA_WIN,
        toolCall: { args: { CommandLine: 'yarn --cwd ingress-events-core build' } }
      }),
      encoding: 'utf8'
    })
  );
  assert.equal(askInWorkspaceOut.decision, 'ask');
  assert.match(askInWorkspaceOut.reason, /allowlist/i);

  const askUnrelatedOut = JSON.parse(
    execFileSync('node', [script], {
      input: JSON.stringify({
        cwd: UNRELATED_CWD,
        workspacePaths: [UNRELATED_CWD],
        toolCall: { args: { CommandLine: 'yarn validate' } }
      }),
      encoding: 'utf8'
    })
  );
  assert.deepEqual(askUnrelatedOut, { decision: 'ask' });

  const workspacePathsOnlyOut = JSON.parse(
    execFileSync('node', [script], {
      input: JSON.stringify({
        cwd: '',
        workspacePaths: [FAKE_UMBRELLA_WIN],
        toolCall: { args: { CommandLine: 'npm --prefix ingress-events-ai-kit test' } }
      }),
      encoding: 'utf8'
    })
  );
  assert.deepEqual(workspacePathsOnlyOut, { decision: 'auto_approve' });

  const malformedOut = JSON.parse(
    execFileSync('node', [script], {
      input: '{not valid json',
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    })
  );
  assert.deepEqual(malformedOut, { decision: 'ask' });
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

test('native permission template files parse cleanly with non-empty deny, ask, and allow lists', () => {
  const agyTemplate = JSON.parse(readFileSync(resolve(KIT_ROOT, 'examples/antigravity-permissions.json'), 'utf8'));
  const claudeTemplate = JSON.parse(readFileSync(resolve(KIT_ROOT, 'examples/claude-settings.json'), 'utf8'));

  for (const section of [agyTemplate.permissionGrants, claudeTemplate.permissions]) {
    assert.equal(typeof section, 'object');
    for (const bucket of ['deny', 'ask', 'allow']) {
      assert.ok(Array.isArray(section[bucket]) && section[bucket].length > 0, `Expected non-empty ${bucket} array`);
      assert.ok(section[bucket].every((entry) => typeof entry === 'string' && entry.length > 0));
    }
  }

  assert.equal(agyTemplate.permissionGrants.allow.includes('command(regex:node --test)'), true);

  assert.equal(compileAllowRule(null), null);
  assert.equal(compileAllowRule('not-a-rule'), null);
  assert.equal(compileAllowRule('command()'), null);
  assert.equal(compileAllowRule('command(regex:)'), null);
  assert.equal(compileAllowRule('command(regex:[)'), null);
  assert.equal(compileAllowRule('command(regex:.*)'), null);
  assert.equal(compileAllowRule('command(regex:   .*)'), null);

  for (const bucket of ['deny', 'ask', 'allow']) {
    for (const entry of agyTemplate.permissionGrants[bucket]) {
      if (!entry.startsWith('command(regex:') || !entry.endsWith(')')) {
        continue;
      }
      const inner = entry.slice('command(regex:'.length, -1).trim();
      for (const token of inner.split(/\s+/)) {
        assert.doesNotThrow(() => new RegExp(`^(?:${token})$`), `Invalid token regex "${token}" in ${entry}`);
      }
    }
  }
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

test('all 4 declarative subagents exist and have tool-agnostic valid frontmatter and bodies', () => {
  const agentNames = ['impact-researcher', 'plan-challenger', 'code-reviewer', 'parity-reviewer'];
  const platformToolPattern =
    /(?:^|[\s`,"'])(?:run_command|read_file|view_file|grep_search|edit_file|write_file|Bash|Grep|Glob|Read|Edit|Write)(?=[\s`,"',.:;)]|$)/;

  for (const agentName of agentNames) {
    const agentPath = resolve(KIT_ROOT, 'agents', `${agentName}.md`);
    assert.equal(existsSync(agentPath), true, `Missing agent file: ${agentName}.md`);
    const content = readFileSync(agentPath, 'utf8');
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    assert.ok(fmMatch, `Missing YAML frontmatter in ${agentName}.md`);
    const keys = fmMatch[1]
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => line.split(':')[0].trim());
    assert.deepEqual(keys, ['name', 'description'], `Frontmatter keys in ${agentName}.md must be strictly name and description`);
    assert.match(fmMatch[1], new RegExp(`^name:\\s*${agentName}\\s*$`, 'm'));
    assert.match(fmMatch[1], /^description:\s*\S+/m);
    assert.equal(platformToolPattern.test(content), false, `Found platform-specific tool name in ${agentName}.md`);
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
    'walkthrough',
    'impact-researcher',
    'plan-challenger',
    'code-reviewer',
    'parity-reviewer',
    'validate:check',
    'main...HEAD',
    'git worktree',
    'branch --show-current',
    'review-report',
    'ingress-events-ai-kit',
    'permissionGrants.allow',
    'permissions.allow'
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

test('post-release-sync scripts/sync.mjs --dry-run runs standalone in temp dirs (including all 4 default repos) and rejects missing --repo value', () => {
  const syncScript = resolve(KIT_ROOT, 'skills/post-release-sync/scripts/sync.mjs');
  const tempParent = mkdtempSync(join(tmpdir(), 'ingress-sync-test-'));

  try {
    const tempCore = join(tempParent, 'ingress-events-core');
    const tempAiKit = join(tempParent, 'ingress-events-ai-kit');
    mkdirSync(join(tempCore, '.git'), { recursive: true });
    mkdirSync(join(tempAiKit, '.git'), { recursive: true });

    const fromParentOut = execFileSync('node', [syncScript, '--all', '--dry-run'], {
      cwd: tempParent,
      encoding: 'utf8'
    });
    assert.match(fromParentOut, /\[dry-run\]/);
    assert.match(fromParentOut, /ingress-events-core/);
    assert.match(fromParentOut, /ingress-events-ai-kit/);

    const fromSiblingOut = execFileSync('node', [syncScript, '--all', '--dry-run'], {
      cwd: tempCore,
      encoding: 'utf8'
    });
    assert.match(fromSiblingOut, /\[dry-run\]/);
    assert.match(fromSiblingOut, /ingress-events-core/);
    assert.match(fromSiblingOut, /ingress-events-ai-kit/);

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

test('post-release-sync parseLsRemote extracts remote heads and Git-sorted latest tag', () => {
  const parsed = parseLsRemote(
    [
      '1111111\trefs/heads/main',
      '2222222\trefs/heads/feat/active',
      '4444444\trefs/tags/v0.10.0',
      '3333333\trefs/tags/v0.9.1'
    ].join('\n')
  );
  assert.equal(parsed.heads.get('main'), '1111111');
  assert.equal(parsed.heads.get('feat/active'), '2222222');
  assert.equal(parsed.latestTag, 'v0.10.0');
});

test('post-release-sync inspectRepo and syncRepo report GitHub drift, protect WIP repos, and safely sync ready repos', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'ingress-sync-git-'));
  const git = (cwd, args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  try {
    const bareRemote = join(tempRoot, 'origin.git');
    const seedClone = join(tempRoot, 'seed');
    const devClone = join(tempRoot, 'ingress-events-core');

    git(tempRoot, ['init', '--bare', bareRemote]);
    git(tempRoot, ['clone', bareRemote, seedClone]);
    git(seedClone, ['config', 'user.name', 'Test User']);
    git(seedClone, ['config', 'user.email', 'test@example.com']);
    git(seedClone, ['checkout', '-B', 'main']);

    writeFileSync(join(seedClone, 'README.md'), 'init\n');
    git(seedClone, ['add', 'README.md']);
    git(seedClone, ['commit', '-m', 'chore: init']);
    git(seedClone, ['tag', 'v0.9.0']);
    git(seedClone, ['push', '-u', 'origin', 'main']);
    git(seedClone, ['push', 'origin', 'v0.9.0']);
    git(bareRemote, ['symbolic-ref', 'HEAD', 'refs/heads/main']);

    git(tempRoot, ['clone', bareRemote, devClone]);
    git(devClone, ['config', 'user.name', 'Test User']);
    git(devClone, ['config', 'user.email', 'test@example.com']);

    git(devClone, ['checkout', '-b', 'feat/merged']);
    git(devClone, ['checkout', 'main']);

    git(devClone, ['checkout', '-b', 'feat/squashed']);
    writeFileSync(join(devClone, 'squash.txt'), 'squash\n');
    git(devClone, ['add', 'squash.txt']);
    git(devClone, ['commit', '-m', 'feat: squash work']);
    git(devClone, ['push', '-u', 'origin', 'feat/squashed']);
    git(devClone, ['push', 'origin', '--delete', 'feat/squashed']);

    git(devClone, ['checkout', 'main']);
    git(devClone, ['checkout', '-b', 'feat/open']);
    writeFileSync(join(devClone, 'open.txt'), 'open\n');
    git(devClone, ['add', 'open.txt']);
    git(devClone, ['commit', '-m', 'feat: open work']);
    git(devClone, ['push', '-u', 'origin', 'feat/open']);

    git(devClone, ['checkout', 'main']);
    git(devClone, ['checkout', '-b', 'chore/local-wip']);
    writeFileSync(join(devClone, 'wip.txt'), 'wip\n');
    git(devClone, ['add', 'wip.txt']);
    git(devClone, ['commit', '-m', 'chore: local wip']);

    writeFileSync(join(seedClone, 'release.txt'), 'v0.10.0\n');
    git(seedClone, ['add', 'release.txt']);
    git(seedClone, ['commit', '-m', 'feat: release 0.10.0']);
    git(seedClone, ['tag', 'v0.10.0']);
    git(seedClone, ['push', 'origin', 'main']);
    git(seedClone, ['push', 'origin', 'v0.10.0']);

    git(devClone, ['checkout', 'feat/merged']);
    writeFileSync(join(devClone, 'dirty.tmp'), 'uncommitted\n');

    const dirtyReport = inspectRepo(devClone);
    assert.equal(dirtyReport.isDirty, true);
    assert.equal(dirtyReport.dirtyCount, 1);
    assert.equal(dirtyReport.localLatestTag, 'v0.9.0');
    assert.equal(dirtyReport.remoteLatestTag, 'v0.10.0');
    assert.match(dirtyReport.mainStatus, /behind/);
    assert.equal(dirtyReport.disposition, 'skip-dirty');
    assert.deepEqual(dirtyReport.mergedBranches.map((b) => b.name), ['feat/merged']);
    assert.deepEqual(dirtyReport.goneBranches.map((b) => b.name), ['feat/squashed']);
    assert.deepEqual(dirtyReport.openBranches.map((b) => b.name).sort(), ['chore/local-wip', 'feat/open']);

    const summaryText = formatSummary([dirtyReport], { dryRun: true });
    assert.match(summaryText, /local=v0\.9\.0, github=v0\.10\.0/);
    assert.match(summaryText, /main vs GitHub: .*behind/);
    assert.match(summaryText, /Branch vs main: 0 ahead, 0 behind/);
    assert.match(summaryText, /Prunable \(merged, -d\): feat\/merged/);
    assert.match(summaryText, /Remote gone \(review -D\): feat\/squashed/);
    assert.match(summaryText, /git -C ingress-events-core branch -D feat\/squashed/);

    const logs = [];
    const dirtySync = syncRepo(devClone, { dryRun: false, log: (msg) => logs.push(msg) });
    assert.equal(dirtySync.skipped, true);
    assert.equal(git(devClone, ['branch', '--show-current']), 'feat/merged');
    assert.equal(existsSync(join(devClone, 'dirty.tmp')), true);

    rmSync(join(devClone, 'dirty.tmp'));
    git(devClone, ['checkout', 'feat/open']);
    const activeReport = inspectRepo(devClone);
    assert.equal(activeReport.branchVsMain?.ahead, 1);
    const activeSummary = formatSummary([activeReport], { dryRun: true });
    assert.match(activeSummary, /git -C ingress-events-core fetch origin main:main/);
    assert.match(activeSummary, /git -C ingress-events-core rebase main/);
    const activeSync = syncRepo(devClone, { dryRun: false, log: (msg) => logs.push(msg) });
    assert.equal(activeSync.report.disposition, 'skip-active-branch');
    assert.equal(activeSync.skipped, true);
    assert.equal(git(devClone, ['branch', '--show-current']), 'feat/open');

    git(devClone, ['checkout', 'feat/merged']);
    const readyLogs = [];
    const readySync = syncRepo(devClone, { dryRun: false, log: (msg) => readyLogs.push(msg) });
    assert.equal(readySync.report.disposition, 'ready');
    assert.equal(readySync.skipped, false);
    assert.equal(git(devClone, ['branch', '--show-current']), 'main');
    assert.match(git(devClone, ['tag', '--sort=-v:refname']), /^v0\.10\.0/);
    const remainingBranches = git(devClone, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).split(/\r?\n/);
    assert.equal(remainingBranches.includes('feat/merged'), false);
    assert.equal(remainingBranches.includes('feat/squashed'), true);
    assert.equal(remainingBranches.includes('feat/open'), true);
    assert.equal(remainingBranches.includes('chore/local-wip'), true);
    assert.ok(readyLogs.some((line) => line.includes('git -C ingress-events-core branch -D feat/squashed')));

    const upToDateLogs = [];
    const upToDateSync = syncRepo(devClone, { dryRun: false, log: (msg) => upToDateLogs.push(msg) });
    assert.equal(upToDateSync.report.disposition, 'up-to-date');
    assert.equal(upToDateSync.skipped, false);
    assert.ok(upToDateLogs.some((line) => line.includes('[up-to-date]')));
    assert.ok(upToDateLogs.some((line) => line.includes('git -C ingress-events-core branch -D feat/squashed')));

    // Native Git versionsort.suffix=- ranks stable v0.10.0 above v0.10.0-alpha.1
    git(devClone, ['tag', 'v0.10.0-alpha.1']);
    assert.equal(inspectRepo(devClone).localLatestTag, 'v0.10.0');

    // Diverged main is safely skipped
    writeFileSync(join(seedClone, 'remote-diverge.txt'), 'remote\n');
    git(seedClone, ['add', 'remote-diverge.txt']);
    git(seedClone, ['commit', '-m', 'chore: remote diverge']);
    git(seedClone, ['push', 'origin', 'main']);
    writeFileSync(join(devClone, 'ahead.txt'), 'ahead\n');
    git(devClone, ['add', 'ahead.txt']);
    git(devClone, ['commit', '-m', 'chore: ahead commit']);
    const aheadReport = inspectRepo(devClone);
    assert.match(aheadReport.mainStatus, /1 ahead/);
    assert.equal(aheadReport.disposition, 'skip-diverged');
    const aheadSync = syncRepo(devClone, { dryRun: false, log: () => {} });
    assert.equal(aheadSync.skipped, true);

    // Sibling worktree branch is annotated [worktree] via for-each-ref %(worktreepath)
    git(devClone, ['reset', '--hard', 'origin/main']);
    const wtDir = join(tempRoot, 'wt-open');
    git(devClone, ['worktree', 'add', wtDir, 'feat/open']);
    const wtReport = inspectRepo(devClone);
    const openEntry = wtReport.openBranches.find((b) => b.name === 'feat/open');
    assert.equal(openEntry?.inOtherWorktree, true);
    assert.match(formatSummary([wtReport], { dryRun: true }), /feat\/open \[worktree\]/);
    git(devClone, ['worktree', 'remove', wtDir]);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
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
