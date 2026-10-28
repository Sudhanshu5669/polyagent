import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {antigravityAdapter} from '../src/core/agents/antigravity.js';
import {claudeAdapter} from '../src/core/agents/claude.js';
import {codexAdapter, unwrapShell} from '../src/core/agents/codex.js';
import type {Adapter, AgentEvent} from '../src/core/agents/types.js';

const fixture = (name: string) => fs.readFileSync(path.join(import.meta.dirname, 'fixtures', name), 'utf8').split('\n');

function parseAll(adapter: Adapter, lines: string[]): AgentEvent[] {
	const parse = adapter.createParser('/repo');
	return lines.flatMap(line => parse(line));
}

const input = {prompt: 'hi', cwd: '/repo', permissions: 'read-only' as const};

describe('claude adapter (fixtures recorded from Claude Code 2.1.311)', () => {
	it('builds print-mode args with system prompt, model and resume', () => {
		expect(claudeAdapter.args({...input, systemPrompt: 'be terse', model: 'haiku', sessionId: 'abc', permissions: 'auto-edit'})).toEqual([
			'-p',
			'hi',
			'--output-format',
			'stream-json',
			'--verbose',
			'--permission-mode',
			'acceptEdits',
			'--append-system-prompt',
			'be terse',
			'--model',
			'haiku',
			'--resume',
			'abc',
		]);
	});

	it('removes edit tools in read-only mode and appends approval routing', () => {
		const args = claudeAdapter.args({...input, approvalArgs: ['--permission-prompt-tool', 'mcp__polyagent__approve']});
		expect(args).toContain('--disallowedTools');
		expect(args[args.indexOf('--disallowedTools') + 1]).toBe('Edit,Write,MultiEdit,NotebookEdit');
		expect(args.slice(-2)).toEqual(['--permission-prompt-tool', 'mcp__polyagent__approve']);
	});

	it('turns a turn with a tool call into session, tool, text, usage and result events', () => {
		const events = parseAll(claudeAdapter, fixture('claude-read.jsonl'));
		expect(events[0]).toEqual({type: 'session', sessionId: 'b683a96f-130a-4397-b30f-3d9fb5bf9b53'});
		expect(events.filter(e => e.type === 'tool')).toEqual([
			{type: 'tool', id: expect.any(String), name: 'read', summary: 'hello.txt', status: 'running'},
			{type: 'tool', id: expect.any(String), name: 'read', summary: 'hello.txt', status: 'done', output: expect.stringContaining('marmalade')},
		]);
		expect(events).toContainEqual({type: 'text', text: 'marmalade'});
		expect(events).toContainEqual(expect.objectContaining({type: 'usage', costUsd: 0.00380072, outputTokens: 129}));
		expect(events.at(-1)).toEqual({type: 'result', ok: true, text: 'marmalade'});
	});

	it('marks tools blocked by permissions as denied, not failed', () => {
		const events = parseAll(claudeAdapter, fixture('claude-denied.jsonl'));
		const writes = events.filter(e => e.type === 'tool');
		expect(writes.map(e => e.type === 'tool' && e.status)).toEqual(['running', 'denied']);
		expect(events.at(-1)).toMatchObject({type: 'result', ok: true});
	});

	it('ignores non-JSON noise and subagent internals', () => {
		const parse = claudeAdapter.createParser('/repo');
		expect(parse('not json')).toEqual([]);
		expect(parse(JSON.stringify({type: 'assistant', parent_tool_use_id: 'x', message: {content: [{type: 'text', text: 'inner'}]}}))).toEqual([]);
	});
});

