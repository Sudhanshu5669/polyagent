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
