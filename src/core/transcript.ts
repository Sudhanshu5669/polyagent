import type {TurnOutcome} from './agents/runner.js';
import type {AgentEvent, ToolStatus} from './agents/types.js';

/** One line of an agent's visible history, shared by direct chats and runs. */
export type ChatEntry =
	| {kind: 'user'; text: string; at: number}
	/** Work handed to an employee by the orchestrator. */
	| {kind: 'brief'; taskId: string; title: string; text: string}
	| {kind: 'text'; text: string}
	| {kind: 'thinking'; text: string}
	| {kind: 'tool'; id: string; name: string; summary: string; status: ToolStatus; output?: string}
	| {kind: 'error'; message: string}
	| {kind: 'note'; text: string}
	| {kind: 'turn'; ok: boolean; cancelled: boolean; durationMs: number; costUsd?: number; inputTokens?: number; outputTokens?: number};

type Usage = Pick<Extract<ChatEntry, {kind: 'turn'}>, 'costUsd' | 'inputTokens' | 'outputTokens'>;

/**
 * Records one turn's events into a transcript and keeps what callers need afterwards:
 * the session id, the final answer and any structured output.
 */
export class TurnRecorder {
	readonly startedAt = Date.now();
	/** Tool ids are only unique within a turn (Codex numbers items item_1, item_2… every turn). */
	private readonly start: number;
	usage: Usage = {};
	sessionId?: string;
	/** The CLI's final answer, or the last text block if it gave none. */
	finalText?: string;
	structured?: unknown;

	constructor(
		private readonly entries: ChatEntry[],
		private readonly changed: () => void,
	) {
		this.start = entries.length;
	}

	apply(event: AgentEvent): void {
		switch (event.type) {
			case 'session':
				this.sessionId = event.sessionId;
				return;
			case 'text': {
				const last = this.entries.at(-1);
				if (event.delta && last?.kind === 'text' && this.entries.length > this.start) last.text += event.text;
				else this.entries.push({kind: 'text', text: event.text});
				this.finalText = (this.entries.at(-1) as {text: string}).text;
				break;
			}

			case 'thinking':
				this.entries.push({kind: 'thinking', text: event.text});
				break;
			case 'tool': {
				const existing = this.entries.slice(this.start).find(e => e.kind === 'tool' && e.id === event.id);
				const {type: _, ...tool} = event;
				if (existing) Object.assign(existing, tool);
				else this.entries.push({kind: 'tool', ...tool});
				break;
			}

			case 'usage':
				this.usage = {costUsd: event.costUsd, inputTokens: event.inputTokens, outputTokens: event.outputTokens};
				return;
			case 'error':
				// Reported once at the end of the turn, with the exit status.
				return;
			case 'result':
				if (event.text) this.finalText = event.text;
				if (event.structured !== undefined) this.structured = event.structured;
				return;
		}

		this.changed();
	}

	/** Close out the turn: settle tools still marked running, then add the error (if any) and the turn summary. */
	finish(outcome: TurnOutcome): Extract<ChatEntry, {kind: 'turn'}> {
		for (const entry of this.entries.slice(this.start)) {
			if (entry.kind === 'tool' && entry.status === 'running') entry.status = outcome.ok ? 'done' : 'failed';
		}

		if (outcome.error && !outcome.cancelled) this.entries.push({kind: 'error', message: outcome.error});
		const turn = {kind: 'turn' as const, ok: outcome.ok, cancelled: outcome.cancelled, durationMs: Date.now() - this.startedAt, ...this.usage};
		this.entries.push(turn);
		this.changed();
		return turn;
	}
}
