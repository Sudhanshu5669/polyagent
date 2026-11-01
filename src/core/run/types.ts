import type {ProviderId} from '../providers.js';
import type {ChatEntry} from '../transcript.js';

/** blocked = waiting for tasks it depends on. */
export type TaskStatus = 'blocked' | 'ready' | 'running' | 'done' | 'failed' | 'cancelled';

export interface Task {
	id: string;
	title: string;
	/** Employee id. */
	assignee: string;
	brief: string;
	dependsOn: string[];
	status: TaskStatus;
	/** Revisions requested so far. */
	revisions: number;
	/** Feedback for the next attempt, when the orchestrator asked for a revision. */
	feedback?: string;
	report?: string;
	error?: string;
	/** Files the task changed (when employees work in worktrees). */
	files?: string[];
	/** Files that clashed with work merged earlier; the task's changes were not applied. */
	conflicts?: string[];
	startedAt?: number;
	endedAt?: number;
	/** Input + output tokens spent on this task, across revisions. */
	tokens?: number;
	costUsd?: number;
	/** What the task changed, as a unified diff (when employees work in worktrees). Capped. */
	patch?: string;
}

export type RunEventKind =
	| 'plan'
	| 'replan'
	| 'decision'
	| 'start'
	| 'done'
	| 'failed'
	| 'handoff'
	| 'merge'
	| 'conflict'
	| 'revision'
	| 'cancel'
	| 'pause'
	| 'resume'
	| 'user'
	| 'hire'
	| 'fire'
	| 'finish';

/** One thing worth telling someone who wasn't watching: the story of the run, not its raw log. */
export interface RunEvent {
	id: number;
	at: number;
	kind: RunEventKind;
	/** Who did it: 'orchestrator', 'user' or an employee id. */
	agent: string;
	/** The other party: who a handoff or message goes to. */
	to?: string;
	text: string;
	/** Longer text, shown when the event is expanded. */
	detail?: string;
	taskId?: string;
}

export type RunStatus = 'planning' | 'awaiting-approval' | 'running' | 'done' | 'failed' | 'cancelled';

export interface RunState {
	id: string;
	request: string;
	status: RunStatus;
	createdAt: number;
	endedAt?: number;
	/** The orchestrator's closing summary, or why the run stopped. */
	summary?: string;
	branch?: string;
	orchestrator: {
		provider: ProviderId;
		sessionId?: string;
		working: boolean;
		/** Latest one-line status from the orchestrator. */
		note?: string;
		turns: number;
	};
	tasks: Task[];
	/** One provider session per employee per run, so later tasks keep earlier context. */
	employeeSessions: Record<string, string>;
	costUsd: number;
	/** Input + output tokens used so far, as reported by the CLIs. */
	tokens: number;
	/** The run's story so far, oldest first. */
	events: RunEvent[];
	/** How employees share the repository: their own worktrees in parallel, or the working tree one at a time. */
	isolation?: {mode: 'worktrees'; ref: string; base: string} | {mode: 'shared'; reason: string};
	/** Merged files that couldn't be written to the user's working tree because they changed there during the run. */
	unapplied: string[];
	/** While paused, running tasks finish but nothing new starts and the orchestrator waits. */
	paused?: {reason: 'you' | 'budget'; at: number};
}

export interface RunFile {
	state: RunState;
	/** Transcript per agent: 'orchestrator' or an employee id. */
	logs: Record<string, ChatEntry[]>;
}

export const ORCHESTRATOR = 'orchestrator';

export function isFinished(status: RunStatus): boolean {
	return status === 'done' || status === 'failed' || status === 'cancelled';
}