describe('codex adapter', () => {
	it('puts exec options before the resume subcommand and inlines instructions only on the first turn', () => {
		expect(codexAdapter.args({...input, systemPrompt: 'rules'})).toEqual([
			'exec',
			'--json',
			'--skip-git-repo-check',
			'--sandbox',
			'read-only',
			'<instructions>\nrules\n</instructions>\n\nhi',
		]);
		expect(codexAdapter.args({...input, systemPrompt: 'rules', sessionId: 't1', permissions: 'auto-edit'})).toEqual([
			'exec',
			'--json',
			'--skip-git-repo-check',
			'--sandbox',
			'workspace-write',
			'resume',
			't1',
			'hi',
		]);
	});

	it('parses threads, commands, file changes, messages and usage', () => {
		const events = parseAll(codexAdapter, fixture('codex-docs.jsonl'));
		expect(events[0]).toEqual({type: 'session', sessionId: '0199a213-81c0-7800-8aa1-bbab2a035a53'});
		expect(events).toContainEqual(expect.objectContaining({type: 'tool', id: 'item_1', name: 'shell', status: 'running'}));
		expect(events).toContainEqual(expect.objectContaining({type: 'tool', id: 'item_1', status: 'done', output: 'docs\nsdk\nexamples\n'}));
		expect(events).toContainEqual(expect.objectContaining({type: 'tool', name: 'edit', summary: 'src/a.ts', status: 'done'}));
		expect(events).toContainEqual({type: 'text', text: 'Repo contains docs, sdk, and examples directories.'});
		expect(events.at(-1)).toEqual({type: 'result', ok: true});
	});

	it('parses a real codex-cli 0.164.0 turn', () => {
		const events = parseAll(codexAdapter, fixture('codex-real.jsonl'));
		expect(events[0]).toEqual({type: 'session', sessionId: '01a17e16-9d60-79f1-bebc-a6b0b1d85266'});
		expect(events.filter(e => e.type === 'tool' && e.status === 'done').map(e => e.type === 'tool' && e.summary)).toEqual([
			'rg --files -g math.ts -g AGENTS.md',
			'cat math.ts',
		]);
		expect(events.filter(e => e.type === 'text').at(-1)).toEqual({type: 'text', text: '`add` takes two numbers, `a` and `b`, and returns their sum.'});
		expect(events.at(-1)).toEqual({type: 'result', ok: true});
	});

	it('shows the command inside the shell wrapper', () => {
		expect(unwrapShell("/bin/zsh -lc 'cat math.ts'")).toBe('cat math.ts');
		expect(unwrapShell('bash -lc ls')).toBe('ls');
		expect(unwrapShell(String.raw`/bin/bash -c 'echo '\''hi'\'''`)).toBe("echo 'hi'");
		expect(unwrapShell('npm test')).toBe('npm test');
		expect(unwrapShell(`/bin/zsh -lc "pwd && rg --files -g 'math.ts'"`)).toBe("pwd && rg --files -g 'math.ts'");
	});

	it('reports failed commands and failed turns', () => {
		const parse = codexAdapter.createParser('/repo');
		expect(parse(JSON.stringify({type: 'item.completed', item: {id: 'c', type: 'command_execution', command: 'npm test', exit_code: 1}}))).toMatchObject([
			{status: 'failed'},
		]);
		expect(parse(JSON.stringify({type: 'turn.failed', error: {message: 'rate limited'}}))).toEqual([
			{type: 'error', message: 'rate limited'},
			{type: 'result', ok: false},
		]);
	});
});

