import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import type {Employee} from '../src/core/employees.js';
import {LIMITS, listRuns, loadRun, RunEngine, type EngineOptions} from '../src/core/run/engine.js';
import {validateNewTasks} from '../src/core/run/orchestrator.js';
import {tmpDir, waitFor} from './helpers.js';

const FAKE = path.join(import.meta.dirname, 'fixtures', 'fake-agent.mjs');

const employee = (id: string, role: string): Employee => ({
	id,
	file: '',
	name: id[0]!.toUpperCase() + id.slice(1),
	role,
	provider: 'claude',
	permissions: 'auto-edit',
	owns: [],
	summary: `${role} work`,
	briefing: '',
	systemPrompt: '',
});

const TEAM = [employee('maya', 'backend'), employee('leo', 'frontend'), employee('rex', 'reviewer')];

let dir: string;
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
	savedEnv = {...process.env};
	dir = tmpDir();
	process.env.FAKE_DIR = dir;
	fs.chmodSync(FAKE, 0o755);
});

afterEach(() => {
	process.env = savedEnv;
});

function script(...decisions: unknown[]) {
	fs.writeFileSync(path.join(dir, 'decisions.json'), JSON.stringify(decisions));
}

type Call = {role: string; task?: string; turn?: number; prompt: string; resume?: string; started: number; ended: number};
function calls(): Call[] {
	const file = path.join(dir, 'calls.jsonl');
	return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l) as Call) : [];
}

function engine(overrides: Partial<EngineOptions> = {}, request = 'Add a checkout endpoint and its UI') {
	const options: EngineOptions = {
		workspaceDir: path.join(dir, 'ws'),
		cwd: dir,
		branch: 'main',
		employees: TEAM,
		orchestrator: 'claude',
		binaryFor: () => FAKE,
		autoRun: true,
		maxParallel: null,
		// Outside the repo, like the real cache folder.
		cacheDir: path.join(tmpDir(), 'cache'),
		...overrides,
	};
	engine.options = options;
	const run = new RunEngine(options, request);
	run.start();
	return run;
}

/** Options of the most recent engine() call, for restoring runs. */
engine.options = undefined as unknown as EngineOptions;

const task = (id: string, assignee: string, depends_on: string[] = []) => ({id, title: `Do ${id}`, assignee, brief: `Brief for ${id}`, depends_on});

