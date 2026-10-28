import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {loadEmployees, saveEmployee} from '../src/core/employees.js';
import {applyPreset, BUILTIN_PRESETS, deletePreset, findPreset, listPresets, savePreset} from '../src/core/presets.js';
import {tmpDir} from './helpers.js';

const cody = {
	id: 'cody',
	name: 'Cody',
	role: 'backend',
	provider: 'codex' as const,
	permissions: 'auto-edit' as const,
	owns: ['src/api/**'],
	summary: 'APIs',
	briefing: 'Specs',
	systemPrompt: 'Be terse.',
};

describe('presets', () => {
	it('saves a team and lists it with repo first, then global, then built-ins', async () => {
		const ws = tmpDir();
		const global = tmpDir();
		await savePreset(ws, 'Checkout team', 'Ships checkout', [cody]);
		await savePreset(global, 'Solo', '', [{...cody, id: 'sam', name: 'Sam'}]);

		const {presets, broken} = await listPresets(ws, global);
		expect(broken).toEqual([]);
		expect(presets.map(p => [p.scope, p.name])).toEqual([
			['repo', 'Checkout team'],
			['global', 'Solo'],
			...BUILTIN_PRESETS.map(p => ['builtin', p.name]),
		]);
		expect(presets[0]!.employees[0]).toMatchObject({id: 'cody', provider: 'codex', owns: ['src/api/**'], systemPrompt: 'Be terse.'});
		// Presets are plain files you can read and edit.
		expect(fs.readFileSync(path.join(ws, 'presets', 'checkout-team', 'preset.yaml'), 'utf8')).toContain('name: Checkout team');
		expect(fs.existsSync(path.join(ws, 'presets', 'checkout-team', 'employees', 'cody.md'))).toBe(true);
	});

	it('finds presets by id or name', () => {
		expect(findPreset(BUILTIN_PRESETS, 'full-stack')?.name).toBe('Full-stack squad');
		expect(findPreset(BUILTIN_PRESETS, 'Full-Stack Squad')?.id).toBe('full-stack');
		expect(findPreset(BUILTIN_PRESETS, 'nope')).toBeUndefined();
	});

	it('reports broken presets instead of failing', async () => {
		const ws = tmpDir();
		fs.mkdirSync(path.join(ws, 'presets', 'half-done'), {recursive: true});
		const {broken} = await listPresets(ws, tmpDir());
		expect(broken).toEqual([{id: 'half-done', scope: 'repo', dir: path.join(ws, 'presets', 'half-done'), error: 'missing preset.yaml'}]);
	});

	it('applies a built-in on the chosen CLI', async () => {
		const ws = tmpDir();
		const preset = findPreset(BUILTIN_PRESETS, 'full-stack')!;
		const result = await applyPreset(ws, preset, {mode: 'add', provider: 'codex'});
		expect(result.added).toEqual(['leo', 'maya', 'tess', 'rex']);
		const {employees} = await loadEmployees(ws);
		expect(employees.map(e => [e.id, e.role, e.provider])).toEqual([
			['leo', 'frontend', 'codex'],
			['maya', 'backend', 'codex'],
			['rex', 'reviewer', 'codex'],
			['tess', 'tests', 'codex'],
		]);
	});

	it('renames clashes, skips identical employees, and can replace the team', async () => {
		const ws = tmpDir();
		const preset = findPreset(BUILTIN_PRESETS, 'builder-reviewer')!;
		await applyPreset(ws, preset, {mode: 'add', provider: 'claude'});
		// Same again: identical employees are left alone.
		expect(await applyPreset(ws, preset, {mode: 'add', provider: 'claude'})).toMatchObject({added: [], unchanged: ['sam', 'rex']});
		// Different CLI: same ids, different definitions, so they come in renamed.
		const clash = await applyPreset(ws, preset, {mode: 'add', provider: 'codex'});
		expect(clash.renamed).toEqual([
			['sam', 'sam-2'],
			['rex', 'rex-2'],
		]);
		expect((await loadEmployees(ws)).employees.find(e => e.id === 'sam-2')?.name).toBe('Sam 2');

		await saveEmployee(ws, 'cody', cody);
		const replaced = await applyPreset(ws, preset, {mode: 'replace', provider: 'claude'});
		expect(replaced.removed.sort()).toEqual(['cody', 'rex', 'rex-2', 'sam', 'sam-2']);
		expect((await loadEmployees(ws)).employees.map(e => e.id)).toEqual(['rex', 'sam']);
	});

	it("moves employees off a CLI that isn't installed, dropping their model", async () => {
		const ws = tmpDir();
		const base = tmpDir();
		await savePreset(base, 'Mixed', '', [{...cody, model: 'gpt-5-codex'}]);
		const preset = (await listPresets(undefined, base)).presets[0]!;
		const result = await applyPreset(ws, preset, {mode: 'add', installed: ['claude'], fallback: 'claude'});
		expect(result.switched).toEqual(['cody']);
		const [moved] = (await loadEmployees(ws)).employees;
		expect(moved?.provider).toBe('claude');
		expect(moved?.model).toBeUndefined();
	});

	it('refuses to save a second preset with the same name in one place', async () => {
		const ws = tmpDir();
		const global = tmpDir();
		await savePreset(ws, 'My team', '', [cody]);
		await expect(savePreset(ws, ' my TEAM ', '', [cody])).rejects.toThrow(/already a preset called "My team"/);
		// The same name in another scope is fine; the repo one wins when applying by name.
		await savePreset(global, 'My team', '', [cody]);
		expect((await listPresets(ws, global)).presets.filter(p => p.name === 'My team').map(p => p.scope)).toEqual(['repo', 'global']);
	});

	it('deletes saved presets but never built-ins', async () => {
		const ws = tmpDir();
		await savePreset(ws, 'Temp', '', [cody]);
		const [temp] = (await listPresets(ws, tmpDir())).presets;
		await deletePreset(temp!);
		expect((await listPresets(ws, tmpDir())).presets.filter(p => p.scope === 'repo')).toEqual([]);
		await expect(deletePreset(BUILTIN_PRESETS[0]!)).rejects.toThrow(/Built-in/);
	});
});
