import path from 'node:path';
import type {PermissionMode} from '../employees.js';
import {truncate, type Adapter, type AgentEvent, type ToolStatus} from './types.js';

/**
 * Claude Code in print mode: `claude -p --output-format stream-json --verbose`.
 * Verified against Claude Code 2.1.311. With no approval surface, anything that needs approval is denied, never hangs.
 */
const PERMISSION_FLAGS: Record<PermissionMode, string[]> = {
	'read-only': ['--permission-mode', 'default'],
	'auto-edit': ['--permission-mode', 'acceptEdits'],
	'full-auto': ['--permission-mode', 'bypassPermissions'],
};

const TOOL_VERBS: Record<string, string> = {
	Read: 'read',
	Write: 'write',
	Edit: 'edit',
	MultiEdit: 'edit',
	NotebookEdit: 'edit',
	Bash: 'shell',
	Grep: 'search',
	Glob: 'find',
	WebFetch: 'fetch',
	WebSearch: 'web',
	Task: 'agent',
	Agent: 'agent',
	TodoWrite: 'plan',
};

type Json = Record<string, unknown>;

export const claudeAdapter: Adapter = {
	provider: 'claude',
	verified: true,
	args(input) {
		return [
			'-p',
			input.prompt,
			'--output-format',
			'stream-json',
			'--verbose',
			...PERMISSION_FLAGS[input.permissions],
			...(input.systemPrompt ? ['--append-system-prompt', input.systemPrompt] : []),
			...(input.model ? ['--model', input.model] : []),
			...(input.sessionId ? ['--resume', input.sessionId] : []),
			...(input.jsonSchema ? ['--json-schema', JSON.stringify(input.jsonSchema)] : []),
		];
	},
	createParser(cwd) {
		const statuses = new Map<string, {name: string; summary: string; status: ToolStatus}>();

		return line => {
			const e = parseJson(line);
			if (!e) return [];
			// Events from Claude's own subagents carry a parent id; their inner steps would only add noise.
			if (e.parent_tool_use_id) return [];

			const events: AgentEvent[] = [];
			switch (e.type) {
				case 'system':
					if (e.subtype === 'init' && typeof e.session_id === 'string') events.push({type: 'session', sessionId: e.session_id});
					if (e.subtype === 'permission_denied' && typeof e.tool_use_id === 'string') {
						const tool = statuses.get(e.tool_use_id);
						if (tool) {
							tool.status = 'denied';
							events.push({type: 'tool', id: e.tool_use_id, ...tool, output: 'Needs approval, so it was blocked.'});
						}
					}

					break;
				case 'assistant':
					for (const block of content(e)) {
						if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) events.push({type: 'text', text: block.text});
						else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
							events.push({type: 'thinking', text: block.thinking});
						} else if (block.type === 'tool_use' && block.name === 'StructuredOutput') {
							// The --json-schema answer; it arrives again on the result event.
						} else if (block.type === 'tool_use' && typeof block.id === 'string') {
							const name = String(block.name ?? 'tool');
							const tool = {name: TOOL_VERBS[name] ?? name.replace(/^mcp__/, '').replace(/__/g, '.'), summary: summarize(name, (block.input ?? {}) as Json, cwd), status: 'running' as ToolStatus};
							statuses.set(block.id, tool);
							events.push({type: 'tool', id: block.id, ...tool});
						}
					}

					break;
				case 'user':
					for (const block of content(e)) {
						if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
						const tool = statuses.get(block.tool_use_id);
						if (!tool || tool.status === 'denied') continue;
						tool.status = block.is_error ? 'failed' : 'done';
						events.push({type: 'tool', id: block.tool_use_id, ...tool, output: truncate(resultText(block.content))});
					}

					break;
				case 'result': {
					const usage = (e.usage ?? {}) as Json;
					events.push({
						type: 'usage',
						costUsd: num(e.total_cost_usd),
						inputTokens: sum(usage.input_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens),
						outputTokens: num(usage.output_tokens),
					});
					const ok = e.subtype === 'success' && !e.is_error;
					if (!ok) events.push({type: 'error', message: typeof e.result === 'string' && e.result ? e.result : `Claude stopped: ${String(e.subtype)}`});
					events.push({type: 'result', ok, text: typeof e.result === 'string' ? e.result : undefined, ...(e.structured_output !== undefined ? {structured: e.structured_output} : {})});
					break;
				}
			}

			return events;
		};
	},
};

function parseJson(line: string): Json | undefined {
	try {
		const value: unknown = JSON.parse(line);
		return value && typeof value === 'object' ? (value as Json) : undefined;
	} catch {
		return undefined;
	}
}

function content(e: Json): Json[] {
	const message = e.message as Json | undefined;
	return Array.isArray(message?.content) ? (message.content as Json[]) : [];
}

function resultText(value: unknown): string {
	if (typeof value === 'string') return value;
	if (Array.isArray(value)) return value.map(v => (typeof v === 'object' && v && 'text' in v ? String(v.text) : '')).join('\n');
	return '';
}

function summarize(name: string, input: Json, cwd: string): string {
	const rel = (p: unknown) => (typeof p === 'string' ? (path.isAbsolute(p) && p.startsWith(cwd) ? path.relative(cwd, p) || '.' : p) : '');
	switch (name) {
		case 'Read':
		case 'Write':
		case 'Edit':
		case 'MultiEdit':
			return rel(input.file_path);
		case 'NotebookEdit':
			return rel(input.notebook_path);
		case 'Bash':
			return String(input.command ?? '');
		case 'Grep':
			return input.path ? `${String(input.pattern)} in ${rel(input.path)}` : String(input.pattern ?? '');
		case 'Glob':
			return String(input.pattern ?? '');
		case 'WebFetch':
			return String(input.url ?? '');
		case 'WebSearch':
			return String(input.query ?? '');
		case 'Task':
		case 'Agent':
			return String(input.description ?? '');
		case 'TodoWrite':
			return 'update to-do list';
		default: {
			const first = Object.values(input).find(v => typeof v === 'string');
			return typeof first === 'string' ? first : '';
		}
	}
}

function num(value: unknown): number | undefined {
	return typeof value === 'number' ? value : undefined;
}

function sum(...values: unknown[]): number | undefined {
	const nums = values.filter((v): v is number => typeof v === 'number');
	return nums.length ? nums.reduce((a, b) => a + b, 0) : undefined;
}
