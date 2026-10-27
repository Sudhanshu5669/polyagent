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
	/** How employees share the repository: their own worktrees in parallel, or the working tree one at a time. */
	isolation?: {mode: 'worktrees'; ref: string; base: string} | {mode: 'shared'; reason: string};
	/** Merged files that couldn't be written to the user's working tree because they changed there during the run. */
	unapplied: string[];
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
