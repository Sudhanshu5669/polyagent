import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import {z} from 'zod';
import {
	deleteEmployee,
	employeesDir,
	loadEmployees,
	saveEmployee,
	serializeEmployee,
	slugify,
	uniqueId,
	type Employee,
	type EmployeeMeta,
} from './employees.js';
import {exists, writeFileAtomic} from './fs.js';
import type {ProviderId} from './providers.js';
import {roleTemplate} from './roles.js';

export type PresetScope = 'repo' | 'global' | 'builtin';

export interface PresetEmployee extends EmployeeMeta {
	id: string;
	systemPrompt: string;
}

export interface Preset {
	/** Folder name (or a fixed key for built-ins). */
	id: string;
	scope: PresetScope;
	name: string;
	description: string;
	employees: PresetEmployee[];
	/** Where it lives on disk; undefined for built-ins. */
	dir?: string;
}

export interface BrokenPreset {
	id: string;
	scope: PresetScope;
	dir: string;
	error: string;
}

const PresetFileSchema = z.object({
	name: z.string().trim().min(1),
	description: z.string().default(''),
});

const PRESET_FILE = 'preset.yaml';

export function presetsDir(baseDir: string): string {
	return path.join(baseDir, 'presets');
}

function fromRole(id: string, name: string, role: string): PresetEmployee {
	const t = roleTemplate(role)!;
	return {id, name, role, provider: 'claude', permissions: t.permissions, owns: t.owns, summary: t.summary, briefing: t.briefing, systemPrompt: t.systemPrompt};
}

/** Starter teams. Their employees take whichever CLI the user picks when applying them. */
export const BUILTIN_PRESETS: Preset[] = [
	{
		id: 'builder-reviewer',
		scope: 'builtin',
		name: 'Builder + reviewer',
		description: 'One engineer who does the work and a strict reviewer who checks it. A good first team.',
		employees: [
			{
				id: 'sam',
				name: 'Sam',
				role: 'engineer',
				provider: 'claude',
				permissions: 'auto-edit',
				owns: [],
				summary: 'Implements features and fixes bugs anywhere in the codebase, with tests.',
				briefing: 'What to build or fix, where it lives, and how to tell it works.',
				systemPrompt:
					'You are a software engineer on this codebase. Follow its existing patterns. Keep changes focused on the task, add or update tests for what you change, and report what you changed and anything you could not finish.',
			},
			fromRole('rex', 'Rex', 'reviewer'),
		],
	},
	{
		id: 'full-stack',
		scope: 'builtin',
		name: 'Full-stack squad',
		description: 'Frontend, backend and test engineers working in parallel, plus a reviewer.',
		employees: [fromRole('leo', 'Leo', 'frontend'), fromRole('maya', 'Maya', 'backend'), fromRole('tess', 'Tess', 'tests'), fromRole('rex', 'Rex', 'reviewer')],
	},
	{
		id: 'product',
		scope: 'builtin',
		name: 'Product squad',
		description: 'The full-stack squad plus an artist for visual assets and a writer for docs.',
		employees: [
			fromRole('leo', 'Leo', 'frontend'),
			fromRole('maya', 'Maya', 'backend'),
			fromRole('iris', 'Iris', 'art'),
			fromRole('quinn', 'Quinn', 'docs'),
			fromRole('rex', 'Rex', 'reviewer'),
		],
	},
];

async function loadScope(baseDir: string, scope: PresetScope): Promise<{presets: Preset[]; broken: BrokenPreset[]}> {
	const root = presetsDir(baseDir);
	let ids: string[];
	try {
		ids = (await fs.readdir(root, {withFileTypes: true})).filter(d => d.isDirectory()).map(d => d.name).sort();
	} catch {
		return {presets: [], broken: []};
	}

	const presets: Preset[] = [];
	const broken: BrokenPreset[] = [];
	for (const id of ids) {
		const dir = path.join(root, id);
		try {
			const raw = YAML.parse(await fs.readFile(path.join(dir, PRESET_FILE), 'utf8'));
			const meta = PresetFileSchema.parse(raw ?? {});
			const team = await loadEmployees(dir);
			if (team.broken.length) throw new Error(`${team.broken[0]!.id}.md: ${team.broken[0]!.error}`);
			presets.push({id, scope, name: meta.name, description: meta.description, dir, employees: team.employees.map(stripFile)});
		} catch (error) {
			const message = (error as NodeJS.ErrnoException).code === 'ENOENT' ? `missing ${PRESET_FILE}` : (error as Error).message;
			broken.push({id, scope, dir, error: message});
		}
	}

	return {presets, broken};
}

function stripFile({file: _, ...employee}: Employee): PresetEmployee {
	return employee;
}

