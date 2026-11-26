# Ingress Events AI Kit

Shared AI coding rules, on-demand workflow skills, and deterministic command guardrail hooks for the **Ingress Shards** repositories (`ingress-events-core`, `iitc-plugin-site-observer`, and `ingress-shards.github.io`).

---

## Purpose

The three Ingress Shards repositories sit alongside each other as independent Git repositories rather than a single monolith. Without a shared kit, coding standards and release workflows had to be duplicated across each repository and kept in sync manually.

**Ingress Events AI Kit** solves that by keeping one version-controlled source of truth that:
1. **Reduces context overhead** — Always-on standards stay concise in `rules/AGENTS.md` (with built-in SOLID/IoC guidance and 4 scoped read-only `agents/` roles: `impact-researcher`, `plan-challenger`, `code-reviewer`, and `parity-reviewer`), while multi-step runbooks live in 5 on-demand `skills/`.
2. **Enforces guardrails cleanly (data-driven hook + native templates)** — A minimal `PreToolUse` hook (`scripts/evaluate-command.mjs`) enforces dynamic workspace-scoped rules (blocking `.secrets` shell references across the full command line, plus per-segment checks for local `docker` denial, `cwd`-aware `npm`/`yarn` stack isolation, and `force_ask` on mutating `git` and `sync.mjs` without `--dry-run`) and automatically approves commands (`auto_approve` via `scripts/guard-antigravity.mjs` in Antigravity, `allow` via `scripts/guard-claude.mjs` in Claude Code) when every segment matches the declarative token rules in `examples/antigravity-permissions.json` (`permissionGrants.allow`)—requiring zero manual UI setup in Antigravity or Claude Code. `examples/antigravity-permissions.json` and `examples/claude-settings.json` also serve as reference templates for `agy` CLI and `.claude/settings.json`. A `PostToolUse` hook automatically cleans up stray build artifacts (`tsconfig.tsbuildinfo`, `yarn-error.log`).
3. **Stays tool-agnostic** — Uses a flat, dual-compatible layout that works out of the box in both **Antigravity** and **Claude Code** while sharing the same rules, skills, and pure Node.js guardrail engine.

---

## What's Inside

```text
ingress-events-ai-kit/
├── plugin.json                     # Antigravity plugin manifest
├── hooks.json                      # Antigravity PreToolUse & PostToolUse hooks (cwd = plugin root)
├── .claude-plugin/plugin.json      # Claude Code plugin manifest
├── hooks/hooks.json                # Claude Code PreToolUse & PostToolUse hooks
├── rules/
│   └── AGENTS.md                   # Always-on organization rules, SOLID/IoC & review policy
├── agents/
│   ├── impact-researcher.md        # Read-only blast-radius & cross-repo research subagent
│   ├── plan-challenger.md          # Read-only adversarial plan critic pre-"make it so"
│   ├── code-reviewer.md            # Present-state-only independent code reviewer
│   └── parity-reviewer.md          # Before-vs-after parity matrix reviewer
├── examples/
│   ├── antigravity-permissions.json# Native Antigravity Permission Grants template
│   └── claude-settings.json        # Native Claude Code settings.json permissions template
├── scripts/
│   ├── evaluate-command.mjs        # Slim dynamic guardrail hook (zero deps)
│   ├── clean-artifacts.mjs         # PostToolUse build-artifact cleaner
│   ├── init-umbrella.mjs           # Generates optional local umbrella workspace shims
│   ├── guard-antigravity.mjs       # Thin Antigravity stdin/stdout adapter
│   └── guard-claude.mjs            # Thin Claude Code stdin/stdout adapter
├── skills/
│   ├── prepare-commits/SKILL.md    # semantic-release & Conventional Commits workflow
│   ├── post-release-sync/          # Cross-platform status summary & tag/branch sync across all 4 repos
│   ├── cross-repo-release/SKILL.md # Local sync-to-siblings.js & SemVer release flow
│   ├── season-setup/SKILL.md       # Start-of-season code impact check & manifest/blueprint build
│   └── weekend-data-update/SKILL.md# Post-weekend raw data ingestion & validation
├── tests/
│   └── evaluate-command.test.mjs   # Built-in node:test suite
└── package.json                    # Minimal ESM manifest ("test", "init:umbrella")
```

---

## Installation

Clone this repository anywhere on your machine (for example, alongside your other Ingress Shards repositories under `~/projects/ingress-shards/`):

```bash
git clone https://github.com/ingress-shards/ingress-events-ai-kit.git
```

### Antigravity

Antigravity's `plugins.json` points to the **parent directory** containing your plugin folder (`<path-to-parent-dir>`) and scans one level deep. Using `include_only` ensures Antigravity skips any sibling code repositories in that parent folder and loads only `ingress-events-ai-kit`.

Create or update `~/.gemini/config/plugins.json`, replacing `~/projects/ingress-shards` with whichever parent directory contains your `ingress-events-ai-kit` clone:

```json
{
  "entries": [
    {
      "path": "~/projects/ingress-shards",
      "include_only": ["ingress-events-ai-kit"]
    }
  ]
}
```

> **Windows note:** `~/` resolves to `%USERPROFILE%` (e.g., `C:\Users\<you>\.gemini\config\plugins.json`).

Once saved, Antigravity automatically discovers `plugin.json`, `hooks.json`, `rules/AGENTS.md`, `agents/`, and `skills/` in your next conversation. You can inspect or toggle the plugin anytime from the **Customizations / Plugins** UI.

