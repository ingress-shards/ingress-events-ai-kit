/**
 * Shared PreToolUse command guardrail engine for Ingress Shards repositories.
 *
 * Consumed by `scripts/guard-antigravity.mjs` and `scripts/guard-claude.mjs`
 * (and tested directly by `tests/evaluate-command.test.mjs`).
 *
 * Evaluation precedence:
 *   1. Outside Ingress Shards workspaces -> `ask` (pass through untouched)
 *   2. Hard blocks (`deny`) -> `.secrets` shell access, local Docker, npm/Yarn stack mixups
 *   3. Forced confirmations (`force_ask`) -> mutating `git` commands, `sync.mjs` without `--dry-run`
 *   4. Data-driven allowlist (`allow`) -> every command segment passes safety gate + matches `examples/antigravity-permissions.json`
 *      (`guard-antigravity.mjs` maps `'allow'` -> `'auto_approve'`; `guard-claude.mjs` emits `'allow'`)
 *   5. Everything else -> `ask`
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ============================================================================
// 1. Workspace & Repo Classification Patterns
// ============================================================================

const PRODUCT_REPO_NAMES = ['ingress-events-core', 'iitc-plugin-site-observer', 'ingress-shards.github.io'];

// Case-insensitive directory match for the umbrella folder or any of the 4 standalone repos.
const INGRESS_PATH_PATTERN =
  /(?:^|\/)(ingress-shards|ingress-events-core|iitc-plugin-site-observer|ingress-shards\.github\.io|ingress-events-ai-kit)(?:\/|$)/i;

// Matches `.secrets` as a standalone path/arg token (including redirections like `>.secrets` or `--env-file=.secrets`),
// checked across the entire unsplit command line so chained commands cannot slip through.
const SECRETS_REF_PATTERN = /(?:^|[\s"'`\\/<>=;|&(])\.secrets(?:$|[\s"'`\\/>;|&)])/i;

// Package-manager partitioning:
// - Negative lookbehind prevents npm installs of `@ingress-shards/ingress-events-core` from tripping Yarn checks.
const YARN_REPO_PATTERN = /(?<!@ingress-shards\/)\b(ingress-events-core|iitc-plugin-site-observer)\b/i;
const NPM_REPO_PATTERN = /\b(ingress-shards\.github\.io|ingress-events-ai-kit)\b/i;
const IN_YARN_REPO_PATTERN = /(?:^|\/)(ingress-events-core|iitc-plugin-site-observer)(?:\/|$)/;
const IN_NPM_REPO_PATTERN = /(?:^|\/)(ingress-shards\.github\.io|ingress-events-ai-kit)(?:\/|$)/;

// ============================================================================
// 2. Command-Start & Guardrail Patterns
// ============================================================================

// Allows leading env assignments (`FOO=1 cmd`) and `env -i cmd`, plus optional absolute/relative binary paths and `.cmd`/`.exe`.
const CMD_PREFIX = '^\\s*(?:(?:[A-Za-z_]\\w*=\\S+\\s+)|(?:env\\s+(?:-\\S+\\s+)*))*';
const EXEC_PATH = '(?:[^\\s"\'`]*[\\\\/])?';
const NPM_CMD_PATTERN = new RegExp(`${CMD_PREFIX}(?:corepack\\s+)?${EXEC_PATH}npm(?:\\.(?:cmd|exe))?\\b`, 'i');
const YARN_CMD_PATTERN = new RegExp(`${CMD_PREFIX}(?:corepack\\s+)?${EXEC_PATH}yarn(?:\\.(?:cmd|exe))?\\b`, 'i');
const DOCKER_CMD_PATTERN = new RegExp(
  `${CMD_PREFIX}${EXEC_PATH}(?:docker(?:\\.exe)?\\b|(?:corepack\\s+)?${EXEC_PATH}(?:yarn|npm)(?:\\.(?:cmd|exe))?\\b[^\\n]*\\bvalidate:docker\\b)`,
  'i'
);

// Matches mutating git commands after skipping leading global flags (e.g., `-C <repo>` or `--no-pager`):
// - Unconditionally mutating subcommands (`commit`, `push`, `add`, `checkout`, `worktree`, etc.)
// - Mutating forms of `branch` / `tag` (delete/move/rename/create, while allowing read-only `-a`, `--merged`, `--show-current`, `--list`)
// - `stash` except `stash list` / `stash show`
// - Mutating `remote` subcommands (while allowing `remote -v` / `remote show`)
const MUTATING_GIT_PATTERN = new RegExp(
  `${CMD_PREFIX}${EXEC_PATH}git(?:\\.exe)?\\b(?:\\s+(?:-[Cc]\\s+(?:"[^"]+"|'[^']+'|\\S+)|-\\S+))*\\s+(?:(?:commit|push|pull|add|rm|mv|restore|checkout|switch|merge|rebase|reset|cherry-pick|revert|init|worktree|clean|am|apply)\\b|branch\\s+(?:-[A-Za-z]*[dDmMcCfl][A-Za-z]*\\b|--(?:delete|move|copy|force|set-upstream-to|unset-upstream|edit-description|create-reflog)\\b|[^-\\s])|tag\\s+(?:-[A-Za-z]*[dasfm][A-Za-z]*\\b|--(?:delete|annotate|sign|force|message)\\b|[^-\\s])|stash\\b(?:\\s+(?!list\\b|show\\b)|\\s*$)|remote\\s+(?:add|remove|rm|rename|set-url|prune|update)\\b)`,
  'i'
);

// Post-release sync script; safe only when `--dry-run` is present in the same command segment.
const SYNC_SCRIPT_PATTERN = /(?:^|[\s"'`\\/])sync\.mjs(?:$|[\s"'`])/i;

const ANTIGRAVITY_PERMISSIONS_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../examples/antigravity-permissions.json'
);

// ============================================================================
// 3. Data-Driven Allowlist Compilation (`examples/antigravity-permissions.json`)
// ============================================================================

/**
 * Compiles a `command(...)` or `command(regex:...)` rule entry into per-token matchers.
 *
 * Antigravity evaluates `command(regex:...)` rules whitespace-token by whitespace-token
 * (`^(?:token)$`), with an optional trailing `.*` token enabling variable extra arguments.
 */
