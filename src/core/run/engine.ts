import fs from 'node:fs/promises';
import path from 'node:path';
import {runTurn, type RunningTurn} from '../agents/runner.js';
import {employeeSystemPrompt} from '../chat.js';
import {slugify, type Employee} from '../employees.js';
import {readJson, writeJson} from '../fs.js';
import {workingTreeChanges} from '../git.js';
import {WorktreeIsolation} from './worktrees.js';
import {PROVIDERS, type ProviderId} from '../providers.js';
import {TurnRecorder, type ChatEntry} from '../transcript.js';
import {
	DECISION_SCHEMA,
	orchestratorSystemPrompt,
	parseDecision,
	planPrompt,
	taskPrompt,
	updatePrompt,
	validateNewTasks,
	type Decision,
	type Update,
} from './orchestrator.js';
import {compactEvents, excerpt} from './progress.js';
import {isFinished, ORCHESTRATOR, type RunEvent, type RunEventKind, type RunFile, type RunState, type RunStatus, type Task, type TaskStatus} from './types.js';

export interface EngineOptions {
	workspaceDir: string;
	/** Repository root; every agent runs here. */
	cwd: string;
	branch?: string;
	employees: Employee[];
	orchestrator: ProviderId;
	/** Omitted = the CLI's default model. */
	orchestratorModel?: string;
	binaryFor: (provider: ProviderId) => string | undefined;
	autoRun: boolean;
	/** User setting; null = no limit. */
	maxParallel: number | null;
	/**
	 * 'worktrees' (default): each employee works in their own git worktree and tasks run in parallel;
	 * falls back to 'shared' (one task at a time in the working tree) where worktrees can't be used.
	 */
	isolation?: 'worktrees' | 'shared';
	/** Override the engine's own cap on simultaneous tasks (tests). */
	concurrency?: number;
	/** Flags that route an employee's approval requests to the user (Claude Code), when approvals are on. */
	approvalArgs?: (employee: Employee) => string[] | undefined;
	/** Pause once the run has cost this many dollars; null = no budget. */
	runBudget?: number | null;
	/** Stop a task after this many minutes; null = no limit. */
	taskTimeoutMinutes?: number | null;
	/** Where worktrees live; defaults to the user cache folder. */
	cacheDir?: string;
}

/** Guard rails that hold no matter what the orchestrator decides. */
export const LIMITS = {
	orchestratorTurns: 30,
	revisionsPerTask: 3,
	/** Decisions in a row that change nothing while problems are reported back. */
	idleDecisions: 2,
};

export function runsDir(workspaceDir: string): string {
	return path.join(workspaceDir, 'runs');
}

function newRunId(request: string, now = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
	return `${stamp}-${slugify(request).slice(0, 40).replace(/-$/, '')}`;
}

/**
 * One run: the orchestrator decides what to do, this class decides when.
 * It starts tasks whose dependencies are done, feeds finished reports back to the orchestrator
 * (batched while it is busy), enforces limits, and saves everything under .polyagent/runs/<id>/.
 */
export class RunEngine {
	readonly state: RunState;
	logs: Record<string, ChatEntry[]> = {[ORCHESTRATOR]: []};
	readonly done: Promise<void>;
	version = 0;

	private readonly listeners = new Set<() => void>();
	private readonly turns = new Map<string, RunningTurn>();
	private updates: Update[] = [];
	private errors: string[] = [];
	private idleDecisions = 0;
	private saveTimer?: NodeJS.Timeout;
	private saving: Promise<void> = Promise.resolve();
	private resolveDone!: () => void;
	private iso?: WorktreeIsolation;
	/** Spend at which the run pauses next; raised by one budget each time the user resumes. */
	private budgetLimit: number;
	/** Messages you sent an employee directly; they go into that employee's next task. */
	private readonly messages = new Map<string, string[]>();
	/** When someone last looked at this run, so the screen can say what happened in the meantime. */
	lastViewedAt?: number;

