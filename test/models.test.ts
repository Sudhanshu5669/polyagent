import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {CLAUDE_ALIASES, listModels, parseAgyModels, parseCodexModels} from '../src/core/models.js';
import {tmpDir} from './helpers.js';

function script(dir: string, name: string, body: string): string {
	fs.mkdirSync(dir, {recursive: true});
	const file = path.join(dir, name);
	fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, {mode: 0o755});
	return file;
}

describe('parseCodexModels', () => {
	it('keeps listed models in priority order and drops hidden ones', () => {
		const json = JSON.stringify({
			models: [
				{slug: 'gpt-b', display_name: 'GPT B', description: 'second', visibility: 'list', priority: 2},
				{slug: 'internal', display_name: 'Internal', visibility: 'hide', priority: 0},
				{slug: 'gpt-a', display_name: 'GPT A', description: 'first', visibility: 'list', priority: 1},
			],
		});
		expect(parseCodexModels(json)).toEqual([
			{id: 'gpt-a', label: 'GPT A', hint: 'first'},
			{id: 'gpt-b', label: 'GPT B', hint: 'second'},
		]);
	});
});

describe('parseAgyModels', () => {
	it('reads id and name from each tab-separated line, skipping the status line', () => {
		const text = 'Fetching available models...\ngemini-flash-high\tGemini Flash (High)\nclaude-sonnet\tClaude Sonnet\n';
		expect(parseAgyModels(text)).toEqual([
			{id: 'gemini-flash-high', label: 'Gemini Flash (High)'},
			{id: 'claude-sonnet', label: 'Claude Sonnet'},
		]);
	});
});

describe('listModels', () => {
	it('asks agy for its models', async () => {
		const bin = script(tmpDir(), 'agy', `[ "$1" = models ] || exit 1\nprintf 'Fetching available models...\\ngemini-pro\\tGemini Pro\\n'`);
		expect(await listModels('antigravity', bin)).toEqual([{id: 'gemini-pro', label: 'Gemini Pro'}]);
	});

	it('asks codex for its catalog', async () => {
		const catalog = JSON.stringify({models: [{slug: 'gpt-x', display_name: 'GPT X', visibility: 'list', priority: 1}]});
		const bin = script(tmpDir(), 'codex', `[ "$1 $2" = "debug models" ] || exit 1\necho '${catalog}'`);
		expect(await listModels('codex', bin)).toEqual([{id: 'gpt-x', label: 'GPT X', hint: undefined}]);
	});

	it('reports why a CLI could not list its models', async () => {
		const bin = script(tmpDir(), 'agy', 'echo "not logged in" >&2\nexit 1');
		await expect(listModels('antigravity', bin)).rejects.toThrow('not logged in');
	});

	it("offers Claude Code's aliases plus the extra models cached for the account", async () => {
		const home = tmpDir();
		fs.writeFileSync(
			path.join(home, '.claude.json'),
			JSON.stringify({additionalModelOptionsCache: [{value: 'opus'}, {value: 'claude-big[1m]', label: 'Big', description: 'Big · long context'}]}),
		);
		expect(await listModels('claude', '/unused', {home, env: {}})).toEqual([...CLAUDE_ALIASES, {id: 'claude-big[1m]', hint: 'Big · long context'}]);
	});

	it('falls back to the aliases without a Claude Code config file', async () => {
		expect(await listModels('claude', '/unused', {home: tmpDir(), env: {}})).toEqual(CLAUDE_ALIASES);
	});
});
