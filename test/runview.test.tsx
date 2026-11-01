import path from 'node:path';
import {render} from 'ink-testing-library';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import type {Employee} from '../src/core/employees.js';
import {RunEngine} from '../src/core/run/engine.js';
import type {RunEvent, RunFile, Task} from '../src/core/run/types.js';
import {RunView} from '../src/ui/screens/RunView.js';
import {tmpDir, waitFor} from './helpers.js';

const ENTER = '\r';
const ESC = '\u001B';
const TAB = '\t';
const CTRL_K = '\u000B';

const employee = (id: string, role: string, provider: Employee['provider'] = 'claude'): Employee => ({
	id,
	file: '',
	name: id[0]!.toUpperCase() + id.slice(1),
	role,
	provider,
	permissions: 'auto-edit',
	owns: [],
	summary: `${role} work`,
	briefing: '',
	systemPrompt: '',
});

const TEAM = [employee('iris', 'research', 'antigravity'), employee('forge', 'backend', 'codex'), employee('muse', 'design'), employee('pixel', 'frontend')];

const task = (id: string, assignee: string, status: Task['status'], extra: Partial<Task> = {}): Task => ({id, title: `Do ${id}`, assignee, brief: `Brief for ${id}`, dependsOn: [], status, revisions: 0, ...extra});

const PATCH = ['diff --git a/src/api/usage.ts b/src/api/usage.ts', 'index 1..2 100644', '--- a/src/api/usage.ts', '+++ b/src/api/usage.ts', '@@ -14,1 +14,2 @@', '-  return notImplemented()', '+  await meters.record(customerId, qty)', '+  return json({ ok: true })'].join('\n');

function sample(extra: Partial<RunFile['state']> = {}): RunFile {
	const t0 = Date.now() - 42 * 60_000;
	const ev = (id: number, minutes: number, e: Omit<RunEvent, 'id' | 'at'>): RunEvent => ({id, at: t0 + minutes * 60_000, ...e});
	return {
		state: {
			id: 'run-1',
			request: 'usage-based pricing page + Stripe metering',
			status: 'running',
			createdAt: t0,
			orchestrator: {provider: 'claude', working: false, turns: 3},
			tasks: [
				task('research', 'iris', 'done', {startedAt: t0, endedAt: t0 + 9 * 60_000, files: ['research/stripe-metering.md'], report: 'Use the Meter Events API.'}),
				task('metering', 'forge', 'running', {startedAt: t0 + 10 * 60_000, dependsOn: ['research'], tokens: 41_000, costUsd: 1.12, patch: PATCH}),
				task('tokens', 'muse', 'running', {startedAt: t0 + 12 * 60_000, dependsOn: ['research']}),
				task('ui', 'pixel', 'blocked', {dependsOn: ['tokens']}),
			],
			employeeSessions: {},
			costUsd: 3.18,
			tokens: 78_000,
			events: [
				ev(1, 0, {kind: 'plan', agent: 'orchestrator', text: 'planned 4 tasks', detail: 'research → Iris: Do research'}),
				ev(2, 9, {kind: 'merge', agent: 'iris', text: 'merged ⎇ research → main', detail: '1 file · no conflicts'}),
				ev(3, 31, {kind: 'handoff', agent: 'muse', to: 'pixel', text: 'Pricing tokens', detail: 'Tokens are in pricing.json. Highlight the middle tier.'}),
				ev(4, 41, {kind: 'start', agent: 'forge', text: 'Do metering', taskId: 'metering'}),
			],
			unapplied: [],
			...extra,
		},
		logs: {
			orchestrator: [],
			forge: [
				{kind: 'text', text: 'Starting.'},
				{kind: 'tool', id: '1', name: 'edit', summary: 'src/api/usage.ts', status: 'done'},
				{kind: 'tool', id: '2', name: 'run', summary: 'pnpm test api/usage', status: 'done', output: ' Test Files  1 failed (1)\n      Tests  3 failed | 11 passed (14)\n FAIL  api/usage\n'},
			],
			pixel: [{kind: 'user', text: 'start on layout', at: Date.now()}],
		},
	};
}

let dir: string;
beforeEach(() => {
	dir = tmpDir();
});
afterEach(() => undefined);

function mount(file = sample(), live = true) {
	const engine = RunEngine.restore({workspaceDir: path.join(dir, 'ws'), cwd: dir, employees: TEAM, orchestrator: 'claude', binaryFor: () => undefined, autoRun: true, maxParallel: null}, file);
	// A restored unfinished run counts as interrupted; pretend it is live.
	if (live) (engine as unknown as {started: boolean}).started = true;
	const calls = {back: 0, hire: 0, fired: [] as string[]};
	const ui = render(<RunView run={engine} onBack={() => calls.back++} onContinue={() => undefined} onHire={() => calls.hire++} onFire={e => calls.fired.push(e.id)} />);
	const frame = () => ui.lastFrame() ?? '';
	return {engine, ui, frame, calls};
}

