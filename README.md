# Ingress Events AI Kit

Shared AI coding rules, on-demand workflow skills, and deterministic command guardrail hooks for the **Ingress Shards** repositories (`ingress-events-core`, `iitc-plugin-site-observer`, and `ingress-shards.github.io`).

---

## Purpose

The three Ingress Shards repositories sit alongside each other as independent Git repositories rather than a single monolith. Without a shared kit, coding standards and release workflows had to be duplicated across each repository and kept in sync manually.

**Ingress Events AI Kit** solves that by keeping one version-controlled source of truth that:
1. **Reduces context overhead** — Always-on standards stay concise in `rules/AGENTS.md` (with built-in SOLID/IoC guidance and independent read-only subagent review for `>2`-file changes and rule/architecture refactors), while multi-step runbooks live in 5 on-demand `skills/`.
2. **Enforces guardrails deterministically** — `PreToolUse` hooks block PowerShell cmdlets, shell file-reading commands, `.secrets` shell access, ad-hoc `git diff <file>`, local Docker validation, chained `cd` commands, and `npm`/`yarn` stack mixups; auto-allow known-safe single validation/status commands; and require explicit approval on non-read-only `git` commands (and `sync.mjs` without `--dry-run`). A `PostToolUse` hook automatically cleans up stray build artifacts (`tsconfig.tsbuildinfo`, `yarn-error.log`).
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
├── scripts/
│   ├── evaluate-command.mjs        # Pure, workspace-scoped guardrail engine (zero deps)
│   ├── clean-artifacts.mjs         # PostToolUse build-artifact cleaner
│   ├── init-umbrella.mjs           # Generates optional local umbrella workspace shims
│   ├── guard-antigravity.mjs       # Thin Antigravity stdin/stdout adapter
│   └── guard-claude.mjs            # Thin Claude Code stdin/stdout adapter
├── skills/
│   ├── prepare-commits/SKILL.md    # semantic-release & Conventional Commits workflow
│   ├── post-release-sync/          # Cross-platform tag/branch sync across the 3 product repos
│   ├── cross-repo-release/SKILL.md # Local sync-to-siblings.js & SemVer release flow
│   ├── season-setup/SKILL.md       # Start-of-season code impact check & manifest/blueprint build
│   └── weekend-data-update/SKILL.md# Post-weekend raw data ingestion & validation
├── tests/
│   └── evaluate-command.test.mjs   # Built-in node:test suite
└── package.json                    # Minimal ESM manifest ("test": "node --test")
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

Once saved, Antigravity automatically discovers `plugin.json`, `hooks.json`, `rules/AGENTS.md`, and `skills/` in your next conversation. You can inspect or toggle the plugin anytime from the **Customizations / Plugins** UI.

### Claude Code

Claude Code natively discovers `.claude-plugin/plugin.json`, `hooks/hooks.json`, and `skills/` directly from the repository root, and reads `CLAUDE.md` files natively (using `@AGENTS.md` if you reference repo `AGENTS.md` files).

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

## Guardrail Hook Behavior

The `PreToolUse` guardrail (`scripts/evaluate-command.mjs`) is **workspace-scoped**: if you open an unrelated project on the same machine, it passes commands through untouched. Inside Ingress Shards workspaces it enforces:

| Rule | Action | Why |
| :--- | :--- | :--- |
| Shell commands referencing `.secrets` | **Deny** | Prevent secret values leaking or being staged |
| PowerShell cmdlets (`Get-ChildItem`, `Set-Location`, `Select-String`, etc.) | **Deny** | Enforce cross-platform CLI & native IDE tools |
| Shell file readers (`cat`, `type`, `head`, `sed`, `node -e/-p`) | **Deny** | Use native file read/edit tools instead |
| `git diff <file>` (passing file/path args to `git diff`) | **Deny** | Keeps `"Always allow"` permission signatures sticky |
| Local `docker` / `validate:docker` | **Deny** | Containerized checks run in GitHub Actions CI |
| Chained `cd <dir> && ...` | **Deny** | Use `yarn --cwd`, `npm --prefix`, or `git -C` |
| Cross-stack `npm` / `yarn` mixups | **Deny** | `core` & `site-observer` use Yarn; map app uses npm |
| Non-read-only `git` commands (strict read-only allowlist) | **Force Ask** | Require explicit `"Execute git commands"` approval |
| `sync.mjs` invoked without `--dry-run` | **Force Ask** | Executes mutating git commands across repos |
| Exact single `validate` / `test` / `status -s` / `diff --stat` commands | **Allow** | Eliminate repetitive permission prompts on safe commands |
| `PostToolUse` after `build` / `validate` (`scripts/clean-artifacts.mjs`) | **Auto-clean** | Removes stray `tsconfig.tsbuildinfo` & `yarn-error.log` |

---

## Testing & Maintenance

Zero `npm install` is required — tests use Node's built-in test runner (`node:test`):

```bash
npm --prefix <path-to-ingress-events-ai-kit> test
```
