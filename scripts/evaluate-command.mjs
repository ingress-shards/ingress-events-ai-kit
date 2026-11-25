import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';

const PRODUCT_REPO_NAMES = [
  'ingress-events-core',
  'iitc-plugin-site-observer',
  'ingress-shards.github.io'
];

const INGRESS_PATH_PATTERN =
  /(?:^|\/)(ingress-shards|ingress-events-core|iitc-plugin-site-observer|ingress-shards\.github\.io|ingress-events-ai-kit)(?:\/|$)/i;

const SECRETS_REF_PATTERN = /(?:^|[\s"'`\\/<>])\.secrets(?:$|[\s"'`\\/>])/i;

const POWERSHELL_CMDLET_PATTERN =
  /\b(Get-ChildItem|Get-Content|Set-Content|Add-Content|Select-Object|Select-String|Test-Path|ForEach-Object|Where-Object|Push-Location|Pop-Location|Set-Location|Remove-Item|Copy-Item|Move-Item|New-Item|Out-File)\b/i;

const SHELL_INSPECT_PATTERN = /^(cat|type|head|sed)$/i;
const DOCKER_PATTERN = /^(docker\b|.*validate:docker\b)/i;

const YARN_REPOS_PATTERN = /(?<!@ingress-shards\/)\b(ingress-events-core|iitc-plugin-site-observer)\b/i;
const NPM_REPOS_PATTERN = /\bingress-shards\.github\.io\b/i;

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  'status',
  'diff',
  'log',
  'show',
  'fetch',
  'grep',
  'rev-parse',
  'describe',
  'ls-files',
  'ls-remote',
  'shortlog',
  'rev-list',
  'cat-file',
  'merge-base',
  'check-ignore'
]);

const DIFF_FLAGS_WITH_VALUE = new Set([
  '-U',
  '--unified',
  '--diff-filter',
  '-S',
  '-G',
  '-O',
  '--src-prefix',
  '--dst-prefix',
  '--output',
  '--word-diff-regex',
  '--inter-hunk-context'
]);

const BRANCH_READ_ONLY_FLAGS_WITH_VALUE = new Set([
  '--merged',
  '--no-merged',
  '--contains',
  '--no-contains',
  '--points-at',
  '--sort',
  '--format',
  '--list'
]);

const BRANCH_MUTATING_FLAGS = new Set([
  '-l',
  '--delete',
  '--move',
  '--copy',
  '--force',
  '--set-upstream-to',
  '--unset-upstream',
  '--edit-description',
  '--create-reflog'
]);

const TAG_MUTATING_FLAGS = new Set([
  '--delete',
  '--annotate',
  '--sign',
  '--force',
  '--message'
]);

const TAG_READ_ONLY_FLAGS = new Set([
  '-l',
  '--list',
  '-v',
  '--verify',
  '--sort',
  '--merged',
  '--no-merged',
  '--contains',
  '--points-at'
]);

const GIT_GLOBAL_FLAGS_WITH_VALUE = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
  '--config-env'
]);

const KNOWN_SAFE_ROOT_PATTERNS = [
  /^(?:corepack )?yarn --cwd (?:ingress-events-core|iitc-plugin-site-observer) validate$/,
  /^npm --prefix ingress-shards\.github\.io run validate$/,
  /^npm --prefix ingress-events-ai-kit test$/,
  /^git -C (?:ingress-events-core|iitc-plugin-site-observer|ingress-shards\.github\.io|ingress-events-ai-kit) (?:status -s|diff --stat)$/,
  /^git (?:status -s|diff --stat)$/
];

function normalizePath(value) {
  return String(value ?? '').replace(/\\/g, '/').toLowerCase();
}

/**
 * Checks whether the current working directory or any active workspace path
 * belongs to the Ingress Shards repositories.
 */
export function isIngressWorkspace(cwd = '', workspacePaths = []) {
  const candidates = [cwd, ...(Array.isArray(workspacePaths) ? workspacePaths : [])].filter(Boolean);
  if (candidates.some((candidate) => INGRESS_PATH_PATTERN.test(normalizePath(candidate)))) {
    return true;
  }

  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && PRODUCT_REPO_NAMES.some((repo) => existsSync(join(candidate, repo)))) {
        return true;
      }
    } catch {
      // Ignore inaccessible candidate paths
    }
  }

  return false;
}

