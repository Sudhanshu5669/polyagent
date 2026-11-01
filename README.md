# polyagent

Run Claude Code, Codex and Antigravity as one team from your terminal: an orchestrator plans the work and hands it to specialist employees (frontend, backend, art, reviewer…), running independent tasks in parallel.

> Status: early. Hire employees, chat with them, and give the team work through the orchestrator. Employees work in parallel, each in their own git worktree.

## Install

```sh
npm install -g polyagent
```

Requires Node 22+ and at least one agent CLI: [Claude Code](https://docs.claude.com/en/docs/claude-code) (`claude`), [Codex](https://github.com/openai/codex) (`codex`) or the [Antigravity CLI](https://antigravity.google/docs/getting-started?tab=cli) (`agy`, a separate install from the Antigravity editor; run `agy` once to sign in). polyagent uses each CLI's own login and never touches its credentials.

## Use

```sh
cd your-project
polyagent
```

On first launch polyagent looks for your agent CLIs (saved paths, then `PATH`, then common install folders such as npm, Homebrew, bun, Volta, pnpm and nvm). If one lives somewhere unusual, add its path in the setup screen. Then it offers to create `.polyagent/` in the project, at the git root if you're in a subfolder.

### Employees

Press `n` on the dashboard to hire one, or start a run with no team and [let the orchestrator pick one](#letting-the-orchestrator-pick-the-team). Pick a starting role (frontend, backend, reviewer, tests, art, docs, or blank), name them, choose the agent CLI, model and permissions, and save. Each employee is a Markdown file in `.polyagent/employees/`:

```md
---
name: Maya
role: backend
provider: codex
model: gpt-6.1-sol
permissions: auto-edit
owns: [src/api/**, prisma/**]
summary: Builds REST endpoints and DB schema. Never touches UI.
briefing: Precise spec, file paths, acceptance criteria. No prose.
---
You are a backend engineer on this codebase...
```

`summary` and `briefing` are for the orchestrator: what to send this employee, and how to phrase it. Edit employees in the form (`e`) or in your editor (`o`).

#### Models

You don't type model names. Press `⏎` on the form's **Model** field to scroll through the models the employee's CLI offers (`↑↓` to move, `⏎` to choose), or step through them with `←→` without opening the list. **CLI default** lets the CLI choose, and is what an employee without `model:` uses. **Other…** takes any name the CLI accepts. The list comes from each CLI:

| CLI | Where the list comes from |
| --- | --- |
| Claude Code | Its aliases (`fable`, `opus`, `sonnet`, `haiku`, always the latest of each), plus any extra models Claude Code offers your account |
| Codex | `codex debug models`, leaving out the internal models Codex's own picker hides |
| Antigravity | `agy models` |

Lists are fetched once per session, in the background while the form is open. If a CLI isn't installed or can't list its models, the picker says why and you can still choose **CLI default** or type a name. A saved model the CLI no longer lists stays selectable, marked *not listed by the CLI*. Switching an employee to a different CLI resets their model to the default, since model names belong to one CLI.

| Permissions | Claude Code | Codex | Antigravity |
| --- | --- | --- | --- |
| `read-only` | default mode, nothing approved | `--sandbox read-only` | default mode (no writes or commands) |
| `auto-edit` | `acceptEdits` | `--sandbox workspace-write` | `--mode accept-edits` |
| `full-auto` | `bypassPermissions` | `--sandbox danger-full-access` | `--dangerously-skip-permissions` |

Anything that would need approval is blocked, never left hanging, and shows as *blocked* in the chat.

Press `⏎` on an employee to chat with them directly. Their session is resumed between messages and across restarts; `ctrl+n` starts fresh, `ctrl+o` shows thinking and tool output, `ctrl+c` stops them.

#### Approvals

With **Approvals: Ask me** (the default), a Claude Code employee that wants to do something needing approval, like running a command, waits for you instead of being blocked. A ⚑ banner appears on every screen (with a terminal bell); `ctrl+a` opens the request, where you can allow once, always allow that command for that employee until polyagent quits (shell commands are matched on their first two words, e.g. `npm test`), deny, or deny with a reason the employee will read. Read-only employees never get edit tools, so approvals can't turn them into editors. Codex and Antigravity follow their own sandboxes instead. Set **Approvals: Block** to have anything that needs approval blocked automatically.

All three are verified against real installs (Claude Code 2.1.311, codex-cli 0.164.0, agy 1.4.9). Antigravity ends its turn at the first action it needs approval for, such as a shell command in `read-only` or `auto-edit`, so that employee's report says what was blocked and the orchestrator can decide what to do next.

### Presets

A preset is a saved team. Press `p` on the dashboard to browse them, see who's in each, apply one or save your current team.

- **This repo** presets live in `.polyagent/presets/`, so `share-team` commits them along with the team.
- **Global** presets live in `~/.config/polyagent/presets/` and show up in every repo.
- **Built-in** presets are three starter teams: *Builder + reviewer*, *Full-stack squad* and *Product squad*. They use your orchestrator's CLI, or another installed one if that isn't.

Applying a preset either adds its employees to your team or replaces the team. When adding, an employee who's already on the team with the same definition is skipped, and one who clashes with a different definition joins under a new name (`maya-2`, "Maya 2"). Employees on a CLI you don't have installed are moved to one you do, with their model reset to that CLI's default.

Each preset is a folder holding a `preset.yaml` (name and description) and an `employees/` folder in the same Markdown format as your team, so you can edit presets by hand. Names are unique within a place, so `polyagent presets apply <name>` always means one preset; if the repo and global folders both have one by that name, the repo one wins.

### Runs

Press `r` and describe what you want. The orchestrator (Claude Code by default) looks at the repo, splits the request into tasks, and hands each one to the employee whose summary fits, written in the style their briefing asks for. polyagent itself does the scheduling:

- a task starts when the tasks it depends on are done, and their reports are attached to its brief
- in a git repo, every employee works in their own git worktree, so independent tasks run at the same time (cap it with `maxParallel`); outside git, tasks run one at a time in the folder itself
- each employee works on one task at a time and keeps one session for the whole run
- finished reports, plus the repo's current uncommitted changes, go back to the orchestrator, which can ask for revisions, add follow-up work (like a review) or finish with a summary
- limits that hold whatever the orchestrator decides: 30 orchestrator turns, 3 revisions per task, and invalid plans are reported back instead of run

#### Letting the orchestrator pick the team

Start a run before hiring anyone and the orchestrator looks at the project and your request, then proposes a team: a name, role, CLI, model, permissions, work areas, summary, briefing and system prompt for each employee. It only picks CLIs you have installed and models those CLIs list, and it can ask for `read-only` or `auto-edit` but never `full-auto`.

Nobody is hired until you approve. In the review, `space` keeps or drops someone, `←→` changes their permissions (including `full-auto`, if you want it), `r` asks for a different team with your feedback, and `⏎` hires everyone kept and starts the run with your request. They're saved to `.polyagent/employees/` like anyone you hire yourself, so you can edit them afterwards. Picking a team is one read-only orchestrator turn: about half a minute, and with Claude Code about $0.30 for a small project.

#### How parallel work reaches your files

When a run starts, polyagent snapshots your working tree exactly as it is (uncommitted and untracked files included, your index and branch untouched) and gives each employee a worktree from that snapshot, in your cache folder. Ignored dependency folders (`node_modules`, `.venv`, `venv`) are linked in so tests and builds work. When a task finishes, its changes are three-way merged with everything merged so far and written into your working tree. Nothing is committed to your branch.

- If two tasks change the same lines, the second is reported to the orchestrator as a conflict and nothing of it is applied; a revision starts from the merged code.
- If you edit a file yourself during the run and an employee changes it too, your version is kept. The run's summary says which files, and the team's versions stay available: `git checkout refs/polyagent/runs/<id> -- <files>`.
- Every run keeps a ref, `refs/polyagent/runs/<id>`, with the full history of what each task merged.

#### Pausing, budgets and coming back later

- `ctrl+p` pauses a run: tasks already running finish, nothing new starts and the orchestrator waits. `ctrl+p` again resumes.
- **Run budget** (Settings) pauses a run once it has cost that much, as reported by Claude Code (Codex reports tokens, not cost). Resuming allows another budget's worth.
- **Task time limit** stops a task that runs too long and reports it to the orchestrator as failed.
- Every run is listed on the dashboard; select one and press `⏎` to open it. A run that was interrupted (polyagent quit or crashed) can be continued with `ctrl+r`: tasks that were in flight start again, everything already merged stays, and the orchestrator is told what happened. Worktrees left behind by a crash are cleaned up automatically, never while another polyagent is still using them.

Changes stay uncommitted on your current branch for you to review. `ctrl+c` stops the run. Each run is saved to `.polyagent/runs/<id>/run.json`.

#### The run screen

The run screen is built for coming back to a run later and asking "what happened, and do I need to step in?".

- **Header**: the request, a progress bar, tasks done, a rough ETA (once a task has finished), spend, tokens and elapsed time.
- **Lanes**: one line per agent, numbered `0` (the orchestrator) and `1`–`9`. Each shows a hue and glyph, role, a progress bar, and what they're doing now: `●` working (`⠹` while a tool runs), `◌` waiting on a teammate or queued, `○` idle, `✓` done, a red `!` when stuck, and `⚑` when they need your approval. Glyph and name always appear together, so colour is never the only cue.
- **Feed**: the story of the run, newest first: the plan, handoffs (with the message that was passed on), merges, conflicts, revisions, re-plans, your messages and hires. When you return after a minute or more, it opens with **While you were away**. `⏎` expands an event.
- **Focus view**: press a lane's number (or click it) to open one agent with a roster beside them and four tabs: `stream` (what they're doing), `diff` (their changes, live while they work), `tests` (test runs and counts) and `chat` (what you and they have said). `j`/`k` switch agent, `tab` switches tab, `esc` goes back.

| Key | Does |
| --- | --- |
| `j` `k` `g` `G` | Move through the feed |
| `1`–`9`, `0` | Open an employee, or the orchestrator |
| `⏎` | Expand the selected event (or start the plan, when it needs approval) |
| `i`, or just start typing | Type to the orchestrator (to the employee you're watching, in the focus view) |
| `esc` | Leave the prompt for normal mode; in normal mode, go back |
| `q` | Detach to the dashboard; the run keeps going |
| `ctrl+k` | Palette: fuzzy search over employees, tasks, events and commands |
| `ctrl+t`, `ctrl+p`, `ctrl+r`, `ctrl+o` | Task list, pause or resume, continue an interrupted run, show thinking and tool output |

The prompt takes plain text (to the orchestrator, who re-plans), `@name message` (to one employee: it goes into their next task, and the orchestrator is told), and `/commands`: `/hire`, `/fire <name>`, `/merge` (what each worktree changed and where it went), `/cost` (spend per employee and task), `/tasks`, `/pause`, `/resume` and `/stop`. Hiring or firing mid-run tells the orchestrator; someone with unfinished work stays until it's done.

**Mouse**: click a lane or a feed event (click again to expand), scroll the feed or a stream with the wheel, click a tab, and drag the divider beside the roster to resize it. Mouse capture means your terminal's own text selection needs <kbd>Shift</kbd> held (or <kbd>Option</kbd> on macOS); set `POLYAGENT_MOUSE=0` to turn the mouse off.

**Colours** follow your terminal: polyagent asks for its background colour at startup and switches to a light palette on light terminals. Set `POLYAGENT_THEME=light` or `dark` to force it. `NO_COLOR` is respected.

### Commands

| Command | What it does |
| --- | --- |
| `polyagent` | Open the interface |
| `polyagent init` | Set up `.polyagent/` here without prompts |
| `polyagent doctor [--json]` | Check agent CLIs, workspace and settings |
| `polyagent config [--json]` | Show effective settings and where each comes from |
| `polyagent config set <key> <value> [--global]` | Change a setting for this repo, or the global default |
| `polyagent config unset <key> [--global]` | Go back to the inherited value |
| `polyagent presets [list] [--json]` | List presets: this repo's, then global, then built-in |
| `polyagent presets apply <name> [--replace]` | Add a preset's employees to the team, or replace the team with them |
| `polyagent presets save <name> [--global]` | Save the current team as a preset for this repo, or for every repo |

## Settings

Set globally or per repo (repo wins). Change them in the interface (`s`) or with `polyagent config`.

| Key | Values | Default |
| --- | --- | --- |
| `gitTracking` | `ignore-all`, `share-team` (commit employees and presets, not runs or chats), `track-all` | `ignore-all` |
| `orchestrator` | `claude`, `codex`, `antigravity` | `claude` |
| `autoRun` | `on`, `off` (approve each plan first) | `on` |
| `maxParallel` | a number, or `unlimited` | `unlimited` |
| `approvals` | `ask`, `block` | `ask` |
| `runBudget` | dollars, or `none` | `none` |
| `taskTimeout` | minutes, or `none` | `none` |
| `orchestratorModel` | any model name the orchestrator's CLI accepts, or `default`. In the interface it's picked from a list, like an [employee's model](#models) | `default` |

Changing `orchestrator` resets `orchestratorModel` to `default`, whether in the interface or with `polyagent config set`, since model names belong to one CLI.

polyagent manages git tracking with its own `.polyagent/.gitignore`. It never edits your project's `.gitignore`.

## Where things live

```
~/.config/polyagent/config.json     agent CLI paths + global defaults ($POLYAGENT_HOME overrides)
~/.config/polyagent/presets/        global team presets
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
