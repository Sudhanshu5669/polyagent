import fs from 'node:fs/promises';
import path from 'node:path';
import {runTurn, type RunningTurn} from '../agents/runner.js';
import {employeeSystemPrompt} from '../chat.js';
import {slugify, type Employee} from '../employees.js';
import {readJson, writeJson} from '../fs.js';
import {workingTreeChanges} from '../git.js';
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
import {isFinished, ORCHESTRATOR, type RunFile, type RunState, type RunStatus, type Task, type TaskStatus} from './types.js';

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
	/** Hard cap from the engine itself. Tasks share one working tree until worktree isolation lands, so this is 1 by default. */
	concurrency?: number;
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
	readonly logs: Record<string, ChatEntry[]> = {[ORCHESTRATOR]: []};
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
		};
		this.done = new Promise(resolve => (this.resolveDone = resolve));
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
		this.changed();
		void workingTreeChanges(this.options.cwd, 2000).then(dirty => this.orchestratorTurn(planPrompt(this.state.request, dirty)));
	}

	/** Start a plan that is waiting for approval (autoRun off). */
	approve(): void {
		if (this.state.status !== 'awaiting-approval') return;
		this.state.status = 'running';
		this.pump();
	}

	/** Pass a message to the orchestrator; it is delivered on its next turn. */
	tell(text: string): void {
		if (isFinished(this.state.status)) return;
		this.log(ORCHESTRATOR).push({kind: 'user', text, at: Date.now()});
		this.updates.push({kind: 'user', text});
		this.pump();
	}

	cancel(): void {
		this.end('cancelled', 'Stopped by you.');
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
		state.costUsd += recorder.usage.costUsd ?? 0;
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
		state.tasks.push(...accepted);
		for (const task of accepted) log.push({kind: 'note', text: `New task ${task.id} → ${name(task.assignee)}: ${task.title}`});

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

		if (state.status === 'running') {
			const limit = Math.min(options.concurrency ?? 1, options.maxParallel ?? Number.POSITIVE_INFINITY);
			for (const task of state.tasks) {
				if (state.tasks.filter(t => t.status === 'running').length >= limit) break;
				// An employee is one worker: one task at a time.
				if (task.status === 'ready' && !this.isBusy(task.assignee)) void this.runTask(task);
			}
		}

		if (!state.orchestrator.working && (this.updates.length > 0 || this.errors.length > 0)) {
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

		const binary = options.binaryFor(employee.provider);
		const log = this.log(employee.id);
		log.push({kind: 'brief', taskId: task.id, title: task.title, text: task.feedback ? `${task.brief}\n\nRequested changes:\n${task.feedback}` : task.brief});
		if (!binary) {
			task.status = 'failed';
			task.error = `${employee.name} runs on ${PROVIDERS[employee.provider].label}, which isn't installed.`;
			log.push({kind: 'error', message: task.error});
			this.updates.push({kind: 'task', task: {...task}});
			queueMicrotask(() => this.pump());
			return;
		}

		const recorder = new TurnRecorder(log, () => this.changed());
		const turn = runTurn(
			binary,
			employee.provider,
			{
				prompt: taskPrompt(task, state.tasks, options.employees, options.cwd, options.branch),
				cwd: options.cwd,
				systemPrompt: employeeSystemPrompt(employee),
				sessionId: state.employeeSessions[employee.id],
				model: employee.model,
				permissions: employee.permissions,
			},
			event => recorder.apply(event),
		);
		this.turns.set(task.id, turn);
		this.changed();

		const outcome = await turn.done;
		this.turns.delete(task.id);
		if (recorder.sessionId) state.employeeSessions[employee.id] = recorder.sessionId;
		state.costUsd += recorder.usage.costUsd ?? 0;
		recorder.finish(outcome);
		task.endedAt = Date.now();
		task.report = recorder.finalText;
		// The orchestrator may have cancelled this task while it ran.
		if (isFinished(state.status) || (task.status as TaskStatus) === 'cancelled') {
			task.status = 'cancelled';
			this.changed();
			return;
		}

		if (outcome.ok) {
			task.status = 'done';
			task.feedback = undefined;
		} else {
			task.status = 'failed';
			task.error = outcome.error ?? 'failed';
		}

		this.updates.push({kind: 'task', task: {...task}});
		this.pump();
	}

	private end(status: RunStatus, summary: string): void {
		const {state} = this;
		if (isFinished(state.status)) return;
		state.status = status;
		state.summary = summary;
		state.endedAt = Date.now();
		state.orchestrator.working = false;
		for (const turn of this.turns.values()) turn.cancel();
		for (const task of state.tasks) if (task.status === 'blocked' || task.status === 'ready' || task.status === 'running') task.status = 'cancelled';
		this.changed();
		void this.flush().then(() => this.resolveDone());
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
