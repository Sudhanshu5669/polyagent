import path from 'node:path';
import type {PermissionMode} from '../employees.js';
import {inlineSystemPrompt, truncate, type Adapter, type AgentEvent, type ToolStatus} from './types.js';

/**
 * Antigravity CLI: `agy -p <prompt> --output-format stream-json`.
 * Verified against agy 1.4.9. Every line is {event, [event]: payload}: `init`, then `step_update`s, then `result`.
 * Headless agy can't ask for approval: a tool that needs it is denied and the turn ends there, still exiting 0,
 * with the denials listed in result.denied_actions.
 */
const PERMISSION_FLAGS: Record<PermissionMode, string[]> = {
	// The default mode denies file writes and shell commands in print mode, which is what read-only wants.
	'read-only': [],
	'auto-edit': ['--mode', 'accept-edits'],
	'full-auto': ['--dangerously-skip-permissions'],
};

const TOOL_VERBS: Record<string, string> = {
	read_file: 'read',
	view_file: 'read',
	write_file: 'write',
	edit_file: 'edit',
	replace_file_content: 'edit',
	multi_replace_file_content: 'edit',
	run_command: 'shell',
	grep_search: 'search',
	find_by_name: 'find',
	list_dir: 'list',
	read_url_content: 'fetch',
	search_web: 'web',
	invoke_subagent: 'agent',
	browser_subagent: 'agent',
};

/** denied_actions name the permission, not the tool. */
const DENIED_TOOLS: Record<string, string[]> = {
	command: ['run_command'],
	write_file: ['write_file', 'edit_file', 'replace_file_content', 'multi_replace_file_content'],
};

type Json = Record<string, unknown>;

