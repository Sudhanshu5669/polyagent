import type {PermissionMode} from '../employees.js';
import type {ProviderId} from '../providers.js';

export type ToolStatus = 'running' | 'done' | 'failed' | 'denied';

/** One provider-independent event. Every adapter turns its CLI's output into these. */
export type AgentEvent =
	| {type: 'session'; sessionId: string}
	/** delta = a streamed fragment to append to the previous text, rather than a new block. */
	| {type: 'text'; text: string; delta?: boolean}
	| {type: 'thinking'; text: string}
	/** Emitted when a tool starts, and again with the same id when it finishes. */
	| {type: 'tool'; id: string; name: string; summary: string; status: ToolStatus; output?: string}
	| {type: 'usage'; costUsd?: number; inputTokens?: number; outputTokens?: number}
	| {type: 'error'; message: string}
	/** The CLI's own end-of-turn marker. The runner still decides success from the exit code. */
	| {type: 'result'; ok: boolean; text?: string};

export interface TurnInput {
	prompt: string;
	cwd: string;
	systemPrompt?: string;
	/** Continue this provider session instead of starting a new one. */
	sessionId?: string;
	model?: string;
	permissions: PermissionMode;
}

export interface Adapter {
	provider: ProviderId;
	/** False when we can't confirm the CLI's output format against a real install yet. */
	verified: boolean;
	args(input: TurnInput): string[];
	/** A fresh, stateful line parser for one turn. */
	createParser(cwd: string): (line: string) => AgentEvent[];
}

/** For CLIs with no system-prompt flag: put the instructions in front of the first message of a session. */
export function inlineSystemPrompt(input: TurnInput): string {
	if (!input.systemPrompt || input.sessionId) return input.prompt;
	return `<instructions>\n${input.systemPrompt}\n</instructions>\n\n${input.prompt}`;
}

export function truncate(text: string, max = 2000): string {
	return text.length > max ? `${text.slice(0, max)}… (${text.length - max} more characters)` : text;
}
