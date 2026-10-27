import type {PermissionMode} from '../employees.js';
import {inlineSystemPrompt, truncate, type Adapter, type AgentEvent} from './types.js';

/**
 * Antigravity CLI: `agy -p <prompt> --output-format stream-json`.
 * Its stream-json schema isn't publicly documented (known event names: init, step_update, result with status),
 * so this parser is deliberately tolerant: it looks for ids, text and tool info under several likely field names,
 * and falls back to showing non-JSON lines as plain text. Resume uses --conversation <id>, also unverified in print mode.
 */
const PERMISSION_FLAGS: Record<PermissionMode, string[]> = {
	// Headless agy denies anything that needs approval, which is what read-only wants.
	'read-only': [],
	'auto-edit': ['--mode', 'accept-edits'],
	'full-auto': ['--dangerously-skip-permissions'],
};

type Json = Record<string, unknown>;

export const antigravityAdapter: Adapter = {
	provider: 'antigravity',
	verified: false,
	args(input, files) {
		return [
			'-p',
			inlineSystemPrompt(input),
			'--output-format',
			'stream-json',
			...PERMISSION_FLAGS[input.permissions],
			...(input.model ? ['--model', input.model] : []),
			...(input.sessionId ? ['--conversation', input.sessionId] : []),
			...(files?.schemaFile ? ['--json-schema', files.schemaFile] : []),
		];
	},
	createParser() {
		let sessionSent = false;
		let toolCounter = 0;

		return line => {
			const trimmed = line.trim();
			if (!trimmed) return [];
			let e: Json;
			try {
				e = JSON.parse(trimmed) as Json;
			} catch {
				return [{type: 'text', text: trimmed}];
			}

			const events: AgentEvent[] = [];
			const sessionId = pick(e, 'conversation_id', 'conversationId', 'session_id', 'sessionId');
			if (!sessionSent && typeof sessionId === 'string') {
				sessionSent = true;
				events.push({type: 'session', sessionId});
			}

			const type = String(e.type ?? e.event ?? '');
			const status = String(e.status ?? '').toUpperCase();

			if (type === 'result' || status === 'SUCCESS' || status === 'ERROR') {
				const ok = status !== 'ERROR' && !e.error;
				const text = pick(e, 'response', 'result', 'text');
				if (!ok) events.push({type: 'error', message: String(pick(e, 'error', 'message') ?? 'Antigravity reported an error')});
				const usage = (e.usage ?? {}) as Json;
				events.push({type: 'usage', inputTokens: num(pick(usage, 'input_tokens', 'inputTokens')), outputTokens: num(pick(usage, 'output_tokens', 'outputTokens'))});
				const structured = pick(e, 'structured_output', 'structuredOutput');
				events.push({type: 'result', ok, text: typeof text === 'string' ? text : undefined, ...(structured !== undefined ? {structured} : {})});
				return events;
			}

			const tool = (e.toolinfo ?? e.tool ?? e.tool_call) as Json | undefined;
			if (tool && typeof tool === 'object') {
				const id = String(pick(tool, 'id', 'call_id', 'callId') ?? `agy-tool-${++toolCounter}`);
				const state = String(pick(tool, 'status', 'state') ?? '').toLowerCase();
				events.push({
					type: 'tool',
					id,
					name: String(pick(tool, 'name', 'tool_name', 'toolName') ?? 'tool'),
					summary: String(pick(tool, 'summary', 'toolSummary', 'description', 'path', 'command') ?? ''),
					status: /fail|error/.test(state) ? 'failed' : /done|complete|finish|success/.test(state) ? 'done' : 'running',
					output: typeof tool.output === 'string' ? truncate(tool.output) : undefined,
				});
				return events;
			}

			if (typeof e.delta === 'string') {
				events.push({type: 'text', text: e.delta, delta: true});
				return events;
			}

			const text = pick(e, 'text', 'content', 'response');
			if (typeof text === 'string' && text.trim()) events.push({type: 'text', text});
			return events;
		};
	},
};

function pick(obj: Json, ...keys: string[]): unknown {
	for (const key of keys) if (obj[key] !== undefined && obj[key] !== null) return obj[key];
	return undefined;
}

function num(value: unknown): number | undefined {
	return typeof value === 'number' ? value : undefined;
}