export function compileAllowRule(rule) {
  if (typeof rule !== 'string') return null;

  if (rule.startsWith('command(regex:') && rule.endsWith(')')) {
    const inner = rule.slice('command(regex:'.length, -1).trim();
    if (!inner) return null;
    const rawTokens = inner.split(/\s+/);
    const allowTrailing = rawTokens[rawTokens.length - 1] === '.*';
    const patternTokens = allowTrailing ? rawTokens.slice(0, -1) : rawTokens;
    // Reject bare `command(regex:.*)` so an empty prefix can never become a catch-all auto-allow rule.
    if (patternTokens.length === 0) return null;
    try {
      const tokens = patternTokens.map((token) => new RegExp(`^(?:${token})$`));
      return { tokens, isRegex: true, allowTrailing };
    } catch (error) {
      console.error(`[evaluate-command] Invalid allow regex rule "${rule}":`, error);
      return null;
    }
  }

  if (rule.startsWith('command(') && rule.endsWith(')')) {
    const inner = rule.slice('command('.length, -1).trim();
    if (!inner) return null;
    return { tokens: inner.split(/\s+/), isRegex: false, allowTrailing: false };
  }

  return null;
}

/**
 * Loads and compiles `permissionGrants.allow` rules from `examples/antigravity-permissions.json`
 * once at module load so the JSON template stays the single source of truth.
 */
function loadDefaultAllowRules() {
  try {
    const parsed = JSON.parse(readFileSync(ANTIGRAVITY_PERMISSIONS_PATH, 'utf8'));
    const raw = Array.isArray(parsed?.permissionGrants?.allow) ? parsed.permissionGrants.allow : [];
    return raw.map(compileAllowRule).filter(Boolean);
  } catch (error) {
    console.error('[evaluate-command] Failed to load allow rules:', error);
    return [];
  }
}

const DEFAULT_ALLOW_RULES = loadDefaultAllowRules();

// ============================================================================
// 4. Allowlist Safety Gate & Segment Matching
// ============================================================================

/**
 * Detects shell syntax that is unsafe or shell-ambiguous to auto-approve under trailing `.*`
 * allow rules: unclosed quotes, backslash-escaped quotes (`\'`, `\"`), command substitutions
 * (`$(...)`, backticks), unquoted redirections (`<`, `>`), and unquoted parentheses (`(`, `)`).
 *
 * Inside single quotes `'...'`, `$()`, backticks, `<`, `>`, and `()` are literal characters in
 * POSIX/PowerShell and are permitted (e.g., `git grep '$(literal)'`), unless the quote itself is unclosed.
 */
