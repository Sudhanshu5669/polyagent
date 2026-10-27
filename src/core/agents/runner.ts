import {spawn, type ChildProcess} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {antigravityAdapter} from './antigravity.js';
import {claudeAdapter} from './claude.js';
import {codexAdapter} from './codex.js';
import type {Adapter, AgentEvent, TurnInput} from './types.js';
import type {ProviderId} from '../providers.js';

export const ADAPTERS: Record<ProviderId, Adapter> = {
	claude: claudeAdapter,
	codex: codexAdapter,
	antigravity: antigravityAdapter,
};

export interface TurnOutcome {
	ok: boolean;
	cancelled: boolean;
	exitCode: number | null;
	/** Set when the turn failed, from the CLI's own error or its stderr. */
	error?: string;
}

export interface RunningTurn {
	done: Promise<TurnOutcome>;
	cancel: () => void;
}

/** Every live child, so they can all be stopped when polyagent exits. */
const live = new Set<ChildProcess>();

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
	if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
	try {
		// Children run in their own process group, so this also stops anything they spawned (shells, test runners…).
		if (process.platform === 'win32') child.kill(signal);
		else process.kill(-child.pid, signal);
	} catch {}
}

/** Stop every running agent. Called on quit and on fatal signals. */
export function killAllTurns(): void {
	for (const child of live) killTree(child, 'SIGKILL');
}

process.once('exit', killAllTurns);

/** Run one turn of an agent CLI and stream normalized events until it exits. */
export function runTurn(binary: string, provider: ProviderId, input: TurnInput, onEvent: (event: AgentEvent) => void): RunningTurn {
	const adapter = ADAPTERS[provider];
	let schemaDir: string | undefined;
	let schemaFile: string | undefined;
	if (input.jsonSchema) {
		schemaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polyagent-schema-'));
		schemaFile = path.join(schemaDir, 'schema.json');
		fs.writeFileSync(schemaFile, JSON.stringify(input.jsonSchema));
	}

	const child = spawn(binary, adapter.args(input, {schemaFile}), {
		cwd: input.cwd,
		// No stdin: a closed stdin is what tells these CLIs they are running headless.
		stdio: ['ignore', 'pipe', 'pipe'],
		detached: process.platform !== 'win32',
		windowsHide: true,
		env: process.env,
	});
	live.add(child);

	let cancelled = false;
	let reportedError: string | undefined;
	const stderr: string[] = [];
	const parse = adapter.createParser(input.cwd);

	createInterface({input: child.stdout!}).on('line', line => {
		for (const event of parse(line)) {
			if (event.type === 'error') reportedError ??= event.message;
			onEvent(event);
		}
	});
	createInterface({input: child.stderr!}).on('line', line => {
		stderr.push(line);
		if (stderr.length > 50) stderr.shift();
	});

	const cleanup = () => {
		live.delete(child);
		if (schemaDir) fs.rmSync(schemaDir, {recursive: true, force: true});
	};

	const done = new Promise<TurnOutcome>(resolve => {
		child.once('error', error => {
			cleanup();
			resolve({ok: false, cancelled, exitCode: null, error: `Couldn't start ${binary}: ${error.message}`});
		});
		child.once('close', code => {
			cleanup();
			if (cancelled) return resolve({ok: false, cancelled: true, exitCode: code});
			if (code === 0 && !reportedError) return resolve({ok: true, cancelled: false, exitCode: 0});
			const tail = stderr.filter(l => l.trim()).slice(-5).join('\n');
			resolve({ok: false, cancelled: false, exitCode: code, error: reportedError ?? (tail || `exited with code ${code}`)});
		});
	});

	return {
		done,
		cancel() {
			if (cancelled) return;
			cancelled = true;
			killTree(child, 'SIGTERM');
			setTimeout(() => killTree(child, 'SIGKILL'), 3000).unref();
		},
	};
}
