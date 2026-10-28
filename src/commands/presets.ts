import {loadContext} from '../core/context.js';
import {detectAll} from '../core/detect.js';
import {loadEmployees} from '../core/employees.js';
import {globalDir} from '../core/paths.js';
import {applyPreset, findPreset, listPresets, savePreset, type Preset} from '../core/presets.js';
import {PROVIDERS, type ProviderId} from '../core/providers.js';
import {s} from './style.js';

const SCOPE_LABEL: Record<Preset['scope'], string> = {repo: 'this repo', global: 'global', builtin: 'built-in'};

/** `polyagent presets [list | apply <name> [--replace] | save <name> [--global]]` */
export async function presetsCommand(cwd: string, args: string[], options: {global: boolean; replace: boolean; json: boolean}): Promise<number> {
	const [action = 'list', ...rest] = args;
	const name = rest.join(' ').trim();
	const ctx = await loadContext(cwd);
	const workspaceDir = ctx.workspace.exists ? ctx.workspace.dir : undefined;
	const {presets, broken} = await listPresets(workspaceDir, globalDir());

	if (action === 'list') {
		if (options.json) {
			console.log(JSON.stringify(presets.map(p => ({id: p.id, scope: p.scope, name: p.name, description: p.description, employees: p.employees.map(e => ({id: e.id, role: e.role, provider: e.provider}))})), null, 2));
			return 0;
		}

		for (const p of presets) {
			console.log(`${s.bold(p.name)} ${s.dim(`(${SCOPE_LABEL[p.scope]}, ${p.id})`)}`);
			if (p.description) console.log(`  ${p.description}`);
			console.log(s.dim(`  ${p.employees.map(e => `${e.name} [${e.role}]${p.scope === 'builtin' ? '' : ` ${PROVIDERS[e.provider].bins[0]}`}`).join(' · ')}`));
		}

		for (const b of broken) console.log(`${s.warn('⚠')} ${b.id} ${s.dim(`(${SCOPE_LABEL[b.scope]})`)}: ${b.error}`);
		return 0;
	}

	if (action !== 'apply' && action !== 'save') {
		console.error(`Unknown action "${action}". Use list, apply or save.`);
		return 2;
	}

	if (!ctx.workspace.exists) {
		console.error(`polyagent isn't set up in this folder. Run ${s.accent('polyagent init')} first.`);
		return 1;
	}

	if (!name) {
		console.error(`Missing name: polyagent presets ${action} <name>`);
		return 2;
	}

	if (action === 'apply') {
		const preset = findPreset(presets, name);
		if (!preset) {
			console.error(`No preset called "${name}". See polyagent presets list.`);
			return 1;
		}

		const installed = (await detectAll(ctx.global)).filter(d => d.status === 'found').map(d => d.provider);
		const preferred = ctx.settings.values.orchestrator;
		const fallback: ProviderId | undefined = installed.includes(preferred) ? preferred : installed[0];
		const result = await applyPreset(ctx.workspace.dir, preset, {mode: options.replace ? 'replace' : 'add', installed, fallback, provider: fallback});
		if (result.removed.length) console.log(`${s.dim('Removed')} ${result.removed.join(', ')}`);
		console.log(`${s.ok('✓')} ${preset.name}: added ${result.added.join(', ') || 'nobody new'}`);
		for (const [from, to] of result.renamed) console.log(s.dim(`  ${from} was already on the team, so the new one is ${to}`));
		if (result.unchanged.length) console.log(s.dim(`  already on the team: ${result.unchanged.join(', ')}`));
		if (result.switched.length && fallback) console.log(s.warn(`  switched to ${PROVIDERS[fallback].label} (their CLI isn't installed): ${result.switched.join(', ')}`));
		return 0;
	}

	// save
	const team = await loadEmployees(ctx.workspace.dir);
	if (team.employees.length === 0) {
		console.error('There is no team to save yet.');
		return 1;
	}

	const base = options.global ? globalDir() : ctx.workspace.dir;
	let id: string;
	try {
		id = await savePreset(base, name, '', team.employees);
	} catch (error) {
		console.error((error as Error).message);
		return 1;
	}

	console.log(`${s.ok('✓')} Saved ${team.employees.length} employees as "${name}" ${s.dim(`(${options.global ? 'global' : 'this repo'}, ${id})`)}`);
	return 0;
}