describe('RunEngine', () => {
	it('runs a plan in dependency order, passes reports along, and finishes', async () => {
		script(
			{note: 'Splitting into API then UI', tasks: [task('api', 'maya'), task('ui', 'leo', ['api'])]},
			{note: 'API done, waiting for UI'},
			{note: 'All good', finish: 'Checkout endpoint and UI are in place.'},
		);
		const run = engine();
		await run.done;

		expect(run.state.status).toBe('done');
		expect(run.state.summary).toBe('Checkout endpoint and UI are in place.');
		expect(run.state.tasks.map(t => [t.id, t.status])).toEqual([
			['api', 'done'],
			['ui', 'done'],
		]);

		const [plan, ...rest] = calls();
		expect(plan!.prompt).toContain('Add a checkout endpoint and its UI');
		const api = rest.find(c => c.task === 'api')!;
		const ui = rest.find(c => c.task === 'ui')!;
		expect(ui.started).toBeGreaterThanOrEqual(api.ended);
		expect(ui.prompt).toContain('Context from earlier tasks');
		expect(ui.prompt).toContain('Report for api: done');

		// The orchestrator keeps one session across turns and hears about each report.
		const orchestratorTurns = calls().filter(c => c.role === 'orchestrator');
		expect(orchestratorTurns).toHaveLength(3);
		expect(orchestratorTurns[1]!.resume).toMatch(/^session-orchestrator-/);
		expect(orchestratorTurns[1]!.prompt).toContain('Task "api" (Maya) finished');

		const saved = await loadRun(path.join(dir, 'ws'), run.state.id);
		expect(saved?.state.status).toBe('done');
		expect(saved?.logs.maya?.some(e => e.kind === 'brief')).toBe(true);
		expect((await listRuns(path.join(dir, 'ws')))[0]).toMatchObject({id: run.state.id, status: 'done', tasks: 2, interrupted: false});
	});

	it("tells the run's story as events: plan, start, handoff, finish", async () => {
		script({note: 'API then UI', tasks: [task('api', 'maya'), task('ui', 'leo', ['api'])]}, {note: 'waiting'}, {finish: 'All done.'});
		const run = engine();
		await run.done;

		const events = run.state.events;
		expect(events.map(e => e.id)).toEqual(events.map((_, i) => i + 1));
		const kinds = events.map(e => `${e.kind}:${e.agent}`);
		expect(kinds[0]).toBe('plan:orchestrator');
		expect(events[0]).toMatchObject({text: 'planned 2 tasks'});
		expect(events[0]!.detail).toContain('ui → Leo');
		expect(kinds).toContain('start:maya');
		expect(kinds).toContain('done:maya');
		expect(kinds.at(-1)).toBe('finish:orchestrator');

		// Leo's task builds on Maya's, so her report is handed over to him.
		const handoff = events.find(e => e.kind === 'handoff')!;
		expect(handoff).toMatchObject({agent: 'maya', to: 'leo', taskId: 'ui'});
		expect(handoff.detail).toContain('Report for api: done');
		// …and it comes before Leo starts.
		expect(events.indexOf(handoff)).toBeLessThan(events.findIndex(e => e.kind === 'start' && e.agent === 'leo'));

		const saved = await loadRun(path.join(dir, 'ws'), run.state.id);
		expect(saved?.state.events).toHaveLength(events.length);
	});

	it('counts tokens and cost per task', async () => {
		script({tasks: [task('api', 'maya')]}, {finish: 'done'});
		const run = engine();
		await run.done;
		const api = run.state.tasks[0]!;
		expect(api.costUsd).toBeGreaterThan(0);
		expect(run.state.costUsd).toBeGreaterThan(api.costUsd!);
		expect(run.state.tokens).toBeGreaterThanOrEqual(api.tokens ?? 0);
	});

	it('records a revision as an event with the feedback', async () => {
		script({tasks: [task('api', 'maya')]}, {revisions: [{task: 'api', feedback: 'Add input validation'}]}, {finish: 'done'});
		const run = engine();
		await run.done;
		const revision = run.state.events.find(e => e.kind === 'revision')!;
		expect(revision).toMatchObject({agent: 'orchestrator', to: 'maya', taskId: 'api', detail: 'Add input validation'});
		expect(run.state.events.filter(e => e.kind === 'start' && e.agent === 'maya')).toHaveLength(2);
		// A revision is not a new handoff.
		expect(run.state.events.some(e => e.kind === 'handoff')).toBe(false);
	});

	it('keeps a direct message for the employee, and tells the orchestrator', () => {
		// No agent CLI is available, so nothing is started; this only checks what the engine records.
		const options: EngineOptions = {workspaceDir: path.join(dir, 'ws2'), cwd: dir, employees: TEAM, orchestrator: 'claude', binaryFor: () => undefined, autoRun: true, maxParallel: null, cacheDir: path.join(tmpDir(), 'cache')};
		const run = new RunEngine(options, 'Build it');
		run.tellEmployee('maya', 'Please use zod');
		expect(run.hasPendingMessage('maya')).toBe(true);
		expect(run.hasPendingMessage('leo')).toBe(false);
		expect(run.logs.maya).toEqual([expect.objectContaining({kind: 'user', text: 'Please use zod'})]);
		expect(run.state.events).toEqual([expect.objectContaining({kind: 'user', agent: 'user', to: 'maya', text: 'Please use zod'})]);
		// Someone who isn't on the team: it goes to the orchestrator instead.
		run.tellEmployee('nobody', 'hello');
		expect(run.state.events.at(-1)).toMatchObject({kind: 'user', to: 'orchestrator'});
	});

	it('picks up hires, and keeps someone with unfinished work until it is done', async () => {
		process.env.FAKE_SLEEP_MS = '300';
		script({tasks: [task('api', 'maya')]}, {finish: 'done'});
		const run = engine();
		await waitFor(() => run.isBusy('maya'));
		run.syncTeam([employee('leo', 'frontend'), employee('rex', 'reviewer'), employee('zoe', 'docs')]);
		const ids = run.employees.map(e => e.id);
		expect(ids).toContain('zoe');
		expect(ids).toContain('maya');
		expect(run.state.events.filter(e => e.kind === 'hire').map(e => e.to)).toEqual(['zoe']);
		expect(run.state.events.some(e => e.kind === 'fire' && e.to === 'maya')).toBe(false);
		await run.done;
		run.cancel();
	});

	it("shows the orchestrator the repo's uncommitted changes after each task", async () => {
		execFileSync('git', ['init', '-q'], {cwd: dir});
		execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'base'], {cwd: dir});
		fs.writeFileSync(path.join(dir, 'already-dirty.txt'), 'mine');
		process.env.FAKE_WRITE = '1';
		script({tasks: [task('api', 'maya')]}, {finish: 'done'});
		const run = engine();
		await run.done;
		const [plan, update] = calls().filter(c => c.role === 'orchestrator');
		expect(plan!.prompt).toContain('already had uncommitted changes');
		expect(plan!.prompt).toContain('already-dirty.txt');
		expect(update!.prompt).toContain('Uncommitted changes in the working tree now');
		expect(update!.prompt).toContain('?? api.txt');
		// polyagent's own files are never shown as changes.
		expect(update!.prompt).not.toContain('.polyagent');
	});

	it('reports invalid tasks back to the orchestrator instead of running them', async () => {
		script({tasks: [task('a', 'bob'), task('b', 'maya')]}, {finish: 'done'});
		const run = engine();
		await run.done;
		expect(run.state.tasks.map(t => t.id)).toEqual(['b']);
		expect(calls().filter(c => c.role === 'orchestrator')[1]!.prompt).toContain(`assigned to "bob", who isn't on the team`);
	});

	it('sends work back for revision in the same employee session', async () => {
		script({tasks: [task('api', 'maya')]}, {revisions: [{task: 'api', feedback: 'Add input validation'}]}, {finish: 'done'});
		const run = engine();
		await run.done;
		const attempts = calls().filter(c => c.task === 'api');
		expect(attempts).toHaveLength(2);
		expect(attempts[1]!.prompt).toContain('Add input validation');
		expect(attempts[1]!.resume).toMatch(/^session-api-/);
		expect(run.state.tasks[0]).toMatchObject({status: 'done', revisions: 1});
	});

	it('tells the orchestrator when a task fails', async () => {
		process.env.FAKE_FAIL = 'api';
		script({tasks: [task('api', 'maya')]}, {finish: 'Could not finish: api failed'});
		const run = engine();
		await run.done;
		expect(run.state.tasks[0]).toMatchObject({status: 'failed', error: 'Error: api exploded'});
		expect(calls().filter(c => c.role === 'orchestrator')[1]!.prompt).toContain('Task "api" (Maya) FAILED: Error: api exploded');
	});

	it('waits for approval when auto-run is off', async () => {
		script({tasks: [task('api', 'maya')]}, {finish: 'done'});
		const run = engine({autoRun: false});
		await waitFor(() => run.state.status === 'awaiting-approval');
		await new Promise(r => setTimeout(r, 300));
		expect(calls().filter(c => c.role === 'employee')).toHaveLength(0);
		run.approve();
		await run.done;
		expect(run.state.status).toBe('done');
	});

	it('cancel stops running work', async () => {
		process.env.FAKE_SLEEP_MS = '30000';
		script({tasks: [task('api', 'maya')]});
		const run = engine();
		await waitFor(() => run.state.tasks[0]?.status === 'running');
		run.cancel();
		await run.done;
		expect(run.state.status).toBe('cancelled');
		expect(run.state.tasks[0]!.status).toBe('cancelled');
		expect(run.working).toBe(false);
	});

	it('gives up when the orchestrator keeps replying with garbage', async () => {
		script('bad');
		const run = engine();
		await run.done;
		expect(run.state.status).toBe('failed');
		expect(calls().filter(c => c.role === 'orchestrator')).toHaveLength(LIMITS.idleDecisions + 1);
	});

	it('runs independent tasks in parallel when allowed, one task per employee at a time', async () => {
		process.env.FAKE_SLEEP_MS = '400';
		script({tasks: [task('a1', 'maya'), task('b', 'leo'), task('a2', 'maya')]}, {}, {}, {finish: 'done'});
		const run = engine({concurrency: 4});
		await run.done;
		const byTask = Object.fromEntries(calls().filter(c => c.task).map(c => [c.task, c]));
		const overlap = (x: Call, y: Call) => x.started < y.ended && y.started < x.ended;
		expect(overlap(byTask.a1!, byTask.b!)).toBe(true);
		expect(overlap(byTask.a1!, byTask.a2!)).toBe(false);
	});
});