	constructor(
		private readonly options: EngineOptions,
		request: string,
	) {
		this.state = {
			id: newRunId(request),
			request,
			status: 'planning',
			createdAt: Date.now(),
			branch: options.branch,
			orchestrator: {provider: options.orchestrator, working: false, turns: 0},
			tasks: [],
			employeeSessions: {},
			costUsd: 0,
			tokens: 0,
			events: [],
			unapplied: [],
		};
		this.done = new Promise(resolve => (this.resolveDone = resolve));
		this.budgetLimit = options.runBudget ?? Number.POSITIVE_INFINITY;
	}

	get dir(): string {
		return path.join(runsDir(this.options.workspaceDir), this.state.id);
	}

	get employees(): Employee[] {
		return this.options.employees;
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	start(): void {
		this.started = true;
		this.changed();
		void this.setUp();
	}

	private async setUp(): Promise<void> {
		const {state} = this;
		const dirty = await workingTreeChanges(this.options.cwd, 2000);
		await this.isolate(state.id);
		if (isFinished(state.status)) return;
		await this.orchestratorTurn(planPrompt(state.request, dirty, state.isolation?.mode === 'worktrees'));
	}

	private async isolate(runKey: string): Promise<void> {
		const {options, state} = this;
		if (options.isolation !== 'shared') {
			const iso = await WorktreeIsolation.create(options.cwd, runKey, options.cacheDir);
			if (iso instanceof WorktreeIsolation) {
				this.iso = iso;
				state.isolation = {mode: 'worktrees', ref: iso.ref, base: iso.base};
			} else state.isolation = {mode: 'shared', reason: iso.reason};
		} else state.isolation = {mode: 'shared', reason: 'parallel work is turned off'};

		this.log(ORCHESTRATOR).push({
			kind: 'note',
			text:
				state.isolation.mode === 'worktrees'
					? 'Employees work in their own git worktrees, in parallel. Finished work is merged into your working tree.'
					: `Tasks run one at a time in your working tree: ${state.isolation.reason}.`,
		});
	}

	/** Rebuild a run from its saved file: to look at a past run, or to continue one that was interrupted. */
	static restore(options: EngineOptions, file: RunFile): RunEngine {
		const engine = new RunEngine(options, file.state.request);
		Object.assign(engine.state, file.state, {unapplied: file.state.unapplied ?? [], events: file.state.events ?? [], tokens: file.state.tokens ?? 0});
		engine.logs = {[ORCHESTRATOR]: [], ...file.logs};
		engine.budgetLimit = options.runBudget ? file.state.costUsd + options.runBudget : Number.POSITIVE_INFINITY;
		if (isFinished(file.state.status)) engine.resolveDone();
		return engine;
	}

	/** True for a saved run that stopped without finishing (polyagent quit or crashed). */
	get interrupted(): boolean {
		return !isFinished(this.state.status) && this.turns.size === 0 && !this.started;
	}

	private started = false;

	/**
	 * Continue an interrupted run. Work that was in flight is lost, so those tasks start again;
	 * finished work is already in the working tree, which becomes the new snapshot.
	 */
	async continueRun(): Promise<void> {
		const {state} = this;
		if (isFinished(state.status) || this.started) return;
		this.started = true;
		const restarted = state.tasks.filter(t => t.status === 'running');
		for (const task of restarted) task.status = 'ready';
		state.orchestrator.working = false;
		this.log(ORCHESTRATOR).push({kind: 'note', text: 'Continuing after polyagent was restarted.'});
		this.changed();

		await this.isolate(`${state.id}-continued-${Date.now()}`);
		if (state.status === 'planning') {
			await this.orchestratorTurn(planPrompt(state.request, undefined, state.isolation?.mode === 'worktrees'));
			return;
		}

		const names = restarted.map(t => `"${t.id}"`).join(', ');
		this.updates.push({
			kind: 'user',
			text: `polyagent was restarted. ${restarted.length ? `Tasks ${names} were interrupted and are starting again. ` : ''}Everything else is as you left it.`,
		});
		this.pump();
	}

	/** Start a plan that is waiting for approval (autoRun off). */
	approve(): void {
		if (this.state.status !== 'awaiting-approval') return;
		this.state.status = 'running';
		this.pump();
	}

	/** Record something worth telling someone who wasn't watching. */
	private emit(kind: RunEventKind, agent: string, text: string, extra: {to?: string; detail?: string; taskId?: string} = {}): void {
		const {events} = this.state;
		const id = (events.at(-1)?.id ?? 0) + 1;
		events.push({id, at: Date.now(), kind, agent, text, ...extra});
		if (events.length > 600) this.state.events = compactEvents(events);
	}

	private name(id: string): string {
		return this.options.employees.find(e => e.id === id)?.name ?? id;
	}

	/** Pass a message to the orchestrator; it is delivered on its next turn. */
	tell(text: string): void {
		if (isFinished(this.state.status)) return;
		this.log(ORCHESTRATOR).push({kind: 'user', text, at: Date.now()});
		this.updates.push({kind: 'user', text});
		this.emit('user', 'user', excerpt(text, 120), {to: ORCHESTRATOR, detail: text});
		this.pump();
	}

	/**
	 * Message one employee directly. It goes into their next task's brief (a turn that is already running can't
	 * be interrupted), and the orchestrator is told so it can plan around it.
	 */
	tellEmployee(employeeId: string, text: string): void {
		if (isFinished(this.state.status)) return;
		const employee = this.options.employees.find(e => e.id === employeeId);
		if (!employee) return this.tell(text);
		this.log(employeeId).push({kind: 'user', text, at: Date.now()});
		this.messages.set(employeeId, [...(this.messages.get(employeeId) ?? []), text]);
		this.emit('user', 'user', excerpt(text, 120), {to: employeeId, detail: text});
		this.updates.push({kind: 'user', text: `The user sent ${employee.name} this message directly. It is added to ${employee.name}'s next task, so plan around it if it changes anything:\n${text}`});
		this.pump();
	}

	/** Messages waiting for an employee's next task. */
	hasPendingMessage(employeeId: string): boolean {
		return (this.messages.get(employeeId)?.length ?? 0) > 0;
	}

	/**
	 * Keep up with hires and firings made while the run is going. Someone with unfinished work stays on the
	 * team until that work is done, so no task is left without an employee.
	 */
	syncTeam(next: Employee[]): void {
		if (isFinished(this.state.status)) return;
		const prev = this.options.employees;
		const busy = (id: string) => this.state.tasks.some(t => t.assignee === id && ['blocked', 'ready', 'running'].includes(t.status));
		const kept = prev.filter(p => !next.some(n => n.id === p.id) && busy(p.id));
		const added = next.filter(n => !prev.some(p => p.id === n.id));
		const removed = prev.filter(p => !next.some(n => n.id === p.id) && !busy(p.id));
		this.options.employees = [...next, ...kept];
		if (added.length + removed.length === 0) return;
		for (const e of added) this.emit('hire', 'user', `hired ${e.name} (${e.role})`, {to: e.id});
		for (const e of removed) this.emit('fire', 'user', `let ${e.name} go`, {to: e.id});
		const lines = [...added.map(e => `${e.name} joined: ${e.role}. ${e.summary}`), ...removed.map(e => `${e.name} left the team.`)];
		this.updates.push({kind: 'user', text: `The team changed:\n${lines.join('\n')}`});
		this.pump();
	}

	/** Uncommitted changes in an employee's worktree right now, or undefined when they have none to show. */
	liveDiff(employeeId: string): Promise<string | undefined> {
		return this.iso?.liveDiff(employeeId) ?? Promise.resolve(undefined);
	}

	cancel(): void {
		this.end('cancelled', 'Stopped by you.');
	}

	/** Let running tasks finish, but start nothing new until resumed. */
	pause(reason: 'you' | 'budget' = 'you'): void {
		if (isFinished(this.state.status) || this.state.paused) return;
		this.state.paused = {reason, at: Date.now()};
		this.emit('pause', reason === 'budget' ? ORCHESTRATOR : 'user', reason === 'budget' ? `paused at $${this.state.costUsd.toFixed(2)}: run budget reached` : 'paused the run');
		this.log(ORCHESTRATOR).push({
			kind: 'note',
			text: reason === 'budget' ? `Paused: this run has cost $${this.state.costUsd.toFixed(2)}, reaching its budget.` : 'Paused by you.',
		});
		this.changed();
	}

	resume(): void {
		if (!this.state.paused) return;
		if (this.state.paused.reason === 'budget') this.budgetLimit = this.state.costUsd + (this.options.runBudget ?? 0);
		this.state.paused = undefined;
		this.emit('resume', 'user', 'resumed the run');
		this.log(ORCHESTRATOR).push({kind: 'note', text: 'Resumed.'});
		this.pump();
	}

	/** Add a turn's usage to the run (and to its task). Pauses the run when the budget is reached. */
	private spend(usage: {costUsd?: number; inputTokens?: number; outputTokens?: number}, task?: Task): void {
		const tokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
		this.state.costUsd += usage.costUsd ?? 0;
		this.state.tokens += tokens;
		if (task) {
			task.costUsd = (task.costUsd ?? 0) + (usage.costUsd ?? 0);
			task.tokens = (task.tokens ?? 0) + tokens;
		}

		if (this.state.costUsd >= this.budgetLimit) this.pause('budget');
	}

	get working(): boolean {
		return this.turns.size > 0;
	}

	isBusy(employeeId: string): boolean {
		return this.state.tasks.some(t => t.assignee === employeeId && t.status === 'running');
	}

	log(agent: string): ChatEntry[] {
		return (this.logs[agent] ??= []);
	}

	private changed(): void {
		this.version++;
		for (const listener of this.listeners) listener();
		this.scheduleSave();
	}

	// ── orchestrator ────────────────────────────────────────────────────────

	private async orchestratorTurn(prompt: string): Promise<void> {
		const {state, options} = this;
		const binary = options.binaryFor(state.orchestrator.provider);
		if (!binary) return this.end('failed', `The orchestrator runs on ${PROVIDERS[state.orchestrator.provider].label}, which isn't installed.`);
		if (state.orchestrator.turns >= LIMITS.orchestratorTurns) {
			return this.end('failed', `Stopped after ${LIMITS.orchestratorTurns} orchestrator turns without finishing.`);
		}

		state.orchestrator.working = true;
		state.orchestrator.turns++;
		const log = this.log(ORCHESTRATOR);
		log.push({kind: 'brief', taskId: '', title: state.orchestrator.turns === 1 ? 'Plan the work' : 'Updates', text: prompt});
		const recorder = new TurnRecorder(log, () => this.changed());
		const turn = runTurn(
			binary,
			state.orchestrator.provider,
			{
				prompt,
				cwd: options.cwd,
				systemPrompt: orchestratorSystemPrompt(options.employees, options.cwd, options.branch),
				sessionId: state.orchestrator.sessionId,
				model: options.orchestratorModel,
				permissions: 'read-only',
				jsonSchema: DECISION_SCHEMA,
			},
			event => recorder.apply(event),
		);
		this.turns.set(ORCHESTRATOR, turn);
		this.changed();

		const outcome = await turn.done;
		this.turns.delete(ORCHESTRATOR);
		state.orchestrator.working = false;
		if (recorder.sessionId) state.orchestrator.sessionId = recorder.sessionId;
		this.spend(recorder.usage);
		recorder.finish(outcome);
		if (isFinished(state.status)) return;
		if (!outcome.ok) return this.end('failed', `The orchestrator stopped: ${outcome.error ?? 'unknown error'}`);

		const decision = parseDecision(recorder.structured, recorder.finalText);
		if (decision) this.apply(decision);
		else this.idle('Your reply was not a valid JSON decision. Reply only with the JSON object.');
		this.pump();
	}

	private apply(decision: Decision): void {
		const {state} = this;
		const log = this.log(ORCHESTRATOR);
		if (decision.note) {
			state.orchestrator.note = decision.note;
			log.push({kind: 'text', text: decision.note});
		}

		const name = (id: string) => this.options.employees.find(e => e.id === id)?.name ?? id;
		const {accepted, errors} = validateNewTasks(decision.tasks, state.tasks, this.options.employees);
		const planned = state.tasks.length === 0;
		state.tasks.push(...accepted);
		for (const task of accepted) log.push({kind: 'note', text: `New task ${task.id} → ${name(task.assignee)}: ${task.title}`});
		if (accepted.length) {
			const lines = accepted.map(t => `${t.id} → ${name(t.assignee)}: ${t.title}${t.dependsOn.length ? ` (after ${t.dependsOn.join(', ')})` : ''}`);
			const count = `${accepted.length} task${accepted.length === 1 ? '' : 's'}`;
			if (planned) this.emit('plan', ORCHESTRATOR, `planned ${count}`, {detail: [decision.note, ...lines].filter(Boolean).join('\n')});
			else this.emit('replan', ORCHESTRATOR, decision.note ? `re-planned: ${excerpt(decision.note, 140)}` : `added ${count}`, {detail: lines.join('\n')});
		} else if (decision.note && !decision.finish) this.emit('decision', ORCHESTRATOR, excerpt(decision.note, 160), {detail: decision.note});

		let revised = 0;
		for (const {task: id, feedback} of decision.revisions) {
			const task = state.tasks.find(t => t.id === id);
			if (!task) errors.push(`Can't revise "${id}": no such task.`);
			else if (task.status !== 'done' && task.status !== 'failed') errors.push(`Can't revise "${id}" while it is ${task.status}.`);
			else if (task.revisions >= LIMITS.revisionsPerTask) errors.push(`"${id}" has already been revised ${LIMITS.revisionsPerTask} times; try a different approach.`);
			else {
				task.revisions++;
				task.feedback = feedback;
				task.status = 'ready';
				task.error = undefined;
				revised++;
				log.push({kind: 'note', text: `Sent ${id} back to ${name(task.assignee)} for changes`});
				this.emit('revision', ORCHESTRATOR, `sent ${id} back for changes (${task.revisions}/${LIMITS.revisionsPerTask})`, {to: task.assignee, taskId: id, detail: feedback});
			}
		}

		let cancelled = 0;
		for (const id of decision.cancel) {
			const task = state.tasks.find(t => t.id === id);
			if (!task) continue;
			if (task.status === 'running') this.turns.get(id)?.cancel();
			if (task.status === 'blocked' || task.status === 'ready' || task.status === 'running') {
				task.status = 'cancelled';
				cancelled++;
				log.push({kind: 'note', text: `Cancelled ${id}`});
				this.emit('cancel', ORCHESTRATOR, `cancelled ${id}`, {to: task.assignee, taskId: id});
			}
		}

		this.errors.push(...errors);
		if (decision.finish) return this.end('done', decision.finish);

		if (state.status === 'planning') state.status = this.options.autoRun ? 'running' : 'awaiting-approval';
		const changedSomething = accepted.length + revised + cancelled > 0;
		if (changedSomething) {
			this.idleDecisions = 0;
			return;
		}

		if (errors.length) this.idle();
		// Nothing new, nothing left to wait for, and no reports it hasn't seen yet: the orchestrator is done.
		else if (!this.hasLiveWork() && this.updates.length === 0) this.end('done', decision.note || 'The orchestrator stopped without a summary.');
	}

	/** A decision that changed nothing. Problems get reported back, up to a limit. */
	private idle(error?: string): void {
		if (error) this.errors.push(error);
		if (++this.idleDecisions > LIMITS.idleDecisions) {
			this.end('failed', `The orchestrator kept replying without making progress: ${this.errors.at(-1) ?? 'no changes'}`);
		}
	}

	private hasLiveWork(): boolean {
		const settled = (id: string) => ['failed', 'cancelled'].includes(this.state.tasks.find(t => t.id === id)?.status ?? 'cancelled');
		return this.state.tasks.some(t => t.status === 'running' || t.status === 'ready' || (t.status === 'blocked' && !t.dependsOn.some(settled)));
	}

	// ── scheduling ──────────────────────────────────────────────────────────

	/** Promote, start and wake whatever can move now. Safe to call any time. */
	private pump(): void {
		const {state, options} = this;
		if (isFinished(state.status)) return;

		for (const task of state.tasks) {
			if (task.status === 'blocked' && task.dependsOn.every(id => state.tasks.find(t => t.id === id)?.status === 'done')) task.status = 'ready';
		}

		if (state.status === 'running' && !state.paused) {
			const limit = Math.min(options.concurrency ?? (this.iso ? Number.POSITIVE_INFINITY : 1), options.maxParallel ?? Number.POSITIVE_INFINITY);
			for (const task of state.tasks) {
				if (state.tasks.filter(t => t.status === 'running').length >= limit) break;
				// An employee is one worker: one task at a time.
				if (task.status === 'ready' && !this.isBusy(task.assignee)) void this.runTask(task);
			}
		}

		if (!state.orchestrator.working && !state.paused && (this.updates.length > 0 || this.errors.length > 0)) {
			const updates = this.updates;
			const errors = this.errors;
			this.updates = [];
			this.errors = [];
			// Marked busy now so no second wake starts while the git snapshot is taken.
			state.orchestrator.working = true;
			void workingTreeChanges(options.cwd).then(changes => this.orchestratorTurn(updatePrompt(updates, state, options.employees, errors, changes)));
		}

		this.changed();
	}

	private async runTask(task: Task): Promise<void> {
		const {state, options} = this;
		const employee = options.employees.find(e => e.id === task.assignee)!;
		task.status = 'running';
		task.startedAt = Date.now();
		task.endedAt = undefined;

		// First attempt only: a revision isn't a new handoff.
		if (task.revisions === 0) {
			for (const depId of task.dependsOn) {
				const dep = state.tasks.find(t => t.id === depId);
				if (dep?.status === 'done' && dep.assignee !== task.assignee) {
					this.emit('handoff', dep.assignee, dep.title, {to: task.assignee, taskId: task.id, detail: excerpt(dep.report, 500)});
				}
			}
		}

		this.emit('start', employee.id, task.revisions ? `${task.title} (revision ${task.revisions})` : task.title, {taskId: task.id, detail: task.feedback});

		const binary = options.binaryFor(employee.provider);
		const log = this.log(employee.id);
		log.push({kind: 'brief', taskId: task.id, title: task.title, text: task.feedback ? `${task.brief}\n\nRequested changes:\n${task.feedback}` : task.brief});
		const conflicts = task.conflicts;
		task.conflicts = undefined;
		let space: {cwd: string; start?: string} = {cwd: options.cwd};
		if (binary && this.iso) {
			try {
				space = await this.iso.prepare(employee.id);
			} catch (error) {
				task.status = 'failed';
				task.error = `Couldn't set up ${employee.name}'s worktree: ${(error as Error).message}`;
				log.push({kind: 'error', message: task.error});
				this.updates.push({kind: 'task', task: {...task}});
				this.pump();
				return;
			}

			// The run ended, or the orchestrator cancelled this task, while the worktree was being prepared.
			if (isFinished(state.status) || (task.status as TaskStatus) === 'cancelled') return;
		}

		if (!binary) {
			task.status = 'failed';
			task.error = `${employee.name} runs on ${PROVIDERS[employee.provider].label}, which isn't installed.`;
			log.push({kind: 'error', message: task.error});
			this.updates.push({kind: 'task', task: {...task}});
			queueMicrotask(() => this.pump());
			return;
		}

		const direct = this.messages.get(employee.id);
		this.messages.delete(employee.id);
		const fromUser = direct?.length ? `\n\nMessages from the user, sent to you directly:\n${direct.map(m => `- ${m}`).join('\n')}` : '';
		const recorder = new TurnRecorder(log, () => this.changed());
		const turn = runTurn(
			binary,
			employee.provider,
			{
				prompt: taskPrompt(task, state.tasks, options.employees, space.cwd, options.branch, {isolated: this.iso !== undefined, conflicts}) + fromUser,
				cwd: space.cwd,
				systemPrompt: employeeSystemPrompt(employee),
				sessionId: state.employeeSessions[employee.id],
				model: employee.model,
				permissions: employee.permissions,
				approvalArgs: options.approvalArgs?.(employee),
			},
			event => recorder.apply(event),
		);
		this.turns.set(task.id, turn);
		this.changed();

		let timedOut = false;
		const limit = options.taskTimeoutMinutes;
		const timer = limit
			? setTimeout(() => {
					timedOut = true;
					turn.cancel();
				}, limit * 60_000)
			: undefined;

		const outcome = await turn.done;
		clearTimeout(timer);
		this.turns.delete(task.id);
		if (recorder.sessionId) state.employeeSessions[employee.id] = recorder.sessionId;
		this.spend(recorder.usage, task);
		recorder.finish(outcome);
		task.endedAt = Date.now();
		task.report = recorder.finalText;
		// The orchestrator may have cancelled this task while it ran.
		if (isFinished(state.status) || (task.status as TaskStatus) === 'cancelled') {
			task.status = 'cancelled';
			this.changed();
			return;
		}

		// The task stays 'running' until its changes are merged, so nothing treats it as settled too early.
		let status: TaskStatus = outcome.ok ? 'done' : 'failed';
		let error = outcome.ok ? undefined : timedOut ? `Stopped after ${limit} minutes (the task time limit).` : (outcome.error ?? 'failed');

		// Partial work from a failed task is merged too, as it would be in a shared working tree.
		if (this.iso && space.start) {
			try {
				const merge = await this.iso.finish(employee.id, task.id, space.start);
				task.files = merge.files;
				task.patch = merge.patch;
				if (merge.conflicts) {
					status = 'failed';
					task.conflicts = merge.conflicts;
					error = `Its changes clash with work already merged from other tasks (${merge.conflicts.join(', ')}), so they were not applied.`;
					log.push({kind: 'error', message: error});
					this.emit('conflict', employee.id, `${task.id} clashes with merged work`, {taskId: task.id, detail: merge.conflicts.join('\n')});
				} else if (merge.files.length) {
					log.push({kind: 'note', text: `Merged into your working tree: ${merge.files.join(', ')}`});
					this.emit('merge', employee.id, `merged ⎇ ${task.id} → ${options.branch ?? 'working tree'}`, {
						taskId: task.id,
						detail: `${merge.files.length} file${merge.files.length === 1 ? '' : 's'} · no conflicts\n${merge.files.join('\n')}`,
					});
				}

				if (merge.unapplied?.length) {
					state.unapplied = [...new Set([...state.unapplied, ...merge.unapplied])];
					log.push({kind: 'note', text: `Not written to your working tree because you changed them during the run: ${merge.unapplied.join(', ')}`});
				}
			} catch (mergeError) {
				status = 'failed';
				error = `Couldn't merge the task's changes: ${(mergeError as Error).message}`;
				log.push({kind: 'error', message: error});
			}
		}

		if (isFinished(state.status) || (task.status as TaskStatus) === 'cancelled') {
			task.status = 'cancelled';
			this.changed();
			return;
		}

		task.status = status;
		task.error = error;
		if (status === 'done') task.feedback = undefined;
		this.emit(status === 'done' ? 'done' : 'failed', employee.id, task.title, {taskId: task.id, detail: status === 'done' ? excerpt(task.report, 600) : (error ?? excerpt(task.report, 400))});
		this.updates.push({kind: 'task', task: {...task}});
		this.pump();
	}

	private end(status: RunStatus, summary: string): void {
		const {state} = this;
		if (isFinished(state.status)) return;
		state.status = status;
		state.summary = summary;
		this.emit('finish', ORCHESTRATOR, status === 'done' ? 'finished the run' : status === 'cancelled' ? 'run stopped' : 'run failed', {detail: summary});
		if (state.unapplied.length && state.isolation?.mode === 'worktrees') {
			const files = state.unapplied.join(' ');
			state.summary += `\n\nThese files changed in your working tree during the run, so the team's versions were not written over them: ${files}. To take the team's versions: git checkout ${state.isolation.ref} -- ${files}`;
		}

		state.endedAt = Date.now();
		state.orchestrator.working = false;
		for (const turn of this.turns.values()) turn.cancel();
		for (const task of state.tasks) if (task.status === 'blocked' || task.status === 'ready' || task.status === 'running') task.status = 'cancelled';
		this.changed();
		void (this.iso?.cleanup() ?? Promise.resolve())
			.catch(() => {})
			.then(() => this.flush())
			.then(() => this.resolveDone());
	}

	// ── persistence ─────────────────────────────────────────────────────────

	private scheduleSave(): void {
		if (this.saveTimer) return;
		this.saveTimer = setTimeout(() => {
			this.saveTimer = undefined;
			void this.flush();
		}, 500);
	}

	/** Write run.json now (after any write already in progress). */
	flush(): Promise<void> {
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			this.saveTimer = undefined;
		}

		const file: RunFile = {state: this.state, logs: this.logs};
		const json = JSON.parse(JSON.stringify(file)) as RunFile;
		this.saving = this.saving.then(() => writeJson(path.join(this.dir, 'run.json'), json)).catch(() => {});
		return this.saving;
	}
}

