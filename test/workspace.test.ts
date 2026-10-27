import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {RepoConfigSchema, saveRepoConfig} from '../src/core/config.js';
import {loadContext} from '../src/core/context.js';
import {applyGitTracking, initWorkspace, locateWorkspace} from '../src/core/workspace.js';
import {completePath} from '../src/ui/components/PathInput.js';
import {gitInit, gitStatus, tmpDir} from './helpers.js';

describe('locateWorkspace', () => {
	it('proposes the git root when run from a subfolder', async () => {
		const repo = tmpDir();
		gitInit(repo);
		fs.mkdirSync(path.join(repo, 'src', 'deep'), {recursive: true});
		const ws = await locateWorkspace(path.join(repo, 'src', 'deep'));
		expect(ws).toMatchObject({root: repo, exists: false, warnings: []});
	});

	it('finds an existing workspace above cwd', async () => {
		const repo = tmpDir();
		gitInit(repo);
		await initWorkspace(repo, 'ignore-all');
		fs.mkdirSync(path.join(repo, 'a', 'b'), {recursive: true});
		expect(await locateWorkspace(path.join(repo, 'a', 'b'))).toMatchObject({root: repo, exists: true});
	});

	it('warns outside git and in the home folder', async () => {
		const dir = tmpDir();
		const ws = await locateWorkspace(dir, dir);
		expect(ws.root).toBe(dir);
		expect(ws.warnings.join(' ')).toMatch(/home folder/);
		expect(ws.warnings.join(' ')).toMatch(/Not a git repository/);
	});
});

describe('git tracking', () => {
	async function setup() {
		const repo = tmpDir();
		gitInit(repo);
		await initWorkspace(repo, 'ignore-all');
		fs.writeFileSync(path.join(repo, '.polyagent', 'employees', 'maya.md'), '# maya');
		fs.mkdirSync(path.join(repo, '.polyagent', 'runs', 'r1'), {recursive: true});
		fs.writeFileSync(path.join(repo, '.polyagent', 'runs', 'r1', 'events.jsonl'), '{}');
		return repo;
	}

	it('ignore-all hides the whole folder from git without touching the repo .gitignore', async () => {
		const repo = await setup();
		expect(gitStatus(repo)).toEqual([]);
		expect(fs.existsSync(path.join(repo, '.gitignore'))).toBe(false);
	});

	it('share-team exposes employees and config but not runs', async () => {
		const repo = await setup();
		await applyGitTracking(repo, 'share-team');
		const status = gitStatus(repo).join('\n');
		expect(status).toContain('.polyagent/employees/maya.md');
		expect(status).toContain('.polyagent/config.json');
		expect(status).not.toContain('runs/');
	});

	it('track-all exposes runs too', async () => {
		const repo = await setup();
		await applyGitTracking(repo, 'track-all');
		expect(gitStatus(repo).join('\n')).toContain('.polyagent/runs/r1/events.jsonl');
	});

	it('loading the context re-syncs .gitignore with the effective setting', async () => {
		const repo = await setup();
		await saveRepoConfig(repo, RepoConfigSchema.parse({settings: {gitTracking: 'share-team'}}));
		await loadContext(repo, {POLYAGENT_HOME: tmpDir()});
		expect(fs.readFileSync(path.join(repo, '.polyagent', '.gitignore'), 'utf8')).toContain('runs/');
	});
});

describe('completePath', () => {
	it('completes a unique match and adds a slash to folders', async () => {
		const dir = tmpDir();
		fs.mkdirSync(path.join(dir, 'binaries'));
		expect((await completePath(path.join(dir, 'bin'))).value).toBe(path.join(dir, 'binaries') + '/');
	});

	it('completes to the common prefix and lists candidates when ambiguous', async () => {
		const dir = tmpDir();
		fs.writeFileSync(path.join(dir, 'claude-a'), '');
		fs.writeFileSync(path.join(dir, 'claude-b'), '');
		const result = await completePath(path.join(dir, 'cl'));
		expect(result.value).toBe(path.join(dir, 'claude-'));
		expect(result.candidates).toEqual(['claude-a', 'claude-b']);
	});

	it('keeps ~ as typed', async () => {
		const home = tmpDir();
		fs.mkdirSync(path.join(home, 'tools'));
		expect((await completePath('~/to', home)).value).toBe('~/tools/');
	});
});