describe('RunEngine controls', () => {
	it('pause holds new work until resumed', async () => {
		script({tasks: [task('api', 'maya')]}, {finish: 'done'});
		const run = engine();
		run.pause();
		await waitFor(() => run.state.tasks.length === 1);
		await new Promise(r => setTimeout(r, 400));
		expect(run.state.tasks[0]!.status).toBe('ready');
		expect(calls().filter(c => c.role === 'employee')).toHaveLength(0);
		run.resume();
		await run.done;
		expect(run.state.status).toBe('done');
	});

	it('pauses at the budget and allows another budget on resume', async () => {
		// Each fake orchestrator turn costs $0.01.
		script({tasks: [task('api', 'maya')]}, {finish: 'done'});
		const run = engine({runBudget: 0.005});
		await waitFor(() => run.state.paused?.reason === 'budget');
		expect(run.state.tasks[0]!.status).toBe('ready');
		expect(run.logs.orchestrator!.some(e => e.kind === 'note' && /reaching its budget/.test(e.text))).toBe(true);
		run.resume();
		await waitFor(() => run.state.tasks[0]!.status === 'done' || run.state.paused !== undefined);
		// The next orchestrator turn passes the new limit again; resuming once more lets it finish.
		await waitFor(() => run.state.paused !== undefined || run.state.status === 'done');
		if (run.state.paused) run.resume();
		await run.done;
		expect(run.state.status).toBe('done');
	});

	it('stops a task that runs past the time limit', async () => {
		process.env.FAKE_SLEEP_MS = '30000';
		script({tasks: [task('api', 'maya')]}, {finish: 'gave up'});
		const run = engine({taskTimeoutMinutes: 0.01});
		await run.done;
		expect(run.state.tasks[0]).toMatchObject({status: 'failed', error: 'Stopped after 0.01 minutes (the task time limit).'});
		expect(calls().filter(c => c.role === 'orchestrator')[1]!.prompt).toContain('task time limit');
	});

	it('continues an interrupted run from its saved file', async () => {
		script({finish: 'Finished after the restart.'});
		const saved = engine();
		saved.cancel();
		await saved.done;
		const file = (await loadRun(path.join(dir, 'ws'), saved.state.id))!;
		// Make it look like polyagent died mid-task.
		file.state.status = 'running';
		file.state.summary = undefined;
		file.state.tasks = [{id: 'api', title: 'Do api', assignee: 'maya', brief: 'Brief for api', dependsOn: [], status: 'running', revisions: 0}];

		const run = RunEngine.restore(engine.options, file);
		expect(run.interrupted).toBe(true);
		void run.continueRun();
		await run.done;
		expect(run.state.tasks[0]!.status).toBe('done');
		expect(run.state.summary).toBe('Finished after the restart.');
		expect(calls().filter(c => c.role === 'orchestrator').at(-1)!.prompt).toContain('polyagent was restarted. Tasks "api" were interrupted');
	});

	it('restores a finished run read-only', async () => {
		script({finish: 'All done.'});
		const first = engine();
		await first.done;
		const run = RunEngine.restore(engine.options, (await loadRun(path.join(dir, 'ws'), first.state.id))!);
		expect(run.interrupted).toBe(false);
		await run.done;
		expect(run.state.summary).toBe('All done.');
	});
});

