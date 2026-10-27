import type {PermissionMode} from '../employees.js';
import {inlineSystemPrompt, truncate, type Adapter, type AgentEvent} from './types.js';

/**
 * Codex: `codex exec --json`, JSONL events per the official non-interactive docs
 * (thread.started, turn.*, item.started/updated/completed, error). Not yet run against a real install here.
 */
const SANDBOX: Record<PermissionMode, string> = {
	'read-only': 'read-only',
	'auto-edit': 'workspace-write',
	'full-auto': 'danger-full-access',
};

type Json = Record<string, unknown>;

export const codexAdapter: Adapter = {
	provider: 'codex',
	verified: false,
	args(input) {
		// exec's own options must come before the `resume` subcommand.
		const options = ['--json', '--skip-git-repo-check', '--sandbox', SANDBOX[input.permissions], ...(input.model ? ['-m', input.model] : [])];
		const prompt = inlineSystemPrompt(input);
		return input.sessionId ? ['exec', ...options, 'resume', input.sessionId, prompt] : ['exec', ...options, prompt];
	},
	createParser() {
		return line => {
			let e: Json;
			try {
				e = JSON.parse(line) as Json;
			} catch {
				return [];
			}

			switch (e.type) {
				case 'thread.started':
					return typeof e.thread_id === 'string' ? [{type: 'session', sessionId: e.thread_id}] : [];
				case 'item.started':
				case 'item.updated':
				case 'item.completed':
					return itemEvents(e.item as Json | undefined, e.type === 'item.completed');
				case 'turn.completed': {
					const usage = (e.usage ?? {}) as Json;
					return [
						{type: 'usage', inputTokens: num(usage.input_tokens), outputTokens: num(usage.output_tokens)},
						{type: 'result', ok: true},
					];
				}

				case 'turn.failed':
					return [{type: 'error', message: errorMessage(e.error) ?? 'Codex turn failed'}, {type: 'result', ok: false}];
				case 'error':
					return [{type: 'error', message: errorMessage(e) ?? 'Codex reported an error'}];
				default:
					return [];
			}
		};
	},
};

function itemEvents(item: Json | undefined, completed: boolean): AgentEvent[] {
	if (!item) return [];
	const id = String(item.id ?? '');
	// Codex before 0.44 used item_type / assistant_message.
	const kind = String(item.type ?? item.item_type ?? '');

	switch (kind) {
		case 'agent_message':
		case 'assistant_message':
			return completed && typeof item.text === 'string' ? [{type: 'text', text: item.text}] : [];
		case 'reasoning':
			return completed && typeof item.text === 'string' && item.text.trim() ? [{type: 'thinking', text: item.text}] : [];
		case 'command_execution': {
			const exit = num(item.exit_code);
			const failed = item.status === 'failed' || (exit !== undefined && exit !== 0);
			return [
				{
					type: 'tool',
					id,
					name: 'shell',
					summary: String(item.command ?? ''),
					status: completed ? (failed ? 'failed' : 'done') : 'running',
					output: typeof item.aggregated_output === 'string' ? truncate(item.aggregated_output) : undefined,
				},
			];
		}

		case 'file_change': {
			const changes = Array.isArray(item.changes) ? (item.changes as Json[]) : [];
			const summary = changes.map(c => String(c.path ?? '')).join(', ');
			return [{type: 'tool', id, name: 'edit', summary, status: completed ? (item.status === 'failed' ? 'failed' : 'done') : 'running'}];
		}

		case 'mcp_tool_call':
			return [
				{
					type: 'tool',
					id,
					name: 'mcp',
					summary: [item.server, item.tool].filter(Boolean).join('.'),
					status: completed ? (item.status === 'failed' ? 'failed' : 'done') : 'running',
				},
			];
		case 'web_search':
			return [{type: 'tool', id, name: 'web', summary: String(item.query ?? ''), status: completed ? 'done' : 'running'}];
		case 'error':
			return completed ? [{type: 'error', message: String(item.message ?? 'error')}] : [];
		default:
			return [];
	}
}

function errorMessage(value: unknown): string | undefined {
	if (typeof value === 'string') return value;
	if (value && typeof value === 'object' && 'message' in value) return String(value.message);
	return undefined;
}

function num(value: unknown): number | undefined {
	return typeof value === 'number' ? value : undefined;
}
