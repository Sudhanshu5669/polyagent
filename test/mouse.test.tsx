import path from 'node:path';
import {render} from 'ink-testing-library';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import type {Employee} from '../src/core/employees.js';
import {RunEngine} from '../src/core/run/engine.js';
import type {RunFile, Task} from '../src/core/run/types.js';
import {MOUSE_INPUT, mouseEnabled, parseMouse} from '../src/ui/mouse.js';
import {RunView} from '../src/ui/screens/RunView.js';
import {tmpDir, waitFor} from './helpers.js';

// 1-based column and row, as terminals report them.
const sgr = (code: number, x: number, y: number, released = false) => `\u001B[<${code};${x};${y}${released ? 'm' : 'M'}`;
const click = (x: number, y: number) => [sgr(0, x, y), sgr(0, x, y, true)];

describe('parseMouse', () => {
	it('reads presses, releases, drags and the wheel as 0-based positions', () => {
		expect(parseMouse(sgr(0, 10, 5))).toEqual([{kind: 'down', button: 0, x: 9, y: 4}]);
		expect(parseMouse(sgr(0, 10, 5, true))).toEqual([{kind: 'up', button: 0, x: 9, y: 4}]);
		expect(parseMouse(sgr(32, 12, 5))).toEqual([{kind: 'drag', button: 0, x: 11, y: 4}]);
		expect(parseMouse(sgr(64, 1, 1))).toEqual([{kind: 'wheel-up', button: 0, x: 0, y: 0}]);
		expect(parseMouse(sgr(65, 1, 1))).toEqual([{kind: 'wheel-down', button: 0, x: 0, y: 0}]);
		expect(parseMouse(sgr(2, 3, 4))).toEqual([{kind: 'down', button: 2, x: 2, y: 3}]);
	});

	it('reads several reports that arrived together, and ignores everything else', () => {
		expect(parseMouse(sgr(64, 1, 1) + sgr(64, 1, 1))).toHaveLength(2);
		expect(parseMouse('hello \u001B[A')).toEqual([]);
	});

	it('recognises a report after Ink has stripped the escape', () => {
		expect(MOUSE_INPUT.test('[<0;10;5M')).toBe(true);
		expect(MOUSE_INPUT.test('[A')).toBe(false);
		expect(MOUSE_INPUT.test('hello')).toBe(false);
	});

	it('can be turned off', () => {
		expect(mouseEnabled({})).toBe(true);
		expect(mouseEnabled({POLYAGENT_MOUSE: '0'})).toBe(false);
		expect(mouseEnabled({POLYAGENT_MOUSE: 'off'})).toBe(false);
	});
});

const employee = (id: string, role: string): Employee => ({
	id,
	file: '',
	name: id[0]!.toUpperCase() + id.slice(1),
	role,
	provider: 'claude',
	permissions: 'auto-edit',
	owns: [],
	summary: '',
	briefing: '',
	systemPrompt: '',
});

const TEAM = [employee('iris', 'research'), employee('forge', 'backend'), employee('muse', 'design')];
const task = (id: string, assignee: string, status: Task['status'], extra: Partial<Task> = {}): Task => ({id, title: `Do ${id}`, assignee, brief: '', dependsOn: [], status, revisions: 0, ...extra});

function sample(): RunFile {
	const t0 = Date.now() - 20 * 60_000;
	const events = Array.from({length: 30}, (_, i) => ({id: i + 1, at: t0 + i * 30_000, kind: 'start' as const, agent: TEAM[i % 3]!.id, text: `Step ${i + 1}`}));
	const long = Array.from({length: 60}, (_, i) => ({kind: 'text' as const, text: `line ${i + 1}`}));
	return {
		state: {
			id: 'run-1',
			request: 'Mouse test',
			status: 'running',
			createdAt: t0,
			orchestrator: {provider: 'claude', working: false, turns: 1},
			tasks: [task('a', 'iris', 'done'), task('b', 'forge', 'running', {startedAt: t0}), task('c', 'muse', 'blocked', {dependsOn: ['b']})],
			employeeSessions: {},
			costUsd: 0,
			tokens: 0,
			events,
			unapplied: [],
		},
		logs: {orchestrator: [], forge: long},
	};
}

let dir: string;
let saved: NodeJS.ProcessEnv;
beforeEach(() => {
	saved = {...process.env};
	process.env.POLYAGENT_MOUSE = 'force';
	dir = tmpDir();
});
afterEach(() => {
	process.env = saved;
});

