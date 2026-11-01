import {describe, expect, it} from 'vitest';
import {diffStats, estimateEta, excerpt, formatClock, formatSpan, isTestRun, laneActivity, laneProgress, laneState, parseTestCounts, runProgress} from '../src/core/run/progress.js';
import type {RunState, Task} from '../src/core/run/types.js';
import type {ChatEntry} from '../src/core/transcript.js';

const task = (id: string, assignee: string, status: Task['status'], extra: Partial<Task> = {}): Task => ({id, title: id, assignee, brief: '', dependsOn: [], status, revisions: 0, ...extra});
const state = (tasks: Task[]): RunState => ({tasks}) as RunState;

describe('progress', () => {
	it('counts a running task as half done in a lane', () => {
		const tasks = [task('a', 'maya', 'done'), task('b', 'maya', 'running'), task('c', 'maya', 'blocked'), task('d', 'leo', 'done'), task('x', 'maya', 'cancelled')];
		expect(laneProgress(tasks, 'maya')).toEqual({done: 1, total: 3, fraction: 0.5});
		expect(laneProgress(tasks, 'leo')).toEqual({done: 1, total: 1, fraction: 1});
		expect(laneProgress(tasks, 'nobody')).toEqual({done: 0, total: 0, fraction: 0});
	});

	it('summarises the whole run, ignoring cancelled tasks', () => {
		const run = state([task('a', 'maya', 'done'), task('b', 'leo', 'running'), task('c', 'leo', 'cancelled'), task('d', 'leo', 'ready')]);
		expect(runProgress(run)).toEqual({done: 1, total: 3, fraction: 0.5});
	});

	it('gives no ETA until a task has finished, then uses the average', () => {
		const now = 1_000_000;
		expect(estimateEta(state([task('a', 'maya', 'running', {startedAt: now - 1000})]), now)).toBeUndefined();

		const done = task('a', 'maya', 'done', {startedAt: now - 700_000, endedAt: now - 100_000});
		expect(estimateEta(state([done]), now)).toBe(0);

		// One employee, one finished task of 10 minutes and two more waiting: 20 minutes.
		const eta = estimateEta(state([done, task('b', 'maya', 'ready'), task('c', 'maya', 'blocked')]), now);
		expect(eta).toBe(1_200_000);

		// A task that is half way through counts for what is left of it.
		const midway = task('b', 'leo', 'running', {startedAt: now - 300_000});
		expect(estimateEta(state([done, midway]), now)).toBe(300_000);
	});

	it('formats clocks and spans', () => {
		expect(formatClock(42 * 60_000 + 17_000)).toBe('42:17');
		expect(formatClock(3_725_000)).toBe('1:02:05');
		expect(formatSpan(40_000)).toBe('40s');
		expect(formatSpan(9 * 60_000)).toBe('9m');
		expect(formatSpan(65 * 60_000)).toBe('1h 05m');
	});

	it('shows the latest tool or sentence as a lane activity', () => {
		const log: ChatEntry[] = [
			{kind: 'text', text: 'Working on it.\nMore.'},
			{kind: 'tool', id: '1', name: 'run', summary: 'pnpm test api/usage', status: 'running'},
			{kind: 'turn', ok: true, cancelled: false, durationMs: 1},
		];
		expect(laneActivity(log)).toEqual({text: 'run pnpm test api/usage', running: true});
		expect(laneActivity(log.slice(0, 1))).toEqual({text: 'Working on it.', running: false});
		expect(laneActivity([])).toBeUndefined();
	});

	it('cuts excerpts at a word', () => {
		expect(excerpt('One two\n\nthree')).toBe('One two');
		expect(excerpt('word '.repeat(100), 40).endsWith('…')).toBe(true);
		expect(excerpt(undefined)).toBe('');
	});
});

describe('test runs', () => {
	const tool = (name: string, summary: string): ChatEntry => ({kind: 'tool', id: '1', name, summary, status: 'done'});

	it('recognises test commands among tool calls', () => {
		expect(isTestRun(tool('run', 'pnpm test api/usage'))).toBe(true);
		expect(isTestRun(tool('run', 'npx vitest run'))).toBe(true);
		expect(isTestRun(tool('run', 'cargo test --lib'))).toBe(true);
		expect(isTestRun(tool('run', 'ls -la'))).toBe(false);
		expect(isTestRun(tool('edit', 'src/test.ts'))).toBe(false);
	});

	it('reads counts from common runners', () => {
		expect(parseTestCounts(' Test Files  1 failed (2)\n      Tests  3 failed | 11 passed (14)\n')).toEqual({passed: 11, failed: 3, total: 14});
		expect(parseTestCounts('Tests:       1 failed, 4 passed, 5 total')).toEqual({passed: 4, failed: 1, total: 5});
		expect(parseTestCounts('test result: ok. 4 passed; 0 failed; 0 ignored')).toEqual({passed: 4, failed: 0, total: 4});
		expect(parseTestCounts('=== 3 passed, 1 failed in 0.4s ===')).toEqual({passed: 3, failed: 1, total: 4});
		expect(parseTestCounts('nothing here')).toBeUndefined();
		expect(parseTestCounts(undefined)).toBeUndefined();
	});
});

describe('diffStats', () => {
	it('counts added and removed lines per file', () => {
		const patch = ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,2 +1,3 @@', ' keep', '-old', '+new', '+newer', 'diff --git a/b.md b/b.md', '--- /dev/null', '+++ b/b.md', '+hello'].join('\n');
		expect(diffStats(patch)).toEqual([
			{file: 'src/a.ts', added: 2, removed: 1},
			{file: 'b.md', added: 1, removed: 0},
		]);
	});
});

describe('laneState', () => {
	const tasks = [task('api', 'maya', 'done'), task('ui', 'leo', 'blocked', {dependsOn: ['api', 'copy']}), task('copy', 'rex', 'running')];

	it('says what each employee is doing', () => {
		expect(laneState('rex', tasks, []).kind).toBe('working');
		expect(laneState('rex', tasks, [], true).kind).toBe('attention');
		expect(laneState('maya', tasks, []).kind).toBe('done');
		expect(laneState('nobody', tasks, []).kind).toBe('idle');
	});

	it('names who a blocked employee is waiting for', () => {
		expect(laneState('leo', tasks, [])).toMatchObject({kind: 'waiting', on: 'rex'});
	});

	it('queues ready tasks and flags failures', () => {
		expect(laneState('a', [task('t', 'a', 'ready')], []).kind).toBe('queued');
		expect(laneState('a', [task('t', 'a', 'failed')], []).kind).toBe('stuck');
		// Running work wins over what comes after it.
		expect(laneState('a', [task('t', 'a', 'running'), task('u', 'a', 'blocked')], []).kind).toBe('working');
	});
});
