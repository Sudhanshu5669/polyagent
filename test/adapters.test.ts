import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {antigravityAdapter} from '../src/core/agents/antigravity.js';
import {claudeAdapter} from '../src/core/agents/claude.js';
import {codexAdapter} from '../src/core/agents/codex.js';
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

describe('codex adapter (event shapes from the official non-interactive docs)', () => {
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

describe('antigravity adapter (tolerant: schema undocumented)', () => {
	it('builds print-mode args', () => {
		expect(antigravityAdapter.args({...input, permissions: 'full-auto', sessionId: 'conv-1'})).toEqual([
			'-p',
			'hi',
			'--output-format',
			'stream-json',
			'--dangerously-skip-permissions',
			'--conversation',
			'conv-1',
		]);
	});

	it('finds the session id, merges text deltas and reads the result status', () => {
		const events = parseAll(antigravityAdapter, [
			JSON.stringify({type: 'init', conversation_id: 'conv-9'}),
			JSON.stringify({type: 'step_update', delta: 'Hel'}),
			JSON.stringify({type: 'step_update', delta: 'lo'}),
			JSON.stringify({type: 'step_update', toolinfo: {id: 't1', name: 'write_file', path: 'a.txt', status: 'done'}}),
			JSON.stringify({type: 'result', status: 'ERROR', error: 'quota exceeded'}),
			'plain text line',
		]);
		expect(events[0]).toEqual({type: 'session', sessionId: 'conv-9'});
		expect(events.filter(e => e.type === 'text')).toEqual([
			{type: 'text', text: 'Hel', delta: true},
			{type: 'text', text: 'lo', delta: true},
			{type: 'text', text: 'plain text line'},
		]);
		expect(events).toContainEqual(expect.objectContaining({type: 'tool', name: 'write_file', summary: 'a.txt', status: 'done'}));
		expect(events).toContainEqual({type: 'error', message: 'quota exceeded'});
		expect(events).toContainEqual({type: 'result', ok: false, text: undefined});
	});
});