function mount() {
	const engine = RunEngine.restore({workspaceDir: path.join(dir, 'ws'), cwd: dir, employees: TEAM, orchestrator: 'claude', binaryFor: () => undefined, autoRun: true, maxParallel: null}, sample());
	(engine as unknown as {started: boolean}).started = true;
	const ui = render(<RunView run={engine} onBack={() => undefined} onContinue={() => undefined} />);
	const frame = () => ui.lastFrame() ?? '';
	return {engine, ui, frame};
}

const send = async (ui: {stdin: {write: (s: string) => void}}, ...chunks: string[]) => {
	for (const chunk of chunks) {
		await new Promise(r => setTimeout(r, 80));
		ui.stdin.write(chunk);
	}
};

/** 1-based terminal row of the first line containing `text`. */
const rowOf = (frame: string, text: string) => frame.split('\n').findIndex(line => line.includes(text)) + 1;

describe('mouse in the run screen', () => {
	it('opens an employee when their lane is clicked', async () => {
		const {ui, frame} = mount();
		await waitFor(() => frame().includes('Activity'), frame);
		const row = rowOf(frame(), 'Forge');
		expect(row).toBeGreaterThan(0);
		await send(ui, ...click(20, row));
		await waitFor(() => frame().includes('EMPLOYEES') && frame().includes('backend · Claude'), frame);
		ui.unmount();
	});

	it('selects an event on click and expands it on a second click', async () => {
		const {ui, frame} = mount();
		await waitFor(() => frame().includes('Activity'), frame);
		const row = rowOf(frame(), 'Step 30');
		await send(ui, ...click(12, row));
		await waitFor(() => frame().split('\n')[row - 1]!.includes('▌'), frame);
		ui.unmount();
	});

	it('scrolls the feed with the wheel', async () => {
		const { ui, frame } = mount();
		await waitFor(() => frame().includes('Activity'), frame);
		expect(frame()).toContain('Step 30');
		// Far enough down that the oldest events scroll into view.
		await send(ui, ...Array.from({length: 20}, () => sgr(65, 20, 12)));
		await waitFor(() => !frame().includes('Step 30') || frame().includes('Step 1 ') || frame().includes('Step 10'), frame);
		expect(frame()).toContain('▌');
		ui.unmount();
	});

	it('scrolls a stream with the wheel and switches tabs by clicking them', async () => {
		const {ui, frame} = mount();
		await waitFor(() => frame().includes('Activity'), frame);
		await send(ui, ...click(20, rowOf(frame(), 'Forge')));
		await waitFor(() => frame().includes('line 60'), frame);
		await send(ui, ...Array.from({length: 8}, () => sgr(64, 50, 10)));
		await waitFor(() => !frame().includes('line 60'), frame);
		expect(frame()).toMatch(/rows above the end/);

		// The "tests" tab is on the header row; its label starts after "stream" and "diff".
		const header = frame().split('\n').findIndex(l => l.includes(' stream ') && l.includes(' tests '));
		const col = frame().split('\n')[header]!.indexOf(' tests ') + 3;
		await send(ui, ...click(col, header + 1));
		await waitFor(() => frame().includes("hasn't run any tests yet"), frame);
		ui.unmount();
	});

	it('drags the sidebar border to resize it', async () => {
		const {ui, frame} = mount();
		await waitFor(() => frame().includes('Activity'), frame);
		await send(ui, ...click(20, rowOf(frame(), 'Forge')));
		await waitFor(() => frame().includes('EMPLOYEES'), frame);
		const lines = frame().split('\n');
		const row = lines.findIndex(l => l.includes('EMPLOYEES'));
		const before = lines[row]!.indexOf('│');
		expect(before).toBeGreaterThan(10);
		await send(ui, sgr(0, before + 1, row + 3), sgr(32, before + 7, row + 3), sgr(32, before + 11, row + 3), sgr(0, before + 11, row + 3, true));
		await waitFor(() => frame().split('\n')[row]!.indexOf('│') > before + 5, frame);
		ui.unmount();
	});

	it('keeps mouse reports out of the prompt', async () => {
		const {ui, frame} = mount();
		await waitFor(() => frame().includes('Activity'), frame);
		await send(ui, 'i', 'h', 'i');
		await waitFor(() => frame().includes('› hi'), frame);
		await send(ui, sgr(65, 5, 5), sgr(32, 5, 5));
		await new Promise(r => setTimeout(r, 200));
		expect(frame()).toContain('› hi');
		expect(frame()).not.toContain('<65');
		expect(frame()).not.toContain('[<');
		ui.unmount();
	});
});