/**
 * Splits a shell command string on `&&`, `||`, `;`, `|`, `&`, and newlines outside quoted segments.
 */
function splitSegments(commandLine) {
  const segments = [];
  let current = '';
  let quote = null;

  for (let i = 0; i < commandLine.length; i++) {
    const ch = commandLine[i];
    const next = commandLine[i + 1];

    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < commandLine.length) {
        current += ch + next;
        i++;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      current += ch;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }

    if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) {
      if (current.trim()) {
        segments.push(current.trim());
      }
      current = '';
      i++;
      continue;
    }

    if (ch === ';' || ch === '|' || ch === '&' || ch === '\n' || ch === '\r') {
      if (current.trim()) {
        segments.push(current.trim());
      }
      current = '';
      continue;
    }

    current += ch;
  }

  if (current.trim()) {
    segments.push(current.trim());
  }

  return segments;
}

/**
 * Tokenizes a single command segment while respecting quotes.
 */
function tokenize(segment) {
  const tokens = [];
  let current = '';
  let quote = null;

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < segment.length) {
        current += segment[i + 1];
        i++;
        continue;
      }
      if (ch === quote) {
        quote = null;
        continue;
      }
      current += ch;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += ch;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

function normalizeExecutableName(token) {
  const clean = basename(String(token ?? '').replace(/\\/g, '/')).toLowerCase();
  return clean.replace(/\.(exe|cmd|bat)$/i, '');
}

/**
 * Strips leading `KEY=VALUE` assignments and `env` wrappers, returning normalized executable + args.
 */
function unwrapCommandTokens(tokens) {
  let idx = 0;
  while (idx < tokens.length) {
    const token = tokens[idx];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      idx++;
      continue;
    }
    if (normalizeExecutableName(token) === 'env') {
      idx++;
      while (idx < tokens.length && tokens[idx].startsWith('-')) {
        const flag = tokens[idx];
        idx++;
        if ((flag === '-u' || flag === '--unset') && idx < tokens.length) {
          idx++;
        }
      }
      continue;
    }
    break;
  }

  const sliced = tokens.slice(idx);
  const command = sliced.length > 0 ? normalizeExecutableName(sliced[0]) : '';
  return { command, tokens: sliced };
}

const NODE_FLAGS_WITH_VALUE = new Set([
  '-r',
  '--require',
  '--import',
  '--input-type',
  '--loader',
  '--conditions',
  '-C',
  '--env-file'
]);

function isInlineNodeEval(tokens) {
  for (let i = 1; i < tokens.length; i++) {
    const arg = tokens[i];
    if (arg === '--') {
      return false;
    }
    if (
      arg === '-e' ||
      arg === '--eval' ||
      arg.startsWith('--eval=') ||
      arg === '-p' ||
      arg === '--print' ||
      arg.startsWith('--print=') ||
      /^-[a-z]*[ep][a-z]*$/i.test(arg)
    ) {
      return true;
    }
    if (arg.startsWith('-')) {
      if (NODE_FLAGS_WITH_VALUE.has(arg) && i + 1 < tokens.length) {
        i++;
      }
      continue;
    }
    return false;
  }
  return false;
}

function parseGitCommand(tokens) {
  let idx = 1;
  while (idx < tokens.length && tokens[idx].startsWith('-')) {
    const flag = tokens[idx];
    idx++;
    if (GIT_GLOBAL_FLAGS_WITH_VALUE.has(flag) && idx < tokens.length) {
      idx++;
    }
  }

  return {
    subcommand: tokens[idx]?.toLowerCase() ?? '',
    rest: tokens.slice(idx + 1)
  };
}

function hasDiffPositionalArgs(rest) {
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--') {
      return true;
    }
    if (arg.startsWith('-')) {
      if (DIFF_FLAGS_WITH_VALUE.has(arg) && i + 1 < rest.length) {
        i++;
      }
      continue;
    }
    return true;
  }
  return false;
}

function isReadOnlyBranch(rest) {
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const flagName = arg.split('=')[0];
    if (/^-[dDmMcCfl]+$/.test(arg) || BRANCH_MUTATING_FLAGS.has(flagName)) {
      return false;
    }
    if (arg.startsWith('-')) {
      if (BRANCH_READ_ONLY_FLAGS_WITH_VALUE.has(arg) && i + 1 < rest.length && !rest[i + 1].startsWith('-')) {
        i++;
      }
      continue;
    }
    return false;
  }
  return true;
}