export interface RunSummary {
	id: string;
	request: string;
	status: RunStatus;
	/** The run was still going when polyagent last exited. */
	interrupted: boolean;
	createdAt: number;
	endedAt?: number;
	summary?: string;
	tasks: number;
	costUsd: number;
}

export async function listRuns(workspaceDir: string, limit = 10): Promise<RunSummary[]> {
	let ids: string[];
	try {
		ids = await fs.readdir(runsDir(workspaceDir));
	} catch {
		return [];
	}

	const runs: RunSummary[] = [];
	for (const id of ids.sort().reverse().slice(0, limit)) {
		const file = (await readJson(path.join(runsDir(workspaceDir), id, 'run.json')).catch(() => undefined)) as RunFile | undefined;
		if (!file?.state) continue;
		const {state} = file;
		runs.push({
			id: state.id,
			request: state.request,
			status: state.status,
			interrupted: !isFinished(state.status),
			createdAt: state.createdAt,
			endedAt: state.endedAt,
			summary: state.summary,
			tasks: state.tasks.length,
			costUsd: state.costUsd,
		});
	}

	return runs;
}

export async function loadRun(workspaceDir: string, id: string): Promise<RunFile | undefined> {
	return (await readJson(path.join(runsDir(workspaceDir), id, 'run.json')).catch(() => undefined)) as RunFile | undefined;
}
