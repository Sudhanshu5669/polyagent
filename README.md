# polyagent

Run Claude Code, Codex and Antigravity as one team from your terminal: an orchestrator plans the work and hands it to specialist employees (frontend, backend, art, reviewer…), running independent tasks in parallel.

> Status: early. You can hire employees and chat with each one directly today. The orchestrator that runs them as a team is next.

## Install

```sh
npm install -g polyagent
```

Requires Node 22+ and at least one agent CLI: [Claude Code](https://docs.claude.com/en/docs/claude-code) (`claude`), [Codex](https://github.com/openai/codex) (`codex`) or [Antigravity](https://antigravity.google) (`agy`). polyagent uses each CLI's own login and never touches its credentials.

## Use

```sh
cd your-project
polyagent
```

On first launch polyagent looks for your agent CLIs (saved paths, then `PATH`, then common install folders such as npm, Homebrew, bun, Volta, pnpm and nvm). If one lives somewhere unusual, add its path in the setup screen. Then it offers to create `.polyagent/` in the project, at the git root if you're in a subfolder.

### Employees

Press `n` on the dashboard to hire one. Pick a starting role (frontend, backend, reviewer, tests, art, docs, or blank), name them, choose the agent CLI and permissions, and save. Each employee is a Markdown file in `.polyagent/employees/`:

```md
---
name: Maya
role: backend
provider: codex
permissions: auto-edit
owns: [src/api/**, prisma/**]
summary: Builds REST endpoints and DB schema. Never touches UI.
briefing: Precise spec, file paths, acceptance criteria. No prose.
---
You are a backend engineer on this codebase...
```

`summary` and `briefing` are for the orchestrator: what to send this employee, and how to phrase it. Edit employees in the form (`e`) or in your editor (`o`).

| Permissions | Claude Code | Codex | Antigravity |
| --- | --- | --- | --- |
| `read-only` | default mode, nothing approved | `--sandbox read-only` | no extra flags |
| `auto-edit` | `acceptEdits` | `--sandbox workspace-write` | `--mode accept-edits` |
| `full-auto` | `bypassPermissions` | `--sandbox danger-full-access` | `--dangerously-skip-permissions` |

Anything that would need approval is blocked, never left hanging, and shows as *blocked* in the chat.

Press `⏎` on an employee to chat with them directly. Their session is resumed between messages and across restarts; `ctrl+n` starts fresh, `ctrl+o` shows thinking and tool output, `ctrl+c` stops them. Codex and Antigravity support is marked experimental until it has been verified against real installs.

### Commands

| Command | What it does |
| --- | --- |
| `polyagent` | Open the interface |
| `polyagent init` | Set up `.polyagent/` here without prompts |
| `polyagent doctor [--json]` | Check agent CLIs, workspace and settings |
| `polyagent config [--json]` | Show effective settings and where each comes from |
| `polyagent config set <key> <value> [--global]` | Change a setting for this repo, or the global default |
| `polyagent config unset <key> [--global]` | Go back to the inherited value |

## Settings

Set globally or per repo (repo wins). Change them in the interface (`s`) or with `polyagent config`.

| Key | Values | Default |
| --- | --- | --- |
| `gitTracking` | `ignore-all`, `share-team` (commit employees and presets, not runs or chats), `track-all` | `ignore-all` |
| `orchestrator` | `claude`, `codex`, `antigravity` | `claude` |
| `autoRun` | `on`, `off` (approve each plan first) | `on` |
| `maxParallel` | a number, or `unlimited` | `unlimited` |

polyagent manages git tracking with its own `.polyagent/.gitignore`. It never edits your project's `.gitignore`.

## Where things live

```
~/.config/polyagent/config.json     agent CLI paths + global defaults ($POLYAGENT_HOME overrides)
<project>/.polyagent/
  .gitignore                        managed by polyagent from gitTracking
  config.json                       this repo's settings
  employees/                        one Markdown file per employee
  chats/                            direct-chat transcripts and provider sessions
  presets/                          team presets
  runs/                             run history
```

## Develop

```sh
npm install
npm run dev        # run from source
npm test
npm run build
```