function isReadOnlyTag(rest) {
  if (rest.length === 0) {
    return true;
  }
  const hasMutatingFlag = rest.some((arg) => {
    const flagName = arg.split('=')[0];
    return /^-[dasfm]+$/.test(arg) || TAG_MUTATING_FLAGS.has(flagName);
  });
  if (hasMutatingFlag) {
    return false;
  }
  return rest.some((arg) => {
    const flagName = arg.split('=')[0];
    return TAG_READ_ONLY_FLAGS.has(flagName);
  });
}

function isReadOnlyRemote(rest) {
  if (rest.length === 0) {
    return true;
  }
  const first = rest[0]?.toLowerCase();
  if (rest.length === 1 && (first === '-v' || first === '--verbose')) {
    return true;
  }
  return first === 'show' || first === 'get-url';
}

function isReadOnlyConfig(rest) {
  const mutatingConfigFlags = new Set([
    '--unset',
    '--unset-all',
    '--add',
    '--replace-all',
    '--rename-section',
    '--remove-section'
  ]);
  const readOnlyConfigFlags = new Set(['--get', '--get-all', '--list', '-l']);

  if (rest.some((arg) => mutatingConfigFlags.has(arg.split('=')[0]))) {
    return false;
  }
  return rest.some((arg) => readOnlyConfigFlags.has(arg.split('=')[0]));
}

function evaluateGitSegment(tokens) {
  const { subcommand, rest } = parseGitCommand(tokens);
  if (!subcommand) {
    return { action: 'ask' };
  }

  if (subcommand === 'diff') {
    if (hasDiffPositionalArgs(rest)) {
      return {
        action: 'deny',
        reason:
          'Passing file paths or positional args to `git diff` is forbidden (breaks permission caching). Use native file read tools or plain `git -C <repo> diff` / `git -C <repo> diff --stat`.'
      };
    }
    return { action: 'ask' };
  }

  if (READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) {
    return { action: 'ask' };
  }

  if (subcommand === 'branch' && isReadOnlyBranch(rest)) {
    return { action: 'ask' };
  }

  if (subcommand === 'tag' && isReadOnlyTag(rest)) {
    return { action: 'ask' };
  }

  if (subcommand === 'stash' && ['list', 'show'].includes(rest[0]?.toLowerCase())) {
    return { action: 'ask' };
  }

  if (subcommand === 'remote' && isReadOnlyRemote(rest)) {
    return { action: 'ask' };
  }

  if (subcommand === 'config' && isReadOnlyConfig(rest)) {
    return { action: 'ask' };
  }

  return {
    action: 'force_ask',
    reason: 'Non-read-only git commands require explicit user approval ("Execute git commands").'
  };
}

function detectPackageManager(command, tokens) {
  if (command === 'npm') {
    return 'npm';
  }
  if (command === 'yarn') {
    return 'yarn';
  }
  if (command === 'corepack') {
    const sub = normalizeExecutableName(tokens[1]);
    if (sub === 'yarn' || sub === 'npm') {
      return sub;
    }
  }
  return null;
}

function isKnownSafeSingleCommand(commandLine, normalizedCwd) {
  const normalizedCmd = commandLine.trim().replace(/\s+/g, ' ');
  if (KNOWN_SAFE_ROOT_PATTERNS.some((pattern) => pattern.test(normalizedCmd))) {
    return true;
  }

  if (
    /^(?:corepack )?yarn validate$/.test(normalizedCmd) &&
    /(?:^|\/)(?:ingress-events-core|iitc-plugin-site-observer)(?:\/|$)/.test(normalizedCwd)
  ) {
    return true;
  }

  if (
    /^npm run validate$/.test(normalizedCmd) &&
    /(?:^|\/)ingress-shards\.github\.io(?:\/|$)/.test(normalizedCwd)
  ) {
    return true;
  }

  if (
    /^node --test$/.test(normalizedCmd) &&
    /(?:^|\/)ingress-events-ai-kit(?:\/|$)/.test(normalizedCwd)
  ) {
    return true;
  }

  return false;
}

