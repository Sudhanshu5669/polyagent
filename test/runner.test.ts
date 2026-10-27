import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {runTurn} from '../src/core/agents/runner.js';
import type {AgentEvent} from '../src/core/agents/types.js';
import {EmployeeChat} from '../src/core/chat.js';
import type {Employee} from '../src/core/employees.js';
import {tmpDir, waitFor} from './helpers.js';

const FIXTURES = path.join(import.meta.dirname, 'fixtures');

/** A stand-in `claude` that logs its args, replays a recorded stream, and exits with `exitCode`. */
function fakeClaude(dir: string, fixture: string, {exitCode = 0, stderr = ''} = {}): {bin: string; argsLog: string} {
	const bin = path.join(dir, 'claude');
	const argsLog = path.join(dir, 'args.log');
	fs.writeFileSync(
		bin,
		`#!/bin/sh
for a in "$@"; do printf '%s\\n' "$a"; done >> ${JSON.stringify(argsLog)}
echo --- >> ${JSON.stringify(argsLog)}
cat ${JSON.stringify(path.join(FIXTURES, fixture))}
${stderr ? `echo ${JSON.stringify(stderr)} >&2` : ''}
exit ${exitCode}
`,
		{mode: 0o755},
	);
	return {bin, argsLog};
}

const input = {prompt: 'hi', cwd: '/tmp', permissions: 'read-only' as const};

describe('runTurn', () => {
	it('streams normalized events and succeeds on exit 0', async () => {
		const {bin} = fakeClaude(tmpDir(), 'claude-read.jsonl');
		const events: AgentEvent[] = [];
		const outcome = await runTurn(bin, 'claude', input, e => events.push(e)).done;
		expect(outcome).toEqual({ok: true, cancelled: false, exitCode: 0});
		expect(events.map(e => e.type)).toEqual(['session', 'tool', 'tool', 'text', 'usage', 'result']);
	});

	it('reports stderr when the CLI fails', async () => {
		const {bin} = fakeClaude(tmpDir(), 'empty.jsonl', {exitCode: 2, stderr: 'Error: not logged in'});
		const outcome = await runTurn(bin, 'claude', input, () => {}).done;
		expect(outcome).toMatchObject({ok: false, exitCode: 2, error: 'Error: not logged in'});
	});

	it('reports a binary that cannot start', async () => {
		const outcome = await runTurn('/nonexistent/claude', 'claude', input, () => {}).done;
		expect(outcome.ok).toBe(false);
		expect(outcome.error).toMatch(/Couldn't start/);
	});

	it('cancel stops the CLI and everything it spawned', async () => {
		const dir = tmpDir();
		const pidFile = path.join(dir, 'grandchild.pid');
		const bin = path.join(dir, 'slow');
		fs.writeFileSync(bin, `#!/bin/sh\nsleep 60 &\necho $! > ${JSON.stringify(pidFile)}\nwait\n`, {mode: 0o755});

		const turn = runTurn(bin, 'claude', input, () => {});
		await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() !== '');
		const grandchild = Number(fs.readFileSync(pidFile, 'utf8'));
		turn.cancel();
		expect(await turn.done).toMatchObject({ok: false, cancelled: true});
		await waitFor(() => {
			try {
				process.kill(grandchild, 0);
				return false;
			} catch {
				return true;
			}
		});
	});
});

describe('EmployeeChat', () => {
	const employee: Employee = {
		id: 'maya',
		file: '',
		name: 'Maya',
		role: 'backend',
		provider: 'claude',
		permissions: 'auto-edit',
		owns: [],
		summary: 'APIs',
		briefing: '',
		systemPrompt: 'Be terse.',
	};

	it('records the transcript, keeps the session and resumes it on the next turn', async () => {
		const dir = tmpDir();
		const {bin, argsLog} = fakeClaude(dir, 'claude-read.jsonl');
		const ws = path.join(dir, 'ws');

		const chat = await EmployeeChat.open(ws, 'maya');
		await chat.send(employee, bin, dir, 'what is the secret word?');
		expect(chat.entries.map(e => e.kind)).toEqual(['user', 'tool', 'text', 'turn']);
		expect(chat.entries.at(-1)).toMatchObject({kind: 'turn', ok: true, costUsd: 0.00380072});
		expect(chat.sessionId).toBe('b683a96f-130a-4397-b30f-3d9fb5bf9b53');

		await chat.send(employee, bin, dir, 'again');
		const [first, second] = fs.readFileSync(argsLog, 'utf8').split('---\n');
		expect(first).not.toContain('--resume');
		expect(second).toContain('--resume\nb683a96f-130a-4397-b30f-3d9fb5bf9b53');
		expect(second).toContain('--append-system-prompt\nYou are Maya, the backend');

		// A fresh process sees the same history and session.
		const reopened = await EmployeeChat.open(ws, 'maya');
		expect(reopened.entries).toHaveLength(8);
		expect(reopened.sessionId).toBe(chat.sessionId);
	});

	it('starts a new session when the employee switches CLI', async () => {
		const dir = tmpDir();
		const {bin, argsLog} = fakeClaude(dir, 'claude-read.jsonl');
		const ws = path.join(dir, 'ws');
		const chat = await EmployeeChat.open(ws, 'maya');
		await chat.send(employee, bin, dir, 'one');

		// Pretend the saved session came from Codex.
		fs.writeFileSync(path.join(ws, 'chats', 'maya', 'session.json'), JSON.stringify({provider: 'codex', sessionId: 'old'}));
		const reopened = await EmployeeChat.open(ws, 'maya');
		await reopened.send(employee, bin, dir, 'two');
		expect(fs.readFileSync(argsLog, 'utf8').split('---\n')[1]).not.toContain('--resume');
		expect(reopened.entries.some(e => e.kind === 'note')).toBe(true);
	});
});
