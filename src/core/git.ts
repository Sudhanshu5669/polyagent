import {execFile} from 'node:child_process';

export interface GitInfo {
	root: string;
	/** Undefined when HEAD is detached. */
	branch?: string;
}

function git(cwd: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile('git', args, {cwd, timeout: 5000, windowsHide: true}, (error, stdout) => {
			if (error) reject(error);
			else resolve(stdout.trim());
		});
	});
}

/** Returns undefined outside a git repo, or when git is not installed. */
export async function gitInfo(cwd: string): Promise<GitInfo | undefined> {
	try {
		const root = await git(cwd, ['rev-parse', '--show-toplevel']);
		const branch = await git(cwd, ['branch', '--show-current']).catch(() => '');
		return {root, branch: branch || undefined};
	} catch {
		return undefined;
	}
}

/**
 * A text snapshot of uncommitted changes (status, stat and a truncated diff), produced by polyagent itself
 * so the orchestrator can check work even when its own CLI may not run shell commands.
 * Empty when the tree is clean, undefined outside a git repo. polyagent's own folder is left out.
 */
export async function workingTreeChanges(cwd: string, maxDiff = 6000): Promise<string | undefined> {
	try {
		const exclude = ':(exclude).polyagent';
		const status = await git(cwd, ['status', '--porcelain', '--untracked-files=all', '--', '.', exclude]);
		if (!status) return '';
		const stat = await git(cwd, ['diff', 'HEAD', '--stat', '--', '.', exclude]).catch(() => '');
		let diff = await git(cwd, ['diff', 'HEAD', '--', '.', exclude]).catch(() => '');
		if (diff.length > maxDiff) diff = `${diff.slice(0, maxDiff)}\n… (diff truncated)`;
		return [`git status --porcelain:\n${status}`, stat && `git diff --stat HEAD:\n${stat}`, diff && `git diff HEAD:\n${diff}`].filter(Boolean).join('\n\n');
	} catch {
		return undefined;
	}
}