function hasUnsafeShellSyntax(segment) {
  let quote = null;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    const next = segment[i + 1];

    if (quote) {
      if (quote === '"' && ch === '\\') {
        // `\"` escapes inside bash double quotes but terminates strings in PowerShell/`cmd.exe`.
        if (next === '"') return true;
        if (next === '\\') {
          i++;
          continue;
        }
      }
      if (ch === quote) {
        quote = null;
        continue;
      }
      // Double quotes still expand backticks and `$(...)` in POSIX shells and PowerShell.
      if (quote === '"' && (ch === '`' || (ch === '$' && next === '('))) {
        return true;
      }
      continue;
    }

    // Backslash-escaped quotes outside quotes mean different things in bash vs. PowerShell/`cmd.exe`.
    if (ch === '\\' && (next === "'" || next === '"')) {
      return true;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    // Reject backticks, I/O redirections, `$(...)`, and unquoted parentheses (PowerShell/fish subexpressions).
    if (ch === '`' || ch === '>' || ch === '<' || ch === '(' || ch === ')' || (ch === '$' && next === '(')) {
      return true;
    }
  }
  // Unclosed quotes can leave the rest of a line active in shells like `cmd.exe` (which ignores `'`).
  return quote !== null;
}

/**
 * Returns true when a single command segment passes the unsafe-syntax check and matches
 * at least one compiled allow rule.
 */
function segmentMatchesAllowRules(segment, allowRules) {
  if (!segment || hasUnsafeShellSyntax(segment)) return false;
  const segTokens = segment.trim().split(/\s+/).filter(Boolean);
  if (segTokens.length === 0 || !Array.isArray(allowRules)) return false;

  return allowRules.some((rule) => {
    if (rule.allowTrailing ? segTokens.length < rule.tokens.length : segTokens.length !== rule.tokens.length) {
      return false;
    }
    return rule.tokens.every((matcher, idx) =>
      rule.isRegex ? matcher.test(segTokens[idx]) : segTokens[idx] === matcher
    );
  });
}

// ============================================================================
// 5. Workspace Detection (Scoped Activation)
// ============================================================================

function normalizePath(value) {
  return String(value ?? '').replace(/\\/g, '/').toLowerCase();
}

/**
 * Checks whether the current working directory or any active workspace path
 * belongs to the Ingress Shards repositories.
 * Matches directory names first, then falls back to checking for sibling product repos on disk
 * so custom parent folders (e.g., temp test dirs or renamed umbrellas) still activate guardrails.
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

// ============================================================================
// 6. Command Segment Splitter
// ============================================================================

/**
 * Splits a shell command string on unquoted `&&`, `||`, `;`, `|`, `&`, and newlines,
 * preserving `&` inside shell redirections such as `2>&1` or `<&0`.
 *
 * Intentionally avoids entering quote mode on unclosed delimiters or backslash-escaped
 * quotes (`\'`, `\"`, `` \` ``) so malformed/crafted prefixes cannot hide chained
 * `docker` or `git push` segments from per-segment guardrail checks.
 */
function splitCommandSegments(commandLine) {
  const segments = [];
  let current = '';
  let quote = null;

  for (let i = 0; i < commandLine.length; i++) {
    const ch = commandLine[i];
    const next = commandLine[i + 1];

    if (quote) {
      if (ch === quote) quote = null;
      current += ch;
      continue;
    }

    if (ch === '\\' && (next === "'" || next === '"' || next === '`')) {
      current += ch + next;
      i++;
      continue;
    }

    if ((ch === '"' || ch === "'" || ch === '`') && commandLine.indexOf(ch, i + 1) !== -1) {
      quote = ch;
      current += ch;
      continue;
    }

    if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) {
      if (current.trim()) segments.push(current.trim());
      current = '';
      i++;
      continue;
    }

    const isRedirectionAmp = ch === '&' && (commandLine[i - 1] === '>' || commandLine[i - 1] === '<');
    if (!isRedirectionAmp && (ch === ';' || ch === '|' || ch === '&' || ch === '\n' || ch === '\r')) {
      if (current.trim()) segments.push(current.trim());
      current = '';
      continue;
    }

    current += ch;
  }

  if (current.trim()) segments.push(current.trim());
  return segments;
}

// ============================================================================
// 7. Stack Isolation (`npm` vs. `Yarn` per Repo)
// ============================================================================

/**
 * Extracts an explicit `--prefix`/`-C` or `--cwd` target path, returning `null` for `.`/`./`
 * so relative current-directory invocations fall back to `cwd` resolution.
 */
