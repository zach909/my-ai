# Workbench

Coding-agent features for NeuroClaw: the things that make an agent usable on a real project. Everything is written in this repository (Node built-ins only); nothing is a third-party library, and no outside model or provider is involved. The code is in `interface/workbench/`.

## Use it

```bash
neuroclaw run "what changed in the last commit?" --agent plan --output json   # one prompt, one answer
git diff | neuroclaw run "review this diff"                                    # piped input is added after the prompt
neuroclaw tui                                                                  # the terminal interface
neuroclaw wb status                                                            # everything below, as commands
```

`neuroclaw` is `node dist/interface/main.js`. The same features are on the running server under `/api/workbench/*` (owner or admin only).

## What it does

| Feature | Where | Notes |
| --- | --- | --- |
| Agent modes | `agents.ts` | `build`, `plan` (read-only), `general` (may start sub-agents), `explore` (fast, read-only). A read-only agent is sent down the engine's text-only path, so it cannot use a tool at all. |
| Custom agents | `.neuroclaw/agents/*.md` | Frontmatter `description`, `tools`, `model`, `effort`, `mode`; the body is the system prompt. An agent can only **narrow** what is allowed, never grant. |
| Slash commands | `.neuroclaw/commands/*.md` | `$ARGUMENTS`, `$1`..`$9`, `@file` lines; folders become `a:b` names. |
| Permission rules | `permissions.ts` | `allow` / `ask` / `deny` per tool and per agent, globs on paths, commands and domains. Layers: managed > user > project > built-in. A deny anywhere is final. Compound commands need every part allowed; `$(...)` and backticks are never allowed by a pattern. |
| Hooks and formatters | `hooks.ts` | `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PreCompact`, `Stop`. Exit 2 blocks. Clean environment, time limit, output cap. Formatters run as an argv list with no shell. |
| Checkpoints | `checkpoints.ts` | One per turn, content-addressed, bounded. `undo`, `redo`, `rewind ID [code\|conversation\|both]`. Refuses to overwrite a file you changed by hand unless forced. Every write by the file plugin is recorded. |
| Sessions | `sessions.ts` | Resume, fork, rename, search, truncate. Share links are read-only, redacted, expiring and revocable. |
| Instruction files | `instructions.ts` | `AGENTS.md`, else `NEUROCLAW.md`, `CLAUDE.md`, `.cursorrules`, `.github/copilot-instructions.md`, in layers from the managed folder, the user, the project root and nested folders. `@file.md` imports. |
| Auto-memory | `instructions.ts` | Short, de-duplicated, bounded, secrets refused. |
| Compaction | `compaction.ts` | Counted in characters (there is no tokenizer). Keeps the task, pinned messages, recent turns and diffs; summarises the rest with the deterministic compressor. |
| Sub-agents and teams | `teams.ts` | Parallel, own context, only a summary returns; depth and count capped. Teams share a task list (one claimant per task) and a mailbox. |
| Tool servers | `mcp.ts` | Model Context Protocol client over stdio, http and sse, written from the protocol. See "Safety" below. |
| Diagnostics | `diagnostics.ts` | After an edit: JSON, JavaScript, Python and (when the project has `tsc`) TypeScript checks, plus any language server you list in `lsp.json`. |
| Routing | `routing.ts` | Roles `fast` / `deep` / `remote` map to the project's own engines; `effort` low/medium/high sets the dial. |
| Offline mode | `netguard.ts` | `NEUROCLAW_OFFLINE=1`, `"offline": true` in settings, or `"offline": true` in the managed file. Only this machine is reachable through the workbench's own doors. |
| Bundles | `bundles.ts` | `neuroclaw wb bundle install DIR`: commands, agents, hooks, tool servers from a local folder. |
| Usage | `usage.ts` | Local only, bytes not tokens, bounded, never sent anywhere. |

## Safety

- **A project cannot run code or grant itself anything.** Its `hooks.json`, `mcp.json`, `lsp.json` and the `allow` rules in its `settings.json` do nothing until you approve that exact file with `neuroclaw wb trust`. Edit the file and the approval no longer matches. Rules that only restrict always apply.
- **Adding a tool server, installing a bundle and approving a project are command-line only.** They start programs, so there is no HTTP route for them.
- **The workbench can only add refusals to the agent's tool gate** (`ToolGate.useExtraCheck`). It runs after the danger protocol and the owner-only rule, never instead of them.
- **Administrator policy** lives in `/etc/neuroclaw/managed.json` (override: `NEUROCLAW_MANAGED_FILE`): `permissions`, `hooks`, `mcp.disabled`, `mcp.allowedServers`, `offline`, `disableProjectExtensions`, `routing`, `usageRetentionDays`. Nothing a user or project writes can loosen it.

## What it does not do (stated plainly)

- **No outside model providers and no local-model runners.** The standing rule bans third-party models and services (and Ollama and its look-alikes); routing is between the project's own engines only. Adding provider support needs a fresh yes from the owner.
- **Hooks and permission rules cover the agent's tools only at tool level.** The agent's own tools pass the gate with the tool's name, not its exact command, so `bash(git *)` patterns apply to tools the workbench runs itself (the terminal interface's `!`, tool-server calls, `runTool`); the agent's own terminal tool is matched by the bare name. `PostToolUse` runs for workbench-run tools, not for the agent's own.
- **Checkpoints are not git.** They are their own store; they never touch your repository's history.
- **Sizes are counted in characters and bytes, not tokens.** There is no tokenizer in this project.
- **No editor extensions, no hosted gateway, no prompt caching.** The HTTP routes are the integration point for an editor.
- **A "borrowed computer" engine choice is a recommendation** until the engine acts on it (see `core/engine-router.ts`).
