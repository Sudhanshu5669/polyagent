import fs from 'node:fs/promises';
import path from 'node:path';
import {loadGlobalConfig, loadRepoConfig, resolveSettings, type GlobalConfig, type RepoConfig, type ResolvedSettings} from './config.js';
import type {Env} from './paths.js';
import {gitignoreFor, locateWorkspace, type WorkspaceLocation} from './workspace.js';
import {writeFileAtomic} from './fs.js';

export interface AppContext {
	cwd: string;
	global: GlobalConfig;
	workspace: WorkspaceLocation;
	/** Present only when the workspace exists. */
	repo?: RepoConfig;
	settings: ResolvedSettings;
}

export async function loadContext(cwd: string, env?: Env): Promise<AppContext> {
	const global = await loadGlobalConfig(env);
	const workspace = await locateWorkspace(cwd);
	const repo = workspace.exists ? await loadRepoConfig(workspace.root) : undefined;
	const settings = resolveSettings(global, repo);
	if (workspace.exists) await syncGitignore(workspace.dir, settings.values.gitTracking);
	return {cwd, global, workspace, repo, settings};
}

/** Keep .polyagent/.gitignore in line with the effective mode, e.g. after the global default changed. */
export async function syncGitignore(workspaceDir: string, mode: ResolvedSettings['values']['gitTracking']): Promise<void> {
	const file = path.join(workspaceDir, '.gitignore');
	const wanted = gitignoreFor(mode);
	const current = await fs.readFile(file, 'utf8').catch(() => undefined);
	if (current !== wanted) await writeFileAtomic(file, wanted);
}