function extractFlagTarget(segment, flagPattern) {
  const match = segment.match(flagPattern);
  const value = (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim();
  return !value || /^\.[\\/]?$/.test(value) ? null : value;
}

/**
 * Enforces npm vs. Yarn stack isolation per command segment using explicit target flags or `cwd` fallback.
 * When an explicit target (`--prefix`/`-C`/`--cwd`) is present, it overrides `cwd` so cross-repo
 * commands like `npm --prefix ingress-shards.github.io test` succeed from a Yarn `cwd`.
 */
function evaluateStackViolation(segment, normalizedCwd) {
  if (NPM_CMD_PATTERN.test(segment)) {
    // `--prefix` is case-insensitive only in our pattern, while `-C` must stay uppercase (not npm `-c`).
    const target = extractFlagTarget(
      segment,
      /(?:^|\s)(?:--[pP][rR][eE][fF][iI][xX]|-C)(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/
    );
    const bad = target
      ? YARN_REPO_PATTERN.test(target)
      : YARN_REPO_PATTERN.test(segment) ||
        (IN_YARN_REPO_PATTERN.test(normalizedCwd) && !NPM_REPO_PATTERN.test(segment));
    if (bad) {
      return {
        action: 'deny',
        reason: 'Stack violation: `ingress-events-core` and `iitc-plugin-site-observer` use Yarn, not npm.'
      };
    }
  }

  if (YARN_CMD_PATTERN.test(segment)) {
    const target = extractFlagTarget(segment, /(?:^|\s)--cwd(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/i);
    const bad = target
      ? NPM_REPO_PATTERN.test(target)
      : NPM_REPO_PATTERN.test(segment) ||
        (IN_NPM_REPO_PATTERN.test(normalizedCwd) && !YARN_REPO_PATTERN.test(segment));
    if (bad) {
      return {
        action: 'deny',
        reason: 'Stack violation: `ingress-shards.github.io` and `ingress-events-ai-kit` use npm, not Yarn.'
      };
    }
  }

  return null;
}

// ============================================================================
// 8. Main Evaluation Pipeline
// ============================================================================

/**
 * Evaluates Ingress Shards workspace guardrails and data-driven allow rules from
 * `examples/antigravity-permissions.json`.
 */
export function evaluateCommand(
  commandLine,
  { cwd = '', workspacePaths = [], inWorkspace, allowRules = DEFAULT_ALLOW_RULES } = {}
) {
  // Stage 1: Pass through outside Ingress Shards workspaces (never impose repo rules on unrelated projects).
  if (!commandLine || !(inWorkspace ?? isIngressWorkspace(cwd, workspacePaths))) {
    return { action: 'ask' };
  }

  // Stage 2: Pre-split `.secrets` check across the entire command line.
  if (SECRETS_REF_PATTERN.test(commandLine)) {
    return {
      action: 'deny',
      reason: 'Shell commands referencing `.secrets` are forbidden to prevent leaking or staging secret values.'
    };
  }

  const normalizedCwd = normalizePath(cwd);
  const segments = splitCommandSegments(commandLine);
  // Defer `force_ask` until all segments are scanned so a later `deny` still beats an earlier `force_ask`.
  let pendingForceAsk = null;

  // Stage 3: Per-segment hard blocks (`deny`) and forced confirmations (`force_ask`).
  for (const segment of segments) {
    if (DOCKER_CMD_PATTERN.test(segment)) {
      return {
        action: 'deny',
        reason: 'Docker validation is forbidden locally. Use `yarn validate` or `npm run validate` instead.'
      };
    }

    const stackDeny = evaluateStackViolation(segment, normalizedCwd);
    if (stackDeny) {
      return stackDeny;
    }

    if (!pendingForceAsk && MUTATING_GIT_PATTERN.test(segment)) {
      pendingForceAsk = {
        action: 'force_ask',
        reason: 'Non-read-only git commands require explicit user approval ("Execute git commands").'
      };
    }

    if (!pendingForceAsk && SYNC_SCRIPT_PATTERN.test(segment) && !/(?:^|\s)--dry-run(?:\s|$)/.test(segment)) {
      pendingForceAsk = {
        action: 'force_ask',
        reason: 'Running `sync.mjs` without `--dry-run` executes mutating git commands and requires explicit approval ("Execute git commands").'
      };
    }
  }

  if (pendingForceAsk) {
    return pendingForceAsk;
  }

  // Stage 4: Auto-approve only when every segment passes the syntax safety gate and matches an allow rule.
  if (segments.length > 0 && segments.every((segment) => segmentMatchesAllowRules(segment, allowRules))) {
    return { action: 'allow' };
  }

  // Stage 5: Safe default for any unlisted or flagged command (reason proves the hook ran).
  return {
    action: 'ask',
    reason: 'Not in ingress-events-ai-kit allowlist (evaluate-command).'
  };
}
