import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {exists} from '../fs.js';
import type {Env} from '../paths.js';

/** Ignored dependency folders that worktrees don't get from git; linked in from the main checkout instead. */
export const LINKED_DIRS = ['node_modules', '.venv', 'venv'];

/** Never sign internal commits: a signing prompt would hang a headless run. */
const NO_SIGN = ['-c', 'commit.gpgSign=false'];

/** Everything polyagent writes to the user's working tree excludes its own folder, wherever it sits. */
const EXCLUDE_WORKSPACE = ':(glob,exclude)**/.polyagent/**';

/** Identity for polyagent's internal commits, used only when git has none configured. */
const IDENTITY: Env = {GIT_AUTHOR_NAME: 'polyagent', GIT_AUTHOR_EMAIL: 'polyagent@localhost', GIT_COMMITTER_NAME: 'polyagent', GIT_COMMITTER_EMAIL: 'polyagent@localhost'};

interface GitResult {
	stdout: string;
	code: number;
	stderr: string;
}

/** `raw` keeps output byte-for-byte (patches can end in significant whitespace). */
function git(cwd: string, args: string[], options: {env?: Env; input?: string; allowFail?: boolean; raw?: boolean} = {}): Promise<GitResult> {
	return new Promise((resolve, reject) => {
		const child = execFile(
			'git',
			args,
			{cwd, env: {...process.env, ...options.env}, maxBuffer: 64 * 1024 * 1024, windowsHide: true},
			(error, stdout, stderr) => {
				const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
				if (code !== 0 && !options.allowFail) reject(new Error(`git ${args[0]} failed: ${stderr.trim() || error?.message}`));
				else resolve({stdout: options.raw ? stdout : stdout.trim(), stderr: stderr.trim(), code});
			},
		);
		if (options.input !== undefined) child.stdin?.end(options.input);
	});
}

export function cacheDir(env: Env = process.env, platform: NodeJS.Platform = process.platform): string {
	if (env.POLYAGENT_CACHE) return env.POLYAGENT_CACHE;
	if (platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'polyagent');
	if (platform === 'win32') return path.join(env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'polyagent');
	return path.join(env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), 'polyagent');
}

const OWNER_FILE = '.owner-pid';

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/** Remove worktrees left behind by polyagent processes that are no longer running (a crash, a killed terminal). */
export async function sweepAbandoned(root: string, repoCache: string): Promise<void> {
	let runs: string[];
	try {
		runs = await fs.readdir(repoCache);
	} catch {
		return;
	}

	for (const run of runs) {
		const dir = path.join(repoCache, run);
		const owner = Number(await fs.readFile(path.join(dir, OWNER_FILE), 'utf8').catch(() => 'NaN'));
		if (Number.isInteger(owner) && alive(owner)) continue;
		for (const entry of await fs.readdir(dir).catch(() => [] as string[])) {
			if (entry !== OWNER_FILE) await git(root, ['worktree', 'remove', '--force', path.join(dir, entry)], {allowFail: true});
		}

		await fs.rm(dir, {recursive: true, force: true});
	}

	await git(root, ['worktree', 'prune'], {allowFail: true});
}

export interface TaskMerge {
	/** Files the task changed. */
	files: string[];
	/** Set when the task's changes clash with work already merged; nothing was applied. */
	conflicts?: string[];
	/** Files merged into the run but not written to your working tree, because you changed them meanwhile. */
	unapplied?: string[];
}

/**
 * Parallel work for one run. Every employee gets a git worktree that starts from the run's latest merged state.
 * Finished tasks are committed in their worktree, three-way merged into the run's integration commit
 * (without touching any working tree), and the result is applied to the user's working tree.
 */
export class WorktreeIsolation {
	/** Latest merged state of the run. */
	head: string;
	private readonly worktrees = new Map<string, string>();
	readonly dir: string;
	private chain: Promise<unknown> = Promise.resolve();
	private env: Env = {};

	private constructor(
		readonly root: string,
		/** Where the workspace sits inside the repo; employees work in the same subfolder of their worktree. */
		private readonly subdir: string,
		readonly runId: string,
		readonly base: string,
		dir: string,
		env: Env,
	) {
		this.dir = dir;
		this.head = base;
		this.env = env;
	}

	get ref(): string {
		return `refs/polyagent/runs/${this.runId}`;
	}

