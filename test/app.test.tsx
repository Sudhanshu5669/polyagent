import fs from 'node:fs';
import path from 'node:path';
import {render} from 'ink-testing-library';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {saveGlobalConfig} from '../src/core/config.js';
import {loadContext} from '../src/core/context.js';
import {initWorkspace} from '../src/core/workspace.js';
import {App} from '../src/ui/App.js';
import {gitInit, press, tmpDir, waitFor} from './helpers.js';

const ENTER = '\r';
const ESC = '\u001B';
const CTRL_S = '\u0013';
const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'claude-read.jsonl');

let savedEnv: NodeJS.ProcessEnv;
let root: string;

beforeEach(() => {
	savedEnv = {...process.env};
	root = tmpDir();
	const bin = path.join(root, 'bin');
	fs.mkdirSync(bin);
	fs.writeFileSync(
		path.join(bin, 'claude'),
		`#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.0 (Claude Code)"; exit 0; fi\nsleep 0.3\ncat ${JSON.stringify(FIXTURE)}\n`,
		{mode: 0o755},
	);
	process.env.POLYAGENT_HOME = path.join(root, 'home');
	process.env.HOME = path.join(root, 'userhome');
	process.env.PATH = [bin, '/usr/bin', '/bin'].join(path.delimiter);
	delete process.env.npm_config_prefix;
	delete process.env.NVM_DIR;
});

afterEach(() => {
	process.env = savedEnv;
});

describe('App', () => {
	it('hires an employee from a template and chats with them', async () => {
		const repo = path.join(root, 'repo');
		fs.mkdirSync(repo);
		gitInit(repo);
		await initWorkspace(repo, 'ignore-all');
		await saveGlobalConfig({version: 1, providers: {claude: {path: path.join(root, 'bin', 'claude'), source: 'path'}}, settings: {}});

		const ui = render(<App initial={await loadContext(repo)} />);
		const frame = () => ui.lastFrame() ?? '';
		await waitFor(() => frame().includes('Build your team') && frame().includes('claude ✓'), frame);

		// Hire: pick the first template (frontend), type a name, save.
		await press(ui.stdin, 'n');
		await waitFor(() => frame().includes('Start from a role'), frame);
		await press(ui.stdin, ENTER);
		await waitFor(() => frame().includes('Works in'), frame);
		await press(ui.stdin, 'Leo', ENTER, CTRL_S);
		await waitFor(() => frame().includes('Leo [frontend]'), frame);

		const file = fs.readFileSync(path.join(repo, '.polyagent', 'employees', 'leo.md'), 'utf8');
		expect(file).toMatch(/^---\nname: Leo\nrole: frontend\nprovider: claude\npermissions: auto-edit\n/);

		// Chat: the fake CLI replays a recorded Claude turn.
		await press(ui.stdin, ENTER);
		await waitFor(() => frame().includes('Message Leo'), frame);
		await press(ui.stdin, 'what is the secret word?', ENTER);
		await waitFor(() => frame().includes('Leo is working'), frame);
		await waitFor(() => frame().includes('Leo › marmalade') && frame().includes('done in'), frame);
		expect(frame()).toContain('▸ read');
		expect(frame()).toContain('session b683a96f');

		await press(ui.stdin, ESC);
		await waitFor(() => frame().includes('Summary'), frame);
		ui.unmount();
	});

	it('starts a run, shows employees working, and shows the summary', async () => {
		const fake = path.join(root, 'fake');
		fs.mkdirSync(fake);
		fs.rmSync(path.join(root, 'bin', 'claude'));
		fs.symlinkSync(path.join(import.meta.dirname, 'fixtures', 'fake-agent.mjs'), path.join(root, 'bin', 'claude'));
		// The fake agent is a Node script; keep PATH minimal so real CLIs on this machine stay out of the test.
		process.env.PATH = [path.join(root, 'bin'), path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter);
		process.env.FAKE_DIR = fake;
		process.env.FAKE_SLEEP_MS = '600';
		fs.writeFileSync(
			path.join(fake, 'decisions.json'),
			JSON.stringify([
				{note: 'One task for Rex', tasks: [{id: 'review', title: 'Review the repo', assignee: 'rex', brief: 'Look around.', depends_on: []}]},
				{finish: 'Rex reviewed everything. All good.'},
			]),
		);

		const repo = path.join(root, 'repo');
		fs.mkdirSync(repo);
		await initWorkspace(repo, 'ignore-all');
		await saveGlobalConfig({version: 1, providers: {claude: {path: path.join(root, 'bin', 'claude'), source: 'path'}}, settings: {}});
		fs.writeFileSync(path.join(repo, '.polyagent', 'employees', 'rex.md'), '---\nname: Rex\nrole: reviewer\nprovider: claude\n---\nReview.');

		const ui = render(<App initial={await loadContext(repo)} />);
		const frame = () => ui.lastFrame() ?? '';
		await waitFor(() => frame().includes('Rex [reviewer]') && frame().includes('claude ✓'), frame);
		await press(ui.stdin, 'r');
		await waitFor(() => frame().includes('What should the team do?'), frame);
		await press(ui.stdin, 'Review the repo please', ENTER);
		await waitFor(() => /Rex\s+claude\s+\[reviewer\]\s+working\s+Review the repo/.test(frame()), frame);
		await waitFor(() => frame().includes('Done after') && frame().includes('Rex reviewed everything. All good.'), frame);

		// Back on the dashboard the run is listed.
		await press(ui.stdin, ESC);
		await waitFor(() => frame().includes('RUNS') && frame().includes('✓ Review the repo please'), frame);
		ui.unmount();
	});

	it('ctrl+c stops a running employee instead of quitting', async () => {
		fs.writeFileSync(path.join(root, 'bin', 'claude'), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.0 (Claude Code)"; exit 0; fi\nsleep 60\n', {mode: 0o755});
		const repo = path.join(root, 'repo');
		fs.mkdirSync(repo);
		await initWorkspace(repo, 'ignore-all');
		await saveGlobalConfig({version: 1, providers: {claude: {path: path.join(root, 'bin', 'claude'), source: 'path'}}, settings: {}});
		fs.writeFileSync(path.join(repo, '.polyagent', 'employees', 'rex.md'), '---\nname: Rex\nrole: reviewer\nprovider: claude\n---\nReview.');

		const ui = render(<App initial={await loadContext(repo)} />);
		const frame = () => ui.lastFrame() ?? '';
		await waitFor(() => frame().includes('Rex [reviewer]') && frame().includes('claude ✓'), frame);
		await press(ui.stdin, ENTER);
		await waitFor(() => frame().includes('Message Rex'), frame);
		await press(ui.stdin, 'review please', ENTER);
		await waitFor(() => frame().includes('Rex is working'), frame);
		await press(ui.stdin, '\u0003');
		await waitFor(() => frame().includes('stopped after'), frame);
		ui.unmount();
	});
});
