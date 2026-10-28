import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {
	DEFAULT_SETTINGS,
	emptyGlobalConfig,
	formatSettingValue,
	loadGlobalConfig,
	parseSettingValue,
	resetModelOnOrchestratorChange,
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
		expect(sources).toMatchObject({gitTracking: 'repo', maxParallel: 'global', autoRun: 'default', orchestrator: 'default', approvals: 'default'});
		expect(values).toMatchObject({approvals: 'ask', runBudget: null, taskTimeout: null, orchestratorModel: null});
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

	it('parses budgets, time limits, approvals and model names', () => {
		expect(parseSettingValue('runBudget', '$2.50')).toBe(2.5);
		expect(parseSettingValue('runBudget', 'none')).toBeNull();
		expect(parseSettingValue('taskTimeout', '20')).toBe(20);
		expect(parseSettingValue('approvals', 'block')).toBe('block');
		expect(parseSettingValue('orchestratorModel', 'opus')).toBe('opus');
		expect(parseSettingValue('orchestratorModel', 'default')).toBeNull();
		expect(() => parseSettingValue('runBudget', '-1')).toThrow();
	});

	it('shows an unset model as the default and an unset limit as unlimited', () => {
		expect(formatSettingValue('orchestratorModel', null)).toBe('default');
		expect(formatSettingValue('runBudget', null)).toBe('unlimited');
		expect(formatSettingValue('maxParallel', 4)).toBe('4');
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

describe('resetModelOnOrchestratorChange', () => {
	it("drops a scope's own model when the orchestrator CLI changes", () => {
		const after = resetModelOnOrchestratorChange({orchestratorModel: 'opus'}, {orchestrator: 'codex', orchestratorModel: 'opus'}, DEFAULT_SETTINGS);
		expect(after).toEqual({orchestrator: 'codex'});
	});

	it('overrides an inherited model with the default', () => {
		const inherited = {...DEFAULT_SETTINGS, orchestratorModel: 'opus'};
		expect(resetModelOnOrchestratorChange({}, {orchestrator: 'codex'}, inherited)).toEqual({orchestrator: 'codex', orchestratorModel: null});
	});

	it('keeps the model when the orchestrator stays the same', () => {
		const before = {orchestrator: 'claude' as const, orchestratorModel: 'opus'};
		const after = {...before, maxParallel: 2};
		expect(resetModelOnOrchestratorChange(before, after, DEFAULT_SETTINGS)).toBe(after);
		// Setting the orchestrator to the one already inherited isn't a change either.
		expect(resetModelOnOrchestratorChange({orchestratorModel: 'opus'}, {orchestrator: DEFAULT_SETTINGS.orchestrator, orchestratorModel: 'opus'}, DEFAULT_SETTINGS)).toEqual({
			orchestrator: DEFAULT_SETTINGS.orchestrator,
			orchestratorModel: 'opus',
		});
	});
});