const press = async (ui: {stdin: {write: (s: string) => void}}, ...keys: string[]) => {
	// Ink attaches input handlers in an effect after the frame is painted.
	for (const key of keys) {
		await new Promise(r => setTimeout(r, 80));
		ui.stdin.write(key);
	}
};

describe('RunView briefing', () => {
	it('shows the progress header, one lane per agent and the feed', async () => {
		const {ui, frame} = mount();
		await waitFor(() => frame().includes('Activity'), frame);
		const text = frame();
		expect(text).toContain('usage-based pricing page + Stripe metering');
		expect(text).toContain('1/4');
		expect(text).toContain('$3.18');
		expect(text).toContain('78.0k tok');
		// Lanes: numbered, with role and what each is doing.
		expect(text).toMatch(/0 ◆ orchestrator/);
		expect(text).toMatch(/1 ◎ Iris\s+research\s.*✓ done · research\/stripe-metering\.md/);
		expect(text).toMatch(/2 ◈ Forge\s+backend\s.*run pnpm test api\/usage/);
		expect(text).toMatch(/4 ▲ Pixel\s+frontend\s.*waiting on ❖ Muse/);
		// Feed: newest first, with the handoff message in a box.
		expect(text.indexOf('Forge started Do metering')).toBeLessThan(text.indexOf('planned 4 tasks'));
		expect(text).toContain('Muse → ▲ Pixel handoff');
		expect(text).toContain('Highlight the middle tier.');
		expect(text).toContain('j/k scroll feed');
		expect(text).toContain('q detach · keeps running');
		ui.unmount();
	});

	it('expands the selected event and moves through the feed with j and k', async () => {
		const {ui, frame} = mount();
		await waitFor(() => frame().includes('Activity'), frame);
		await press(ui, 'j', 'j', 'j', ENTER);
		// Third-from-newest is Iris's merge, whose detail is the file count.
		await waitFor(() => frame().includes('1 file · no conflicts'), frame);
		await press(ui, ENTER);
		await waitFor(() => !frame().includes('1 file · no conflicts'), frame);
		ui.unmount();
	});

	it('says what happened while you were away', async () => {
		const {engine, ui, frame} = mount();
		ui.unmount();
		engine.lastViewedAt = Date.now() - 25 * 60_000;
		const again = render(<RunView run={engine} onBack={() => undefined} onContinue={() => undefined} />);
		await waitFor(() => (again.lastFrame() ?? '').includes('While you were away'), frame);
		expect(again.lastFrame()).toMatch(/While you were away · 25m · \d events?/);
		again.unmount();
	});

	it('opens an employee with their number, switches tabs, and comes back with escape', async () => {
		const {ui, frame} = mount();
		await waitFor(() => frame().includes('Activity'), frame);
		await press(ui, '2');
		await waitFor(() => frame().includes('EMPLOYEES') && frame().includes('stream'), frame);
		expect(frame()).toContain('Forge');
		expect(frame()).toContain('backend · Codex');
		expect(frame()).toContain('src/api/usage.ts');
		expect(frame()).toContain('WORKTREES');

		await press(ui, TAB);
		await waitFor(() => frame().includes('@@'), frame);
		expect(frame()).toContain('+  await meters.record(customerId, qty)');
		expect(frame()).toContain('-  return notImplemented()');

		await press(ui, TAB);
		await waitFor(() => frame().includes('11 / 14 passing'), frame);
		expect(frame()).toContain('3 failing');
		expect(frame()).toContain('pnpm test api/usage');

		await press(ui, 'j');
		await waitFor(() => frame().includes('Muse') && frame().includes('Do tokens'), frame);
		await press(ui, ESC);
		await waitFor(() => frame().includes('Activity'), frame);
		ui.unmount();
	});

	it('does not offer diffs or tests for the orchestrator', async () => {
		const {ui, frame} = mount();
		await waitFor(() => frame().includes('Activity'), frame);
		await press(ui, '0');
		await waitFor(() => frame().includes('orchestrator ·'), frame);
		expect(frame()).toContain('stream');
		expect(frame()).toContain('chat');
		expect(frame()).not.toContain(' diff ');
		expect(frame()).not.toContain(' tests ');
		ui.unmount();
	});

	it('suggests employees after @ and sends a direct message', async () => {
		const {engine, ui, frame} = mount();
		await waitFor(() => frame().includes('Activity'), frame);
		await press(ui, '@', 'p');
		await waitFor(() => frame().includes('@pixel') && frame().includes('frontend'), frame);
		await press(ui, TAB, 'start on the layout', ENTER);
		await waitFor(() => engine.state.events.some(e => e.kind === 'user' && e.to === 'pixel'), frame);
		expect(engine.logs.pixel!.at(-1)).toMatchObject({kind: 'user', text: 'start on the layout'});
		expect(engine.hasPendingMessage('pixel')).toBe(true);
		ui.unmount();
	});

	it('reports an unknown employee instead of sending', async () => {
		const {engine, ui, frame} = mount();
		await waitFor(() => frame().includes('Activity'), frame);
		await press(ui, '@', 'z', 'e', 'd', ' ', 'h', 'i', ENTER);
		await waitFor(() => frame().includes('Nobody on the team matches @zed'), frame);
		expect(engine.state.events.some(e => e.kind === 'user')).toBe(false);
		ui.unmount();
	});

	it('shows spend and worktrees with /cost and /merge', async () => {
		const {ui, frame} = mount();
		await waitFor(() => frame().includes('Activity'), frame);
		await press(ui, '/', 'c', 'o', 's', 't', ENTER);
		await waitFor(() => frame().includes('Spend'), frame);
		expect(frame()).toContain('$1.12');
		expect(frame()).toContain('41.0k tok');
		await press(ui, ESC);
		await waitFor(() => frame().includes('Activity'), frame);
		await press(ui, '/', 'm', 'e', 'r', 'g', 'e', ENTER);
		await waitFor(() => frame().includes('Worktrees'), frame);
		expect(frame()).toContain('⎇ metering');
		ui.unmount();
	});

	it('opens the palette with ctrl+k and jumps to an employee', async () => {
		const {ui, frame} = mount();
		await waitFor(() => frame().includes('Activity'), frame);
		await press(ui, CTRL_K);
		await waitFor(() => frame().includes('search employees, tasks, events and commands'), frame);
		expect(frame()).toContain('Open Forge');
		await press(ui, 'f', 'o', 'r', 'g');
		await waitFor(() => frame().includes('Open Forge') && !frame().includes('Open Iris'), frame);
		await press(ui, ENTER);
		await waitFor(() => frame().includes('EMPLOYEES') && frame().includes('backend · Codex'), frame);
		ui.unmount();
	});

	it('hires and fires through the callbacks, but not someone with unfinished work', async () => {
		const {ui, frame, calls} = mount();
		await waitFor(() => frame().includes('Activity'), frame);
		await press(ui, '/', 'h', 'i', 'r', 'e', ENTER);
		await waitFor(() => calls.hire === 1, frame);
		await press(ui, '/', 'f', 'i', 'r', 'e', ' ', 'i', 'r', 'i', 's', ENTER);
		await waitFor(() => calls.fired.includes('iris'), frame);
		await press(ui, '/', 'f', 'i', 'r', 'e', ' ', 'p', 'i', 'x', ENTER);
		await waitFor(() => frame().includes('Pixel still has work in this run'), frame);
		expect(calls.fired).toEqual(['iris']);
		ui.unmount();
	});

	it('detaches with q', async () => {
		const {ui, frame, calls} = mount();
		await waitFor(() => frame().includes('Activity'), frame);
		await press(ui, 'q');
		await waitFor(() => calls.back === 1, frame);
		ui.unmount();
	});
});

