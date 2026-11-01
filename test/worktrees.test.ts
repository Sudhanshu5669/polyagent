import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {WorktreeIsolation} from '../src/core/run/worktrees.js';
import {tmpDir} from './helpers.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {cwd, encoding: 'utf8'}).trim();

function repo(): string {
	const dir = tmpDir();
	git(dir, 'init', '-q', '-b', 'main');
	git(dir, 'config', 'user.email', 'me@example.com');
	git(dir, 'config', 'user.name', 'Me');
	fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
	fs.writeFileSync(path.join(dir, 'b.txt'), 'bee\n');
	git(dir, 'add', '.');
	git(dir, 'commit', '-q', '-m', 'init');
	return dir;
}

async function isolate(root: string, runId = 'r1') {
	const iso = await WorktreeIsolation.create(root, runId, path.join(tmpDir(), 'cache'));
	if (!(iso instanceof WorktreeIsolation)) throw new Error(iso.reason);
	return iso;
}

const read = (...p: string[]) => fs.readFileSync(path.join(...p), 'utf8');

describe('WorktreeIsolation', () => {
	it('starts employees from the working tree as it is, without touching the index or branch', async () => {
		const root = repo();
		fs.writeFileSync(path.join(root, 'a.txt'), 'one\ntwo (edited, unstaged)\nthree\n');
		fs.writeFileSync(path.join(root, 'new.txt'), 'untracked\n');
		fs.writeFileSync(path.join(root, 'b.txt'), 'bee (staged)\n');
		git(root, 'add', 'b.txt');
		const statusBefore = git(root, 'status', '--porcelain');

		const iso = await isolate(root);
		const {cwd} = await iso.prepare('maya');
		expect(read(cwd, 'a.txt')).toContain('edited, unstaged');
		expect(read(cwd, 'new.txt')).toBe('untracked\n');
		expect(read(cwd, 'b.txt')).toBe('bee (staged)\n');
		expect(git(root, 'status', '--porcelain')).toBe(statusBefore);
		expect(git(root, 'branch', '--show-current')).toBe('main');
	});

	it('merges parallel work on different files and applies it to the working tree', async () => {
		const root = repo();
		const iso = await isolate(root);
		const maya = await iso.prepare('maya');
		const leo = await iso.prepare('leo');
		fs.writeFileSync(path.join(maya.cwd, 'api.ts'), 'export const api = 1;\n');
		fs.writeFileSync(path.join(leo.cwd, 'b.txt'), 'bee, rewritten by leo\n');

		const api = await iso.finish('maya', 'api', maya.start);
		expect(api).toEqual({files: ['api.ts'], patch: expect.stringContaining('diff --git a/api.ts b/api.ts')});
		expect(await iso.finish('leo', 'ui', leo.start)).toEqual({files: ['b.txt'], patch: expect.stringContaining('b.txt')});
		expect(read(root, 'api.ts')).toBe('export const api = 1;\n');
		expect(read(root, 'b.txt')).toBe('bee, rewritten by leo\n');
		// Both tasks are in the run's history, reachable from its ref.
		expect(git(root, 'log', '--format=%s', iso.ref)).toContain('polyagent: merge ui');

		// A later task starts from everything merged so far.
		const again = await iso.prepare('maya');
		expect(read(again.cwd, 'b.txt')).toBe('bee, rewritten by leo\n');
	});

	it('reports a conflict instead of applying clashing work', async () => {
		const root = repo();
		const iso = await isolate(root);
		const maya = await iso.prepare('maya');
		const leo = await iso.prepare('leo');
		fs.writeFileSync(path.join(maya.cwd, 'a.txt'), 'one\nTWO by maya\nthree\n');
		fs.writeFileSync(path.join(leo.cwd, 'a.txt'), 'one\nTWO by leo\nthree\n');

		await iso.finish('maya', 'm', maya.start);
		expect(await iso.finish('leo', 'l', leo.start)).toEqual({files: ['a.txt'], conflicts: ['a.txt'], patch: expect.stringContaining('a.txt')});
		expect(read(root, 'a.txt')).toBe('one\nTWO by maya\nthree\n');
	});

	it('leaves files you edited during the run alone and says so', async () => {
		const root = repo();
		const iso = await isolate(root);
		const maya = await iso.prepare('maya');
		fs.writeFileSync(path.join(maya.cwd, 'a.txt'), 'one\ntwo by maya\nthree\n');
		fs.writeFileSync(path.join(root, 'a.txt'), 'one\ntwo by me, meanwhile\nthree\n');

		expect(await iso.finish('maya', 'm', maya.start)).toEqual({files: ['a.txt'], unapplied: ['a.txt'], patch: expect.stringContaining('a.txt')});
		expect(read(root, 'a.txt')).toContain('by me, meanwhile');
		// The merged version is still recoverable from the run ref.
		expect(git(root, 'show', `${iso.ref}:a.txt`)).toContain('two by maya');
	});

	it('links dependency folders into worktrees and never commits them', async () => {
		const root = repo();
		fs.mkdirSync(path.join(root, 'node_modules', 'left-pad'), {recursive: true});
		fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n');
		git(root, 'add', '.gitignore');
		git(root, 'commit', '-q', '-m', 'ignore');
		const iso = await isolate(root);
		const maya = await iso.prepare('maya');
		expect(fs.existsSync(path.join(maya.cwd, 'node_modules', 'left-pad'))).toBe(true);
		fs.writeFileSync(path.join(maya.cwd, 'x.txt'), 'x\n');
		expect((await iso.finish('maya', 't', maya.start)).files).toEqual(['x.txt']);
	});

	it('returns no changes for a task that changed nothing', async () => {
		const root = repo();
		const iso = await isolate(root);
		const maya = await iso.prepare('maya');
		expect(await iso.finish('maya', 't', maya.start)).toEqual({files: []});
	});

	it('removes worktrees on cleanup but keeps the run ref', async () => {
		const root = repo();
		const iso = await isolate(root);
		const maya = await iso.prepare('maya');
		await iso.cleanup();
		expect(fs.existsSync(maya.cwd)).toBe(false);
		expect(git(root, 'worktree', 'list')).not.toContain(maya.cwd);
		expect(git(root, 'rev-parse', iso.ref)).toBe(iso.base);
	});

	it('explains when worktrees cannot be used', async () => {
		const plain = tmpDir();
		expect(await WorktreeIsolation.create(plain, 'r')).toEqual({reason: "this folder isn't a git repository"});
		const empty = tmpDir();
		git(empty, 'init', '-q');
		expect(await WorktreeIsolation.create(empty, 'r')).toEqual({reason: 'this repository has no commits yet'});
	});
});
