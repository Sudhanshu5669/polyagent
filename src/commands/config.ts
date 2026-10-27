import {
	isSettingKey,
	loadGlobalConfig,
	loadRepoConfig,
	parseSettingValue,
	saveGlobalConfig,
	saveRepoConfig,
	DEFAULT_SETTINGS,
} from '../core/config.js';
import {loadContext} from '../core/context.js';
import {s} from './style.js';

const KEYS = Object.keys(DEFAULT_SETTINGS).join(', ');

/** `polyagent config [get|set|unset] ...`. Writes the repo config unless --global is passed. */
export async function configCommand(cwd: string, args: string[], options: {global: boolean; json: boolean}): Promise<number> {
	const [action, key, value] = args;
	const ctx = await loadContext(cwd);

	if (!action) {
		if (options.json) {
			console.log(JSON.stringify(ctx.settings, null, 2));
			return 0;
		}

		for (const [k, v] of Object.entries(ctx.settings.values)) {
			const source = ctx.settings.sources[k as keyof typeof ctx.settings.values];
			console.log(`${k.padEnd(13)} ${String(v ?? 'unlimited').padEnd(12)} ${s.dim(source)}`);
		}

		return 0;
	}

	if (!key || !isSettingKey(key)) {
		console.error(`Unknown setting "${key ?? ''}". Settings: ${KEYS}`);
		return 2;
	}

	if (action === 'get') {
		const v = ctx.settings.values[key];
		console.log(options.json ? JSON.stringify(v) : String(v ?? 'unlimited'));
		return 0;
	}

	if (action !== 'set' && action !== 'unset') {
		console.error(`Unknown action "${action}". Use get, set or unset.`);
		return 2;
	}

	if (!options.global && !ctx.workspace.exists) {
		console.error(`polyagent isn't set up in this folder. Run ${s.accent('polyagent init')} first, or add --global.`);
		return 1;
	}

	let parsed: ReturnType<typeof parseSettingValue> | undefined;
	if (action === 'set') {
		if (value === undefined) {
			console.error(`Missing value: polyagent config set ${key} <value>`);
			return 2;
		}

		try {
			parsed = parseSettingValue(key, value);
		} catch (error) {
			console.error(`Invalid value for ${key}: ${(error as Error).message}`);
			return 2;
		}
	}

	if (options.global) {
		const global = await loadGlobalConfig();
		const settings = {...global.settings};
		if (action === 'set') Object.assign(settings, {[key]: parsed});
		else delete settings[key];
		await saveGlobalConfig({...global, settings});
	} else {
		const repo = await loadRepoConfig(ctx.workspace.root);
		const settings = {...repo.settings};
		if (action === 'set') Object.assign(settings, {[key]: parsed});
		else delete settings[key];
		await saveRepoConfig(ctx.workspace.root, {...repo, settings});
	}

	// Reloading also rewrites .gitignore to match the new effective mode.
	const after = await loadContext(cwd);
	const scope = options.global ? 'global default' : 'this repo';
	const now = String(after.settings.values[key] ?? 'unlimited');
	if (action === 'set') console.log(`${s.ok('✓')} ${key} = ${now} ${s.dim(`(${scope})`)}`);
	else console.log(`${s.ok('✓')} ${key} unset for ${scope}, now ${now} ${s.dim(`(from ${after.settings.sources[key]})`)}`);
	return 0;
}
