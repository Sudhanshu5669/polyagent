import path from 'node:path';
import {z} from 'zod';
import {readJson, writeJson} from './fs.js';
import {globalConfigPath, WORKSPACE_DIRNAME, type Env} from './paths.js';
import {PROVIDER_IDS} from './providers.js';

export const ProviderIdSchema = z.enum(PROVIDER_IDS);

export const GIT_TRACKING_MODES = ['ignore-all', 'share-team', 'track-all'] as const;
export const GitTrackingSchema = z.enum(GIT_TRACKING_MODES);
export type GitTracking = z.infer<typeof GitTrackingSchema>;

export const ProviderEntrySchema = z.object({
	path: z.string(),
	version: z.string().optional(),
	source: z.enum(['path', 'known-location', 'manual']),
});
export type ProviderEntry = z.infer<typeof ProviderEntrySchema>;

/** Every setting that can be set globally and overridden per repo. Kept flat so layering is a plain spread. */
export const SettingsSchema = z.object({
	gitTracking: GitTrackingSchema,
	orchestrator: ProviderIdSchema,
	autoRun: z.boolean(),
	/** null = no limit on how many employees work at once. */
	maxParallel: z.number().int().positive().nullable(),
	/** Claude employees: ask the user about actions that need approval, or block them. */
	approvals: z.enum(['ask', 'block']),
	/** Pause a run once it has cost this many US dollars (as reported by the CLIs). null = no budget. */
	runBudget: z.number().positive().nullable(),
	/** Stop a task after this many minutes. null = no limit. */
	taskTimeout: z.number().int().positive().nullable(),
	/** null = the orchestrator CLI's default model. */
	orchestratorModel: z.string().trim().min(1).nullable(),
});
export type Settings = z.infer<typeof SettingsSchema>;
export type SettingKey = keyof Settings;

export const DEFAULT_SETTINGS: Settings = {
	gitTracking: 'ignore-all',
	orchestrator: 'claude',
	autoRun: true,
	maxParallel: null,
	approvals: 'ask',
	runBudget: null,
	taskTimeout: null,
	orchestratorModel: null,
};

export const GlobalConfigSchema = z.object({
	version: z.literal(1).default(1),
	providers: z
		.object({
			claude: ProviderEntrySchema.optional(),
			codex: ProviderEntrySchema.optional(),
			antigravity: ProviderEntrySchema.optional(),
		})
		.default({}),
	settings: SettingsSchema.partial().default({}),
});
export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;

export const RepoConfigSchema = z.object({
	version: z.literal(1).default(1),
	settings: SettingsSchema.partial().default({}),
});
export type RepoConfig = z.infer<typeof RepoConfigSchema>;

export type SettingSource = 'default' | 'global' | 'repo';

export interface ResolvedSettings {
	values: Settings;
	sources: Record<SettingKey, SettingSource>;
}

export function resolveSettings(global: GlobalConfig, repo?: RepoConfig): ResolvedSettings {
	const values = {...DEFAULT_SETTINGS, ...stripUndefined(global.settings), ...stripUndefined(repo?.settings ?? {})};
	const sources = {} as Record<SettingKey, SettingSource>;
	for (const key of Object.keys(DEFAULT_SETTINGS) as SettingKey[]) {
		sources[key] = repo?.settings[key] !== undefined ? 'repo' : global.settings[key] !== undefined ? 'global' : 'default';
	}

	return {values, sources};
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
	return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function emptyGlobalConfig(): GlobalConfig {
	return GlobalConfigSchema.parse({});
}

export async function loadGlobalConfig(env?: Env): Promise<GlobalConfig> {
	const file = globalConfigPath(env);
	const raw = await readJson(file);
	if (raw === undefined) return emptyGlobalConfig();
	return parseOrExplain(GlobalConfigSchema, raw, file);
}

export async function saveGlobalConfig(config: GlobalConfig, env?: Env): Promise<void> {
	await writeJson(globalConfigPath(env), config);
}

export function repoConfigPath(workspaceRoot: string): string {
	return path.join(workspaceRoot, WORKSPACE_DIRNAME, 'config.json');
}

export async function loadRepoConfig(workspaceRoot: string): Promise<RepoConfig> {
	const file = repoConfigPath(workspaceRoot);
	const raw = await readJson(file);
	if (raw === undefined) return RepoConfigSchema.parse({});
	return parseOrExplain(RepoConfigSchema, raw, file);
}

export async function saveRepoConfig(workspaceRoot: string, config: RepoConfig): Promise<void> {
	await writeJson(repoConfigPath(workspaceRoot), config);
}

function parseOrExplain<T>(schema: z.ZodType<T>, raw: unknown, file: string): T {
	const result = schema.safeParse(raw);
	if (result.success) return result.data;
	const issues = result.error.issues.map(i => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
	throw new Error(`${file} has invalid settings:\n${issues}`);
}

/** Parse a user-typed value (CLI `config set`) into a setting value, with a readable error. */
export function parseSettingValue(key: SettingKey, input: string): Settings[SettingKey] {
	const value = input.trim();
	switch (key) {
		case 'gitTracking':
			return GitTrackingSchema.parse(value);
		case 'orchestrator':
			return ProviderIdSchema.parse(value);
		case 'autoRun':
			if (['true', 'on', 'yes', '1'].includes(value)) return true;
			if (['false', 'off', 'no', '0'].includes(value)) return false;
			throw new Error('expected on or off');
		case 'maxParallel':
		case 'taskTimeout': {
			if (['none', 'unlimited', 'off', 'null'].includes(value)) return null;
			const n = Number(value);
			if (!Number.isInteger(n) || n < 1) throw new Error('expected a whole number ≥ 1, or "unlimited"');
			return n;
		}

		case 'runBudget': {
			if (['none', 'unlimited', 'off', 'null'].includes(value)) return null;
			const n = Number(value.replace(/^\$/, ''));
			if (!Number.isFinite(n) || n <= 0) throw new Error('expected an amount in dollars, e.g. 5, or "none"');
			return n;
		}

		case 'approvals':
			return z.enum(['ask', 'block']).parse(value);
		case 'orchestratorModel':
			return ['default', 'none', 'null', ''].includes(value) ? null : value;
	}
}

export function isSettingKey(key: string): key is SettingKey {
	return key in DEFAULT_SETTINGS;
}