### Claude Code

Claude Code natively discovers `.claude-plugin/plugin.json`, `hooks/hooks.json`, `agents/`, and `skills/` directly from the repository root, and reads `CLAUDE.md` files natively (using `@AGENTS.md` if you reference repo `AGENTS.md` files).

1. **Load the plugin (skills + `PreToolUse` / `PostToolUse` Bash hooks):**
   ```bash
   claude --plugin-dir <path-to-ingress-events-ai-kit>
   ```
   *(Or copy the `PreToolUse` / `PostToolUse` blocks from `hooks/hooks.json` into `~/.claude/settings.json` with absolute paths to `scripts/guard-claude.mjs` and `scripts/clean-artifacts.mjs` if you prefer not to pass `--plugin-dir`.)*

2. **Load the shared organization rules & repo conventions:**
   Add a one-line import to `~/.claude/CLAUDE.md`:
   ```markdown
   @<path-to-ingress-events-ai-kit>/rules/AGENTS.md
   ```
   When working inside any of the 3 product repos with Claude Code, either add `@AGENTS.md` to a local `CLAUDE.md` (or `.claude/CLAUDE.md`) or reference the repo's `AGENTS.md` directly.

### Optional Multi-Repo Workspace Setup

Each of the four repositories is completely standalone. If you prefer opening all four sibling folders together under one local umbrella directory (not a Git repo), run `init:umbrella` to generate the three local shim files (`package.json`, `.yarnrc.yml`, and `AGENTS.md`) dynamically from sibling `ingress-events-core` so Yarn versions never drift:

```bash
npm --prefix <path-to-ingress-events-ai-kit> run init:umbrella -- --dry-run
npm --prefix <path-to-ingress-events-ai-kit> run init:umbrella
```

Existing files are preserved unless `--force` is passed (pass `--dir <path>` to target a different parent directory).

---

## Native Command Allowlists (Setup Guide)

Both Antigravity and Claude Code use the declarative allowlist in [`examples/antigravity-permissions.json`](examples/antigravity-permissions.json) automatically via `scripts/evaluate-command.mjs` (`PreToolUse` returns `auto_approve` in Antigravity and `allow` in Claude Code when all command segments match). The files in `examples/` also serve as standalone native templates (`Deny > Ask > Allow` precedence):

- **Antigravity 2.0 / IDE:** **Zero manual UI setup required** — `scripts/evaluate-command.mjs` loads `permissionGrants.allow` directly from [`examples/antigravity-permissions.json`](examples/antigravity-permissions.json) and returns `auto_approve` via `scripts/guard-antigravity.mjs` inside Ingress workspaces. *(Do not hand-edit `~/.gemini/config/config.json`; the Language Server manages it atomically.)*
- **Antigravity CLI (`agy`):** Merge [`examples/antigravity-permissions.json`](examples/antigravity-permissions.json) into `~/.gemini/antigravity-cli/settings.json` if you also want static CLI rules.
- **Claude Code:** `scripts/guard-claude.mjs` already returns `allow` for matching commands via `evaluate-command.mjs`, and you can optionally copy [`examples/claude-settings.json`](examples/claude-settings.json) to `.claude/settings.json` at your workspace root (or merge into `~/.claude/settings.json`) for native standalone rules.

---

## Guardrail Hook Behavior

The `PreToolUse` hook (`scripts/evaluate-command.mjs`) is **workspace-scoped**: outside Ingress Shards workspaces it passes commands through untouched (`ask`). Inside Ingress Shards workspaces it enforces dynamic checks first, auto-approves commands matching [`examples/antigravity-permissions.json`](examples/antigravity-permissions.json), and defers everything else (`ask`):

| Rule | Action | Why |
| :--- | :--- | :--- |
| Shell commands referencing `.secrets` | **Deny** | Prevent secret values leaking or being staged |
| Local `docker` / `validate:docker` | **Deny** | Containerized checks run in GitHub Actions CI |
| `cwd`-aware & `--cwd`/`--prefix`/`-C` `npm` / `yarn` stack mixups | **Deny** | `core` & `site-observer` use Yarn; map app & `ai-kit` use npm |
| Mutating `git` commands | **Force Ask** | Require explicit `"Execute git commands"` approval |
| `sync.mjs` invoked without `--dry-run` | **Force Ask** | Executes mutating git commands across repos |
| Commands where every segment matches `examples/antigravity-permissions.json` (`permissionGrants.allow`) and contains no shell substitutions (`$(...)`, backticks), unquoted redirections (`<`, `>`), unquoted parentheses, or unclosed/escaped quotes | **Auto-Approve (`auto_approve` / `allow`)** | Zero-prompt execution for safe whole-repo checks and read-only `git` |
| All other commands (unlisted scripts, `git diff <file>`, etc.) | **Ask** (with `reason`) | Attaches `Not in ingress-events-ai-kit allowlist (evaluate-command).` so prompts prove the hook ran (missing reason = bypassed hook) and surface candidate commands to classify as `allow` or `deny` in `examples/antigravity-permissions.json` / `examples/claude-settings.json` |
| `PostToolUse` after `build` / `validate` (`scripts/clean-artifacts.mjs`) | **Auto-clean** | Removes stray `tsconfig.tsbuildinfo` & `yarn-error.log` |

---

## Testing & Maintenance

Zero `npm install` is required — tests use Node's built-in test runner (`node:test`):

```bash
npm --prefix <path-to-ingress-events-ai-kit> test
```
