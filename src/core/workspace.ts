import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {saveRepoConfig, type GitTracking, type RepoConfig, RepoConfigSchema} from './config.js';
import {exists, writeFileAtomic} from './fs.js';
import {gitInfo, type GitInfo} from './git.js';
import {WORKSPACE_DIRNAME} from './paths.js';

export const WORKSPACE_SUBDIRS = ['employees', 'presets', 'runs'] as const;

export interface WorkspaceLocation {
	/** Folder that holds (or will hold) .polyagent/. */
	root: string;
	dir: string;
	exists: boolean;
	git?: GitInfo;
	warnings: string[];
}

/**
 * Find the workspace for cwd: the nearest .polyagent/ walking up (stopping at the git root),
 * otherwise propose the git root, otherwise cwd itself.
 */
export async function locateWorkspace(cwd: string, home = os.homedir()): Promise<WorkspaceLocation> {
	const git = await gitInfo(cwd);
	const stop = git?.root ?? cwd;

	let dir = path.resolve(cwd);
	while (true) {
		if (await exists(path.join(dir, WORKSPACE_DIRNAME))) {
			return {root: dir, dir: path.join(dir, WORKSPACE_DIRNAME), exists: true, git, warnings: []};
		}

		const parent = path.dirname(dir);
		if (dir === stop || parent === dir) break;
		dir = parent;
	}

	const root = git?.root ?? path.resolve(cwd);
	const warnings: string[] = [];
	if (root === home) warnings.push('This is your home folder. polyagent is usually set up inside a project.');
	if (!git) warnings.push('Not a git repository. Employees will need git to work in parallel safely.');
	return {root, dir: path.join(root, WORKSPACE_DIRNAME), exists: false, git, warnings};
}

const GITIGNORE_HEADER = '# Managed by polyagent. Change with: polyagent config set gitTracking <mode>\n';

/** Contents of .polyagent/.gitignore for each tracking mode. The workspace ignores itself so the user's own .gitignore is never touched. */
export function gitignoreFor(mode: GitTracking): string {
	switch (mode) {
		case 'ignore-all':
			return `${GITIGNORE_HEADER}# Mode: ignore-all (nothing in .polyagent/ is committed)\n*\n`;
		case 'share-team':
			return `${GITIGNORE_HEADER}# Mode: share-team (employees, presets and config are committed; runs and chats stay local)\nruns/\nchats/\n*.tmp\n`;
		case 'track-all':
			return `${GITIGNORE_HEADER}# Mode: track-all (everything is committed)\n*.tmp\n`;
	}
}

export async function applyGitTracking(workspaceRoot: string, mode: GitTracking): Promise<void> {
	await writeFileAtomic(path.join(workspaceRoot, WORKSPACE_DIRNAME, '.gitignore'), gitignoreFor(mode));
}

export async function initWorkspace(workspaceRoot: string, mode: GitTracking): Promise<void> {
	const dir = path.join(workspaceRoot, WORKSPACE_DIRNAME);
	// .gitignore goes first so nothing is ever briefly visible to git.
	await fs.mkdir(dir, {recursive: true});
	await applyGitTracking(workspaceRoot, mode);
	for (const sub of WORKSPACE_SUBDIRS) await fs.mkdir(path.join(dir, sub), {recursive: true});
	if (!(await exists(path.join(dir, 'config.json')))) {
		const config: RepoConfig = RepoConfigSchema.parse({});
		await saveRepoConfig(workspaceRoot, config);
	}
}