/** Repo presets first, then global ones, then the built-ins. */
export async function listPresets(workspaceDir: string | undefined, globalDir: string): Promise<{presets: Preset[]; broken: BrokenPreset[]}> {
	const repo = workspaceDir ? await loadScope(workspaceDir, 'repo') : {presets: [], broken: []};
	const global = await loadScope(globalDir, 'global');
	return {presets: [...repo.presets, ...global.presets, ...BUILTIN_PRESETS], broken: [...repo.broken, ...global.broken]};
}

/** Find a preset by id or name (case-insensitive), preferring repo over global over built-in. */
export function findPreset(presets: Preset[], query: string): Preset | undefined {
	const q = query.trim().toLowerCase();
	return presets.find(p => p.id === q) ?? presets.find(p => p.name.toLowerCase() === q) ?? presets.find(p => slugify(p.name) === slugify(q));
}

/** Save a team as a preset under baseDir (a workspace dir or the global dir). Returns the preset's folder id. */
export async function savePreset(baseDir: string, name: string, description: string, employees: PresetEmployee[]): Promise<string> {
	// Two presets with one name would make `presets apply <name>` ambiguous.
	const clash = (await loadScope(baseDir, 'repo')).presets.find(p => p.name.toLowerCase() === name.trim().toLowerCase());
	if (clash) throw new Error(`There's already a preset called "${clash.name}" here (${clash.id}). Pick another name or delete that one first.`);
	const root = presetsDir(baseDir);
	const taken = await fs.readdir(root).catch(() => [] as string[]);
	const id = uniqueId(name, taken);
	const dir = path.join(root, id);
	await writeFileAtomic(path.join(dir, PRESET_FILE), YAML.stringify({name: name.trim(), description: description.trim()}));
	for (const employee of employees) await saveEmployee(dir, employee.id, employee);
	return id;
}

export async function deletePreset(preset: Preset): Promise<void> {
	if (preset.scope === 'builtin' || !preset.dir) throw new Error('Built-in presets cannot be deleted.');
	await fs.rm(preset.dir, {recursive: true, force: true});
}

export interface ApplyOptions {
	/** 'add' keeps the current team; 'replace' removes it first. */
	mode: 'add' | 'replace';
	/** CLIs that are installed. Employees on any other CLI are switched to `fallback`, if given. */
	installed?: ProviderId[];
	fallback?: ProviderId;
	/** Built-in presets have no CLI of their own; use this one. */
	provider?: ProviderId;
}

export interface ApplyResult {
	added: string[];
	/** Employees that already existed with exactly the same definition. */
	unchanged: string[];
	/** Employees renamed to avoid clashing with someone already on the team: [preset id, new id]. */
	renamed: [string, string][];
	/** Employees moved to another CLI because theirs isn't installed. */
	switched: string[];
	removed: string[];
}

/** Put a preset's employees into the workspace. */
export async function applyPreset(workspaceDir: string, preset: Preset, options: ApplyOptions): Promise<ApplyResult> {
	const result: ApplyResult = {added: [], unchanged: [], renamed: [], switched: [], removed: []};
	if (options.mode === 'replace') {
		const current = await loadEmployees(workspaceDir);
		for (const e of [...current.employees, ...current.broken]) {
			await deleteEmployee(workspaceDir, e.id);
			result.removed.push(e.id);
		}
	}

	const team = await loadEmployees(workspaceDir);
	const taken = new Set([...team.employees, ...team.broken].map(e => e.id));
	for (const source of preset.employees) {
		let employee: PresetEmployee = preset.scope === 'builtin' && options.provider ? {...source, provider: options.provider} : {...source};
		if (options.installed && options.fallback && !options.installed.includes(employee.provider)) {
			// Model names belong to a CLI, so a switched employee goes back to the default model.
			employee = {...employee, provider: options.fallback, model: undefined};
			result.switched.push(employee.id);
		}

		const existingFile = path.join(employeesDir(workspaceDir), `${employee.id}.md`);
		if (taken.has(employee.id)) {
			const current = (await exists(existingFile)) ? await fs.readFile(existingFile, 'utf8') : '';
			if (current === serializeEmployee(employee)) {
				result.unchanged.push(employee.id);
				continue;
			}

			const id = uniqueId(employee.id, taken);
			result.renamed.push([employee.id, id]);
			// "maya-2" becomes "Maya 2", so two employees never share a name.
			employee = {...employee, id, name: `${employee.name} ${id.slice(id.lastIndexOf('-') + 1)}`};
		}

		await saveEmployee(workspaceDir, employee.id, employee);
		taken.add(employee.id);
		result.added.push(employee.id);
	}

	return result;
}