/**
 * Evaluates a shell command against Ingress Shards workspace guardrails.
 */
export function evaluateCommand(commandLine, { cwd = '', workspacePaths = [] } = {}) {
  if (!commandLine || !isIngressWorkspace(cwd, workspacePaths)) {
    return { action: 'ask' };
  }

  const normalizedCwd = normalizePath(cwd);

  if (SECRETS_REF_PATTERN.test(commandLine)) {
    return {
      action: 'deny',
      reason: 'Shell commands referencing `.secrets` are forbidden to prevent leaking or staging secret values.'
    };
  }

  if (POWERSHELL_CMDLET_PATTERN.test(commandLine)) {
    return {
      action: 'deny',
      reason: 'PowerShell cmdlets are forbidden. Use native file tools or cross-platform CLI tools.'
    };
  }

  const segments = splitSegments(commandLine);

  for (const segment of segments) {
    const rawTokens = tokenize(segment);
    const { command, tokens } = unwrapCommandTokens(rawTokens);

    if (command === 'cd' && segments.length > 1) {
      return {
        action: 'deny',
        reason: 'Chained `cd` commands are forbidden. Use `yarn --cwd <repo>`, `npm --prefix <repo>`, or `git -C <repo>`.'
      };
    }

    if (SHELL_INSPECT_PATTERN.test(command) || (command === 'node' && isInlineNodeEval(tokens))) {
      return {
        action: 'deny',
        reason: 'Shell file-inspection commands (cat, type, head, sed, node -e/-p) are forbidden. Use native file read tools.'
      };
    }

    if (command === 'docker' || DOCKER_PATTERN.test(segment)) {
      return {
        action: 'deny',
        reason: 'Docker validation is forbidden locally. Use `yarn validate` or `npm run validate` instead.'
      };
    }

    const pkgManager = detectPackageManager(command, tokens);

    if (pkgManager === 'npm') {
      const targetsYarnRepo = YARN_REPOS_PATTERN.test(segment);
      const inYarnRepo = /(?:^|\/)(ingress-events-core|iitc-plugin-site-observer)(?:\/|$)/.test(normalizedCwd);
      const targetsNpmRepo = NPM_REPOS_PATTERN.test(segment) || /\bingress-events-ai-kit\b/i.test(segment);

      if (targetsYarnRepo || (inYarnRepo && !targetsNpmRepo)) {
        return {
          action: 'deny',
          reason: 'Stack violation: `ingress-events-core` and `iitc-plugin-site-observer` use Yarn, not npm.'
        };
      }
    }

    if (pkgManager === 'yarn') {
      const targetsNpmRepo = NPM_REPOS_PATTERN.test(segment);
      const inNpmRepo = /(?:^|\/)ingress-shards\.github\.io(?:\/|$)/.test(normalizedCwd);
      const targetsYarnRepo = YARN_REPOS_PATTERN.test(segment);

      if (targetsNpmRepo || (inNpmRepo && !targetsYarnRepo)) {
        return {
          action: 'deny',
          reason: 'Stack violation: `ingress-shards.github.io` uses npm, not Yarn.'
        };
      }
    }
  }

  let pendingForceAsk = null;

  for (const segment of segments) {
    const rawTokens = tokenize(segment);
    const { command, tokens } = unwrapCommandTokens(rawTokens);

    if (command === 'git') {
      const gitResult = evaluateGitSegment(tokens);
      if (gitResult.action === 'deny') {
        return gitResult;
      }
      if (gitResult.action === 'force_ask' && !pendingForceAsk) {
        pendingForceAsk = gitResult;
      }
    }

    if (command === 'node' && tokens.some((token) => /(?:^|[\\/])sync\.mjs$/i.test(token)) && !tokens.includes('--dry-run')) {
      if (!pendingForceAsk) {
        pendingForceAsk = {
          action: 'force_ask',
          reason: 'Running `sync.mjs` without `--dry-run` executes mutating git commands and requires explicit approval ("Execute git commands").'
        };
      }
    }
  }

  if (pendingForceAsk) {
    return pendingForceAsk;
  }

  if (segments.length === 1 && isKnownSafeSingleCommand(commandLine, normalizedCwd)) {
    return { action: 'allow' };
  }

  return { action: 'ask' };
}
