#!/usr/bin/env node
import fs from 'node:fs';
import {parseArgs} from 'node:util';
import {render} from 'ink';
import {configCommand} from './commands/config.js';
import {killAllTurns} from './core/agents/runner.js';
import {loadEmployees} from './core/employees.js';
import {listRuns} from './core/run/engine.js';
import {doctor} from './commands/doctor.js';
import {s} from './commands/style.js';
import {loadContext} from './core/context.js';
import {tildify} from './core/paths.js';
import {initWorkspace} from './core/workspace.js';
import {App} from './ui/App.js';

const HELP = `${s.bold('polyagent')} — run Claude Code, Codex and Antigravity as one team

${s.bold('Usage')}
  polyagent                      open the interface in this folder
  polyagent init                 set up polyagent here without prompts
  polyagent doctor               check agent CLIs, workspace and settings
  polyagent config               show effective settings and where each comes from
  polyagent config get <key>
  polyagent config set <key> <value> [--global]
  polyagent config unset <key> [--global]

${s.bold('Settings')}
  gitTracking    ignore-all | share-team | track-all
  orchestrator   claude | codex | antigravity
  autoRun        on | off
  maxParallel    a number, or unlimited

${s.bold('Options')}
  --global       change the default for every repo instead of this one
  --json         machine-readable output (doctor, config)
  -h, --help     show this help
  -v, --version  show the version

Respects NO_COLOR. Global config lives in ~/.config/polyagent (or $POLYAGENT_HOME).`;

function version(): string {
	const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {version: string};
	return pkg.version;
}

async function main(): Promise<number> {
	let parsed;
	try {
		parsed = parseArgs({
			allowPositionals: true,
			options: {
				help: {type: 'boolean', short: 'h'},
				version: {type: 'boolean', short: 'v'},
				json: {type: 'boolean'},
				global: {type: 'boolean'},
			},
		});
	} catch (error) {
		console.error(`${(error as Error).message}\nRun polyagent --help for usage.`);
		return 2;
	}

	const {values, positionals} = parsed;
	const [command, ...rest] = positionals;
	const cwd = process.cwd();

	if (values.help) {
		console.log(HELP);
		return 0;
	}

	if (values.version) {
		console.log(version());
		return 0;
	}

	switch (command) {
		case undefined:
			return launchTui(cwd);
		case 'doctor':
			return doctor(cwd, Boolean(values.json));
		case 'config':
			return configCommand(cwd, rest, {global: Boolean(values.global), json: Boolean(values.json)});
		case 'init': {
			const ctx = await loadContext(cwd);
			if (ctx.workspace.exists) {
				console.log(`Already set up: ${tildify(ctx.workspace.dir)}`);
				return 0;
			}

			await initWorkspace(ctx.workspace.root, ctx.settings.values.gitTracking);
			console.log(`${s.ok('✓')} Created ${tildify(ctx.workspace.dir)} ${s.dim(`(git: ${ctx.settings.values.gitTracking})`)}`);
			for (const w of ctx.workspace.warnings) console.log(`${s.warn('⚠')} ${w}`);
			return 0;
		}

		default:
			console.error(`Unknown command "${command}". Run polyagent --help for usage.`);
			return 2;
	}
}

async function launchTui(cwd: string): Promise<number> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		console.error('The polyagent interface needs an interactive terminal. For scripts, use polyagent doctor or polyagent config.');
		return 1;
	}

	const ctx = await loadContext(cwd);
	const [team, runs] = ctx.workspace.exists ? await Promise.all([loadEmployees(ctx.workspace.dir), listRuns(ctx.workspace.dir, 5)]) : [undefined, undefined];
	// The app handles ctrl+c itself: the first press stops running employees.
	const instance = render(<App initial={ctx} initialTeam={team} initialRuns={runs} />, {alternateScreen: true, exitOnCtrlC: false});
	for (const signal of ['SIGTERM', 'SIGHUP'] as const) {
		process.once(signal, () => {
			killAllTurns();
			instance.unmount();
			process.exit(128 + (signal === 'SIGTERM' ? 15 : 1));
		});
	}

	await instance.waitUntilExit();
	killAllTurns();
	return 0;
}

main().then(
	code => {
		process.exitCode = code;
	},
	(error: unknown) => {
		console.error(s.fail(`polyagent: ${error instanceof Error ? error.message : String(error)}`));
		process.exitCode = 1;
	},
);