describe('RunView states', () => {
	it('shows the summary and disables the prompt when the run is done', async () => {
		const file = sample({status: 'done', endedAt: Date.now(), summary: 'Pricing page shipped. Metering is live.', tasks: [task('a', 'iris', 'done')]});
		const {ui, frame} = mount(file, false);
		await waitFor(() => frame().includes('Pricing page shipped.'), frame);
		expect(frame()).toContain('This run has ended.');
		expect(frame()).toContain('q back');
		ui.unmount();
	});

	it('asks to approve a plan', async () => {
		const {engine, ui, frame} = mount(sample({status: 'awaiting-approval'}));
		await waitFor(() => frame().includes('⏎ start the plan'), frame);
		expect(frame()).toContain('Review the plan in the feed');
		expect(engine.state.status).toBe('awaiting-approval');
		ui.unmount();
	});

	it('offers to continue an interrupted run', async () => {
		const {ui, frame} = mount(sample(), false);
		await waitFor(() => frame().includes('interrupted'), frame);
		expect(frame()).toContain('^r continue this run');
		ui.unmount();
	});

	it('warns about a pause', async () => {
		const {ui, frame} = mount(sample({paused: {reason: 'you', at: Date.now()}}));
		await waitFor(() => frame().includes('Paused: running tasks finish'), frame);
		expect(frame()).toContain('^p resume');
		ui.unmount();
	});

	it('works with runs saved before events existed', async () => {
		const file = sample();
		delete (file.state as Partial<typeof file.state>).events;
		delete (file.state as Partial<typeof file.state>).tokens;
		const {ui, frame} = mount(file);
		await waitFor(() => frame().includes('Nothing has happened yet.'), frame);
		ui.unmount();
	});
});