describe('antigravity adapter (fixtures recorded from agy 1.4.9)', () => {
	it('builds print-mode args with no time limit of its own', () => {
		expect(antigravityAdapter.args({...input, permissions: 'full-auto', model: 'gemini-pro', sessionId: 'conv-1'})).toEqual([
			'-p',
			'hi',
			'--output-format',
			'stream-json',
			'--print-timeout',
			'0',
			'--dangerously-skip-permissions',
			'--model',
			'gemini-pro',
			'--conversation',
			'conv-1',
		]);
		expect(antigravityAdapter.args(input)).not.toContain('--mode');
		expect(antigravityAdapter.args({...input, permissions: 'auto-edit'})).toEqual(expect.arrayContaining(['--mode', 'accept-edits']));
	});

	it('streams text deltas into one block and reads the final response and usage', () => {
		const events = parseAll(antigravityAdapter, fixture('agy-text.jsonl'));
		expect(events[0]).toEqual({type: 'session', sessionId: 'acd0cd52-5b07-4a13-bd47-48e3ff990409'});
		const texts = events.filter(e => e.type === 'text');
		expect(texts[0]).toMatchObject({delta: false});
		expect(texts.slice(1).every(e => e.type === 'text' && e.delta)).toBe(true);
		expect(texts.map(e => (e.type === 'text' ? e.text : '')).join('')).toContain('ancient mystery.');
		expect(events).toContainEqual({type: 'usage', inputTokens: 8489, outputTokens: 128});
		expect(events.at(-1)).toMatchObject({type: 'result', ok: true, text: expect.stringMatching(/^The endless blue waves.*mystery\.$/)});
	});

	it("counts only this turn's usage when resuming, not the conversation's total", () => {
		const events = parseAll(antigravityAdapter, fixture('agy-resume.jsonl'));
		expect(events).toContainEqual({type: 'usage', inputTokens: 8833, outputTokens: 81});
		expect(events.at(-1)).toEqual({type: 'result', ok: true, text: 'The'});
	});

	it('returns structured output', () => {
		expect(parseAll(antigravityAdapter, fixture('agy-schema.jsonl')).at(-1)).toMatchObject({type: 'result', ok: true, structured: {answer: 'Four'}});
	});

	it('shows tools with relative paths and marks a denied command, explaining the early stop', () => {
		const events = parseAll(antigravityAdapter, fixture('agy-edit-command-denied.jsonl'));
		const tools = events.filter(e => e.type === 'tool');
		expect(tools).toContainEqual({type: 'tool', id: 'agy-step-2', name: 'write', summary: 'notes.txt', status: 'running'});
		expect(tools).toContainEqual({type: 'tool', id: 'agy-step-2', name: 'write', summary: 'notes.txt', status: 'done'});
		expect(tools.at(-1)).toEqual({type: 'tool', id: 'agy-step-4', name: 'shell', summary: 'echo shell-ran', status: 'denied', output: 'Needs approval, so it was blocked.'});
		expect(events).toContainEqual({type: 'usage', inputTokens: 17503, outputTokens: 419});
		expect(events.at(-1)).toEqual({type: 'result', ok: true, text: "Antigravity stopped early: it needed approval for RunCommand, which it can't ask for when run by polyagent."});
	});

	it('trusts denied_actions over a write the stream reported as done', () => {
		const events = parseAll(antigravityAdapter, fixture('agy-write-denied.jsonl'));
		const writes = events.filter(e => e.type === 'tool' && e.id === 'agy-step-2');
		expect(writes.at(-1)).toMatchObject({status: 'denied'});
		expect(events.at(-1)).toMatchObject({type: 'result', ok: true, text: expect.stringContaining('WriteFile')});
	});

	it('reports failed runs and failed tools, and shows stray lines as text', () => {
		const parse = antigravityAdapter.createParser('/repo');
		const tool = (state: string, info: object) => JSON.stringify({event: 'step_update', step_update: {conversation_id: 'c', step_index: 3, state, step_type: 'tool', tool_name: 'read_file', tool_info: info}});
		expect(parse(tool('ERROR', {name: 'read_file', parameters: {Path: '/repo/src'}, error: {type: 'TOOL_ERROR', message: 'path is a directory, not a file'}}))).toEqual([
			{type: 'session', sessionId: 'c'},
			{type: 'tool', id: 'agy-step-3', name: 'read', summary: 'src', status: 'failed', output: 'path is a directory, not a file'},
		]);
		expect(parse(JSON.stringify({event: 'result', result: {conversation_id: 'c', status: 'ERROR', response: '', error: 'quota exceeded'}}))).toEqual([
			{type: 'error', message: 'quota exceeded'},
			{type: 'result', ok: false},
		]);
		expect(parse('plain text line')).toEqual([{type: 'text', text: 'plain text line'}]);
	});
});