describe('RunEngine with worktrees', () => {
	function gitRepo() {
		execFileSync('git', ['init', '-q', '-b', 'main'], {cwd: dir});
		fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n');
		execFileSync('git', ['add', '.'], {cwd: dir});
		execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'base'], {cwd: dir});
	}

	it('runs independent tasks in parallel in separate worktrees and merges both', async () => {
		gitRepo();
		process.env.FAKE_WRITE = '1';
		// Long enough to overlap even when setting up the second worktree is slow on a loaded machine.
		process.env.FAKE_SLEEP_MS = '4000';
		script({tasks: [task('api', 'maya'), task('ui', 'leo')]}, {}, {finish: 'done'});
		const run = engine();
		await run.done;

		expect(run.state.isolation?.mode).toBe('worktrees');
		const byTask = Object.fromEntries(calls().filter(c => c.task).map(c => [c.task, c]));
		expect(byTask.api!.started < byTask.ui!.ended && byTask.ui!.started < byTask.api!.ended).toBe(true);
		expect(byTask.api!.prompt).toContain('your own copy of the repository');
		expect(fs.readFileSync(path.join(dir, 'api.txt'), 'utf8')).toBe('written by api (attempt 1)\n');
		expect(fs.readFileSync(path.join(dir, 'ui.txt'), 'utf8')).toBe('written by ui (attempt 1)\n');
		expect(run.state.tasks.map(t => t.files)).toEqual([['api.txt'], ['ui.txt']]);
		// Worktrees are gone afterwards; the branch is unchanged.
		expect(execFileSync('git', ['worktree', 'list'], {cwd: dir, encoding: 'utf8'}).trim().split('\n')).toHaveLength(1);
		expect(execFileSync('git', ['branch', '--show-current'], {cwd: dir, encoding: 'utf8'}).trim()).toBe('main');
	});

	it("keeps each task's diff and records merges as events", async () => {
		gitRepo();
		process.env.FAKE_WRITE = '1';
		script({tasks: [task('api', 'maya'), task('ui', 'leo')]}, {}, {finish: 'done'});
		const run = engine();
		await run.done;

		const [api, ui] = run.state.tasks;
		expect(api!.patch).toContain('diff --git a/api.txt b/api.txt');
		expect(api!.patch).toContain('+written by api (attempt 1)');
		expect(api!.patch).not.toContain('ui.txt');
		expect(ui!.patch).toContain('+written by ui (attempt 1)');

		const merges = run.state.events.filter(e => e.kind === 'merge');
		expect(merges.map(e => e.taskId).sort()).toEqual(['api', 'ui']);
		expect(merges[0]!.text).toMatch(/^merged ⎇ \w+ → main$/);
		expect(merges[0]!.detail).toContain('1 file · no conflicts');
		// A merge comes after the task starts and before the run finishes.
		const at = (kind: string, taskId: string) => run.state.events.findIndex(e => e.kind === kind && e.taskId === taskId);
		expect(at('start', 'api')).toBeLessThan(at('merge', 'api'));
		expect(at('merge', 'api')).toBeLessThan(run.state.events.findIndex(e => e.kind === 'finish'));
	});

	it('shows what an employee has changed so far, including new files', async () => {
		gitRepo();
		process.env.FAKE_WRITE = '1';
		process.env.FAKE_SLEEP_MS = '2500';
		script({tasks: [task('api', 'maya')]}, {}, {finish: 'done'});
		const run = engine();
		// The fake agent writes its file after the sleep, so poll for it.
		await waitFor(() => run.isBusy('maya'));
		expect(await run.liveDiff('nobody')).toBeUndefined();
		let live: string | undefined;
		await waitFor(() => {
			void run.liveDiff('maya').then(d => (live = d));
			return live?.includes('api.txt') ?? false;
		});
		expect(live).toContain('+written by api (attempt 1)');
		await run.done;
	});

	it('reports a clash, and the revision starts from the merged code', async () => {
		gitRepo();
		process.env.FAKE_WRITE = 'shared.txt';
		// "one" merges first; "two" finishes later and clashes.
		process.env.FAKE_SLEEP_MS_two = '1500';
		script({tasks: [task('one', 'maya'), task('two', 'leo')]}, {}, {revisions: [{task: 'two', feedback: 'Redo it'}]}, {}, {finish: 'done'});
		const run = engine();
		await run.done;

		const two = run.state.tasks.find(t => t.id === 'two')!;
		expect(two).toMatchObject({status: 'done', revisions: 1});
		const orchestratorPrompts = calls().filter(c => c.role === 'orchestrator').map(c => c.prompt).join('\n');
		expect(orchestratorPrompts).toMatch(/clash with work already merged/);
		const retry = calls().filter(c => c.task === 'two')[1]!;
		expect(retry.prompt).toContain('clashed with changes another employee made to shared.txt');
		expect(fs.readFileSync(path.join(dir, 'shared.txt'), 'utf8')).toBe('written by two (attempt 2)\n');
	});

	it('falls back to one task at a time outside git', async () => {
		script({tasks: [task('a', 'maya'), task('b', 'leo')]}, {}, {finish: 'done'});
		const run = engine();
		await run.done;
		expect(run.state.isolation).toEqual({mode: 'shared', reason: "this folder isn't a git repository"});
		const [a, b] = calls().filter(c => c.task);
		expect(b!.started).toBeGreaterThanOrEqual(a!.ended);
	});
});

describe('validateNewTasks', () => {
	it('rejects cycles and anything depending on a rejected task', () => {
		const {accepted, errors} = validateNewTasks(
			[task('a', 'maya', ['c']), task('b', 'maya', ['a']), task('c', 'maya', ['a']), task('d', 'nobody'), task('e', 'maya', ['d'])],
			[],
			TEAM,
		);
		expect(accepted).toEqual([]);
		expect(errors.join('\n')).toMatch(/cycle/);
		expect(errors.join('\n')).toMatch(/"e" depends on unknown or rejected task "d"/);
	});
});