	/**
	 * Snapshot the current working tree (including uncommitted and untracked files) as the run's base commit.
	 * Returns a reason instead when worktrees can't be used here.
	 */
	static async create(cwd: string, runId: string, cache = cacheDir()): Promise<WorktreeIsolation | {reason: string}> {
		const top = await git(cwd, ['rev-parse', '--show-toplevel'], {allowFail: true}).catch(() => undefined);
		if (!top) return {reason: "git isn't available here"};
		if (top.code !== 0) return {reason: "this folder isn't a git repository"};
		const root = top.stdout;
		const head = await git(root, ['rev-parse', '--verify', 'HEAD'], {allowFail: true}).catch(() => undefined);
		if (!head) return {reason: "git isn't available here"};
		if (head.code !== 0) return {reason: 'this repository has no commits yet'};

		const hasIdentity = (await git(root, ['config', 'user.email'], {allowFail: true})).code === 0;
		const env: Env = hasIdentity ? {} : IDENTITY;

		// A private index, so the user's staged changes are left exactly as they are.
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'polyagent-index-'));
		try {
			const indexEnv = {...env, GIT_INDEX_FILE: path.join(tmp, 'index')};
			await git(root, ['read-tree', 'HEAD'], {env: indexEnv});
			await git(root, ['add', '-A', '--', '.', EXCLUDE_WORKSPACE], {env: indexEnv});
			const tree = (await git(root, ['write-tree'], {env: indexEnv})).stdout;
			const base = (await git(root, [...NO_SIGN, 'commit-tree', tree, '-p', head.stdout, '-m', `polyagent: working tree at the start of run ${runId}`], {env})).stdout;
			const repoKey = `${path.basename(root)}-${createHash('sha1').update(root).digest('hex').slice(0, 8)}`;
			const subdir = path.relative(root, await fs.realpath(cwd));
			const repoCache = path.join(cache, 'worktrees', repoKey);
			await sweepAbandoned(root, repoCache);
			const isolation = new WorktreeIsolation(root, subdir, runId, base, path.join(repoCache, runId), env);
			await fs.mkdir(isolation.dir, {recursive: true});
			// Marks the folder as in use, so another polyagent on this repo never sweeps it away.
			await fs.writeFile(path.join(isolation.dir, OWNER_FILE), String(process.pid));
			await git(root, ['update-ref', isolation.ref, base]);
			return isolation;
		} catch (error) {
			return {reason: (error as Error).message};
		} finally {
			await fs.rm(tmp, {recursive: true, force: true});
		}
	}

	/** Serialize everything that moves `head`. */
	private locked<T>(work: () => Promise<T>): Promise<T> {
		const next = this.chain.then(work, work);
		this.chain = next.catch(() => {});
		return next;
	}

	/** The employee's worktree, brought up to the latest merged state. Returns its path and the commit it starts from. */
	prepare(employeeId: string): Promise<{cwd: string; start: string}> {
		return this.locked(async () => {
			let cwd = this.worktrees.get(employeeId);
			if (!cwd) {
				cwd = path.join(this.dir, employeeId);
				await fs.rm(cwd, {recursive: true, force: true});
				await fs.mkdir(path.dirname(cwd), {recursive: true});
				await git(this.root, ['worktree', 'add', '--detach', '--force', cwd, this.head]);
				for (const name of LINKED_DIRS) {
					const source = path.join(this.root, name);
					if ((await exists(source)) && !(await exists(path.join(cwd, name)))) await fs.symlink(source, path.join(cwd, name), 'junction');
				}

				this.worktrees.set(employeeId, cwd);
			} else {
				// Drop anything left over (a cancelled task) and move to the latest merged state.
				await git(cwd, ['reset', '--hard', '--quiet']);
				await git(cwd, ['clean', '-fdq', ...LINKED_DIRS.flatMap(d => ['-e', d])]);
				await git(cwd, ['checkout', '--detach', '--quiet', this.head]);
			}

			return {cwd: path.join(cwd, this.subdir), start: this.head};
		});
	}

	/** Commit the task's changes in its worktree, merge them into the run, and apply them to the user's working tree. */
	finish(employeeId: string, taskId: string, start: string): Promise<TaskMerge> {
		return this.locked(async () => {
			const cwd = this.worktrees.get(employeeId);
			if (!cwd) return {files: []};

			await git(cwd, ['add', '-A', '--', '.', EXCLUDE_WORKSPACE, ...LINKED_DIRS.map(d => `:(exclude)${d}`)]);
			const staged = await git(cwd, ['diff', '--cached', '--quiet'], {allowFail: true});
			if (staged.code === 0) return {files: []};
			await git(cwd, [...NO_SIGN, 'commit', '--quiet', '--no-verify', '-m', `polyagent: ${taskId}`], {env: this.env});
			const commit = (await git(cwd, ['rev-parse', 'HEAD'])).stdout;
			const files = (await git(cwd, ['diff', '--name-only', start, commit])).stdout.split('\n').filter(Boolean);

			let tree: string;
			if (start === this.head) {
				tree = (await git(cwd, ['rev-parse', `${commit}^{tree}`])).stdout;
			} else {
				const merge = await git(this.root, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '--merge-base', start, this.head, commit], {allowFail: true});
				if (merge.code === 1) return {files, conflicts: merge.stdout.split('\n').slice(1).filter(Boolean)};
				if (merge.code !== 0) throw new Error(`git merge-tree failed: ${merge.stderr}`);
				tree = merge.stdout.split('\n')[0]!;
			}

			const previous = this.head;
			this.head = (await git(this.root, [...NO_SIGN, 'commit-tree', tree, '-p', previous, '-p', commit, '-m', `polyagent: merge ${taskId}`], {env: this.env})).stdout;
			await git(this.root, ['update-ref', this.ref, this.head]);

			// Bring the user's working tree along. If they changed the same files meanwhile, leave those alone.
			const patch = await git(this.root, ['diff', '--binary', previous, this.head], {raw: true});
			if (!patch.stdout.trim()) return {files};
			const applied = await git(this.root, ['apply', '--whitespace=nowarn', '-'], {input: patch.stdout, allowFail: true});
			if (applied.code === 0) return {files};
			return {files, unapplied: (await git(this.root, ['diff', '--name-only', previous, this.head])).stdout.split('\n').filter(Boolean)};
		});
	}

	/** Remove the worktrees. The integration ref stays, so the run's result can always be recovered. */
	cleanup(): Promise<void> {
		return this.locked(async () => {
			for (const cwd of this.worktrees.values()) await git(this.root, ['worktree', 'remove', '--force', cwd], {allowFail: true});
			this.worktrees.clear();
			await fs.rm(this.dir, {recursive: true, force: true});
			await git(this.root, ['worktree', 'prune'], {allowFail: true});
		});
	}
}
