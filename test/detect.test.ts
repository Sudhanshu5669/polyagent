import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {emptyGlobalConfig} from '../src/core/config.js';
import {applyDetections, detectProvider} from '../src/core/detect.js';
import {guessProvider} from '../src/core/providers.js';
import {fakeBin, tmpDir} from './helpers.js';

function sandbox() {
	const root = tmpDir();
	const home = path.join(root, 'home');
	const pathDir = path.join(root, 'bin');
	return {home, pathDir, env: {PATH: pathDir}, opts: (env: Record<string, string> = {PATH: pathDir}) => ({env, home, platform: 'darwin' as const})};
}

describe('detectProvider', () => {
	it('finds a CLI on PATH and reads its version', async () => {
		const sb = sandbox();
		const bin = fakeBin(sb.pathDir, 'claude', '2.1.0 (Claude Code)');
		expect(await detectProvider('claude', undefined, sb.opts())).toEqual({
			provider: 'claude',
			status: 'found',
			path: bin,
			version: '2.1.0 (Claude Code)',
			source: 'path',
		});
	});

	it('falls back to known install folders when PATH is incomplete', async () => {
		const sb = sandbox();
		const bin = fakeBin(path.join(sb.home, '.local', 'bin'), 'codex', 'codex-cli 0.50.0');
		const result = await detectProvider('codex', undefined, sb.opts({PATH: ''}));
		expect(result).toMatchObject({status: 'found', path: bin, source: 'known-location'});
	});

	it('looks for the Antigravity CLI under its agy binary name', async () => {
		const sb = sandbox();
		fakeBin(sb.pathDir, 'agy', 'agy 1.0.6');
		expect(await detectProvider('antigravity', undefined, sb.opts())).toMatchObject({status: 'found'});
	});

	it('prefers a saved path over PATH', async () => {
		const sb = sandbox();
		fakeBin(sb.pathDir, 'claude', 'from PATH');
		const saved = fakeBin(path.join(sb.home, 'custom'), 'claude', 'from saved');
		const result = await detectProvider('claude', {path: saved, source: 'manual'}, sb.opts());
		expect(result).toMatchObject({status: 'found', path: saved, version: 'from saved', source: 'saved'});
	});

	it('reports a manual path that no longer runs as broken instead of silently replacing it', async () => {
		const sb = sandbox();
		fakeBin(sb.pathDir, 'claude', 'from PATH');
		const saved = fakeBin(path.join(sb.home, 'custom'), 'claude', 'boom', 1);
		const result = await detectProvider('claude', {path: saved, source: 'manual'}, sb.opts());
		expect(result).toMatchObject({status: 'broken', path: saved, error: 'boom'});
	});

	it('re-searches when an auto-detected saved path breaks', async () => {
		const sb = sandbox();
		const onPath = fakeBin(sb.pathDir, 'claude', 'from PATH');
		const saved = fakeBin(path.join(sb.home, 'old'), 'claude', 'boom', 1);
		const result = await detectProvider('claude', {path: saved, source: 'path'}, sb.opts());
		expect(result).toMatchObject({status: 'found', path: onPath});
	});

	it('reports missing when nothing is installed', async () => {
		const sb = sandbox();
		expect(await detectProvider('codex', undefined, sb.opts())).toEqual({provider: 'codex', status: 'missing'});
	});
});

describe('applyDetections', () => {
	it('saves found providers, drops missing ones, and keeps the manual source', () => {
		const config = {...emptyGlobalConfig(), providers: {codex: {path: '/old/codex', source: 'path' as const}, claude: {path: '/x/claude', source: 'manual' as const}}};
		const next = applyDetections(config, [
			{provider: 'claude', status: 'found', path: '/x/claude', version: '2', source: 'saved'},
			{provider: 'codex', status: 'missing'},
		]);
		expect(next.providers).toEqual({claude: {path: '/x/claude', version: '2', source: 'manual'}});
	});
});

describe('guessProvider', () => {
	it('uses version output first, then the file name', () => {
		expect(guessProvider('/bin/whatever', '2.1.0 (Claude Code)')).toBe('claude');
		expect(guessProvider('/bin/codex', '0.50.0')).toBe('codex');
		expect(guessProvider('/bin/agy', '1.0')).toBe('antigravity');
		expect(guessProvider('/bin/mystery', '1.0')).toBeUndefined();
	});
});
