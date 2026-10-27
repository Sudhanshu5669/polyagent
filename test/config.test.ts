import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {
	DEFAULT_SETTINGS,
	emptyGlobalConfig,
	loadGlobalConfig,
	parseSettingValue,
	resolveSettings,
	RepoConfigSchema,
} from '../src/core/config.js';
import {tmpDir} from './helpers.js';

describe('resolveSettings', () => {
	it('uses defaults when nothing is set', () => {
		const {values, sources} = resolveSettings(emptyGlobalConfig());
		expect(values).toEqual(DEFAULT_SETTINGS);
		expect(sources.gitTracking).toBe('default');
	});

	it('layers repo over global over default and reports the source of each key', () => {
		const global = {...emptyGlobalConfig(), settings: {maxParallel: 4, gitTracking: 'share-team' as const}};
		const repo = RepoConfigSchema.parse({settings: {gitTracking: 'track-all'}});
		const {values, sources} = resolveSettings(global, repo);
		expect(values).toMatchObject({gitTracking: 'track-all', maxParallel: 4, autoRun: true});
		expect(sources).toEqual({gitTracking: 'repo', maxParallel: 'global', autoRun: 'default', orchestrator: 'default'});
	});

	it('keeps an explicit null (unlimited) from the repo over a global limit', () => {
		const global = {...emptyGlobalConfig(), settings: {maxParallel: 2}};
		const repo = RepoConfigSchema.parse({settings: {maxParallel: null}});
		expect(resolveSettings(global, repo).values.maxParallel).toBeNull();
	});
});

describe('parseSettingValue', () => {
	it('parses each kind of value', () => {
		expect(parseSettingValue('autoRun', 'off')).toBe(false);
		expect(parseSettingValue('maxParallel', 'unlimited')).toBeNull();
		expect(parseSettingValue('maxParallel', '6')).toBe(6);
		expect(parseSettingValue('gitTracking', 'share-team')).toBe('share-team');
	});

	it('rejects bad values', () => {
		expect(() => parseSettingValue('maxParallel', '0')).toThrow();
		expect(() => parseSettingValue('orchestrator', 'gpt')).toThrow();
	});
});

describe('loadGlobalConfig', () => {
	it('returns an empty config when the file does not exist', async () => {
		const home = tmpDir();
		expect(await loadGlobalConfig({POLYAGENT_HOME: home})).toEqual(emptyGlobalConfig());
	});

	it('names the file and the bad field when the config is invalid', async () => {
		const home = tmpDir();
		fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({settings: {maxParallel: -1}}));
		await expect(loadGlobalConfig({POLYAGENT_HOME: home})).rejects.toThrow(/config\.json has invalid settings:\n\s+settings\.maxParallel/);
	});
});
