import fs from 'node:fs';
import path from 'node:path';
import {render} from 'ink-testing-library';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {emptyGlobalConfig, type GlobalConfig} from '../src/core/config.js';
import {loadContext} from '../src/core/context.js';
import {initWorkspace} from '../src/core/workspace.js';
import {Settings} from '../src/ui/screens/Settings.js';
import {Setup} from '../src/ui/screens/Setup.js';
import {fakeBin, gitInit, press, tmpDir, waitFor} from './helpers.js';

const ENTER = '\r';
const DOWN = '\u001B[B';
const RIGHT = '\u001B[C';

let savedEnv: NodeJS.ProcessEnv;
let root: string;

beforeEach(() => {
	savedEnv = {...process.env};
	root = tmpDir();
	process.env.POLYAGENT_HOME = path.join(root, 'home');
	process.env.HOME = path.join(root, 'userhome');
	process.env.PATH = [path.join(root, 'bin'), '/usr/bin', '/bin'].join(path.delimiter);
	// npx sets these, which would lead detection to real installs on this machine.
	delete process.env.npm_config_prefix;
	delete process.env.NVM_DIR;
});

afterEach(() => {
	process.env = savedEnv;
});

describe('Setup', () => {
	it('finds installed CLIs and continues with them', async () => {
		const claude = fakeBin(path.join(root, 'bin'), 'claude', '2.1.0 (Claude Code)');
		const onDone = vi.fn<(config: GlobalConfig) => void>();
		const ui = render(<Setup config={emptyGlobalConfig()} onDone={onDone} />);

		await waitFor(() => ui.lastFrame()!.includes('Continue with Claude Code'), ui.lastFrame);
		expect(ui.lastFrame()).toContain('2.1.0 (Claude Code)');
		await press(ui.stdin, ENTER);
		await waitFor(() => onDone.mock.calls.length > 0);
		expect(onDone.mock.calls[0]![0].providers.claude).toMatchObject({path: claude, source: 'path'});
		ui.unmount();
	});

	it('blocks continuing when nothing is installed and offers a manual path', async () => {
		const onDone = vi.fn();
		const ui = render(<Setup config={emptyGlobalConfig()} onDone={onDone} />);
		await waitFor(() => ui.lastFrame()!.includes('No agent CLIs found'), ui.lastFrame);

		// "Continue" is disabled, so the cursor starts on "Add a CLI by path…".
		await press(ui.stdin, ENTER);
		await waitFor(() => ui.lastFrame()!.includes('Path to the CLI executable'), ui.lastFrame);

		const custom = fakeBin(path.join(root, 'elsewhere'), 'my-codex', 'codex-cli 0.50.0');
		await press(ui.stdin, custom);
		await waitFor(() => ui.lastFrame()!.includes('my-codex'), ui.lastFrame);
		await press(ui.stdin, ENTER);
		await waitFor(() => ui.lastFrame()!.includes('Which tool is this?'), ui.lastFrame);
		expect(ui.lastFrame()).toMatch(/› Codex\s+detected/);

		await press(ui.stdin, ENTER);
		await waitFor(() => ui.lastFrame()!.includes('Continue with Codex'), ui.lastFrame);
		await press(ui.stdin, ENTER);
		await waitFor(() => onDone.mock.calls.length > 0);
		expect(onDone.mock.calls[0]![0].providers.codex).toMatchObject({path: custom, source: 'manual'});
		ui.unmount();
	});
});

describe('Settings', () => {
	it('changes a repo setting, saves it and rewrites .gitignore', async () => {
		const repo = path.join(root, 'repo');
		fs.mkdirSync(repo);
		gitInit(repo);
		await initWorkspace(repo, 'ignore-all');

		let ctx = await loadContext(repo);
		const ui = render(
			<Settings
				ctx={ctx}
				detections={{}}
				onSaved={async () => {
					ctx = await loadContext(repo);
				}}
				onDetections={() => {}}
				onBack={() => {}}
			/>,
		);
		await waitFor(() => ui.lastFrame()!.includes('Git tracking'), ui.lastFrame);
		await press(ui.stdin, RIGHT);
		await waitFor(() => ui.lastFrame()!.includes('Saved to .polyagent/config.json'), ui.lastFrame);

		const config = JSON.parse(fs.readFileSync(path.join(repo, '.polyagent', 'config.json'), 'utf8'));
		expect(config.settings).toEqual({gitTracking: 'share-team'});
		expect(fs.readFileSync(path.join(repo, '.polyagent', '.gitignore'), 'utf8')).toContain('runs/');
		expect(ctx.settings.sources.gitTracking).toBe('repo');

		// maxParallel cycles from unlimited to 1.
		await press(ui.stdin, DOWN, DOWN, DOWN);
		await waitFor(() => ui.lastFrame()!.includes('› Parallel limit'), ui.lastFrame);
		await press(ui.stdin, RIGHT);
		await waitFor(() => JSON.parse(fs.readFileSync(path.join(repo, '.polyagent', 'config.json'), 'utf8')).settings.maxParallel === 1);
		ui.unmount();
	});
});