export const antigravityAdapter: Adapter = {
	provider: 'antigravity',
	verified: true,
	args(input, files) {
		return [
			'-p',
			inlineSystemPrompt(input),
			'--output-format',
			'stream-json',
			// Some agy versions stop print mode after five minutes; taskTimeout is polyagent's own limit.
			'--print-timeout',
			'0',
			...PERMISSION_FLAGS[input.permissions],
			...(input.model ? ['--model', input.model] : []),
			...(input.sessionId ? ['--conversation', input.sessionId] : []),
			...(files?.schemaFile ? ['--json-schema', files.schemaFile] : []),
		];
	},
	createParser(cwd) {
		let sessionSent = false;
		let textStep: number | undefined;
		const tools = new Map<string, {name: string; rawName: string; summary: string; status: ToolStatus}>();
		// result.usage is the whole conversation's total when resuming, so this turn's usage is summed from its steps.
		const usage = {inputTokens: 0, outputTokens: 0, seen: false};

		return line => {
			const e = parseJson(line.trim());
			if (!e) return line.trim() ? [{type: 'text', text: line.trim()}] : [];

			const events: AgentEvent[] = [];
			const sessionId = e.conversation_id ?? (e[String(e.event)] as Json | undefined)?.conversation_id;
			if (!sessionSent && typeof sessionId === 'string') {
				sessionSent = true;
				events.push({type: 'session', sessionId});
			}

			if (e.event === 'step_update') {
				const step = (e.step_update ?? {}) as Json;
				const stepUsage = step.usage as Json | undefined;
				if (stepUsage) {
					usage.inputTokens += num(stepUsage.input_tokens) ?? 0;
					usage.outputTokens += num(stepUsage.output_tokens) ?? 0;
					usage.seen = true;
				}

				if (step.step_type === 'agent_response' && typeof step.text_delta === 'string' && step.text_delta) {
					// Each agent_response step is its own block of text; its deltas append to it.
					events.push({type: 'text', text: step.text_delta, delta: textStep === step.step_index});
					textStep = num(step.step_index);
				}

				if (step.step_type === 'tool') {
					const info = (step.tool_info ?? {}) as Json;
					const rawName = String(step.tool_name ?? info.name ?? 'tool');
					const id = `agy-step-${String(step.step_index)}`;
					const error = info.error as Json | undefined;
					const message = typeof error?.message === 'string' ? error.message : undefined;
					const status: ToolStatus =
						step.state === 'ERROR' ? (message && /permission/i.test(message) ? 'denied' : 'failed') : step.state === 'DONE' ? 'done' : 'running';
					const tool = {name: TOOL_VERBS[rawName] ?? rawName, rawName, summary: summarize((info.parameters ?? {}) as Json, cwd), status};
					tools.set(id, tool);
					const {rawName: _, ...shown} = tool;
					const output = status === 'denied' ? 'Needs approval, so it was blocked.' : message ?? (typeof info.output === 'string' ? info.output : undefined);
					events.push({type: 'tool', id, ...shown, ...(output ? {output: truncate(output)} : {})});
					textStep = undefined;
				}

				return events;
			}

			if (e.event === 'result') {
				const result = (e.result ?? {}) as Json;
				const status = String(result.status ?? '').toUpperCase();
				const ok = status === 'SUCCESS';
				const error = result.error as Json | string | undefined;
				if (!ok) events.push({type: 'error', message: (typeof error === 'string' ? error : typeof error?.message === 'string' ? error.message : undefined) ?? `Antigravity ended the turn: ${status || 'unknown status'}`});

				const denied = Array.isArray(result.denied_actions) ? (result.denied_actions as Json[]) : [];
				for (const action of denied) {
					// A denied write can still show up as DONE in the stream, so the result is what settles it.
					const names = DENIED_TOOLS[String(action.action)] ?? [String(action.action)];
					const match = [...tools].reverse().find(([, t]) => names.includes(t.rawName) && t.status !== 'denied');
					if (!match) continue;
					const [id, tool] = match;
					tool.status = 'denied';
					const {rawName: _, ...shown} = tool;
					events.push({type: 'tool', id, ...shown, output: 'Needs approval, so it was blocked.'});
				}

				if (usage.seen) events.push({type: 'usage', inputTokens: usage.inputTokens, outputTokens: usage.outputTokens});
				let text = typeof result.response === 'string' ? result.response.trimEnd() : '';
				if (denied.length) {
					// The turn stops at the first denial, often before any reply, so the report says why.
					const what = denied.map(a => String(a.display_name ?? a.action)).join(', ');
					text = `${text ? `${text}\n\n` : ''}Antigravity stopped early: it needed approval for ${what}, which it can't ask for when run by polyagent.`;
				}

				const structured = result.structured_output;
				events.push({type: 'result', ok, ...(text ? {text} : {}), ...(structured !== undefined ? {structured} : {})});
			}

			return events;
		};
	},
};

/** The most telling parameter: a command, else a path, else a query, else any string. */
function summarize(params: Json, cwd: string): string {
	const rel = (p: string) => (path.isAbsolute(p) && p.startsWith(cwd) ? path.relative(cwd, p) || '.' : p);
	const command = params.CommandLine ?? params.Command;
	if (typeof command === 'string') return command;
	const file = params.Path ?? params.AbsolutePath ?? params.TargetFile ?? params.DirectoryPath ?? params.SearchPath;
	const query = params.Query ?? params.Pattern ?? params.Url;
	if (typeof file === 'string' && typeof query === 'string') return `${query} in ${rel(file)}`;
	if (typeof file === 'string') return rel(file);
	if (typeof query === 'string') return query;
	const first = Object.values(params).find(v => typeof v === 'string');
	return typeof first === 'string' ? first : '';
}

function parseJson(line: string): Json | undefined {
	try {
		const value: unknown = JSON.parse(line);
		return value && typeof value === 'object' ? (value as Json) : undefined;
	} catch {
		return undefined;
	}
}

function num(value: unknown): number | undefined {
	return typeof value === 'number' ? value : undefined;
}
