import {execFile} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {GlobalConfig, ProviderEntry} from './config.js';
import type {Env} from './paths.js';
import {PROVIDERS, PROVIDER_IDS, type ProviderId} from './providers.js';

export type DetectionSource = ProviderEntry['source'] | 'saved';

export type Detection =
	| {provider: ProviderId; status: 'found'; path: string; version: string; source: DetectionSource}
	| {provider: ProviderId; status: 'broken'; path: string; error: string; source: DetectionSource}
	| {provider: ProviderId; status: 'missing'};

export interface DetectOptions {
	env?: Env;
	home?: string;
	platform?: NodeJS.Platform;
	/** Probe timeout per binary, ms. */
	timeout?: number;
}

/** Shared install locations for CLIs installed via npm, Homebrew, bun, Volta, pnpm or nvm — used when PATH is incomplete. */
export async function knownDirs(home: string, env: Env, platform: NodeJS.Platform): Promise<string[]> {
	const dirs = [
		path.join(home, '.local', 'bin'),
		path.join(home, '.npm-global', 'bin'),
		path.join(home, '.bun', 'bin'),
		path.join(home, '.volta', 'bin'),
		path.join(home, '.local', 'share', 'pnpm'),
		path.join(home, 'Library', 'pnpm'),
		'/opt/homebrew/bin',
		'/usr/local/bin',
	];
	if (env.npm_config_prefix) dirs.push(path.join(env.npm_config_prefix, 'bin'));
	if (platform === 'win32' && env.APPDATA) dirs.push(path.join(env.APPDATA, 'npm'));

	// Every installed nvm Node version, newest first.
	const nvmRoot = path.join(env.NVM_DIR ?? path.join(home, '.nvm'), 'versions', 'node');
	try {
		const versions = await fs.readdir(nvmRoot);
		versions.sort((a, b) => b.localeCompare(a, undefined, {numeric: true}));
		dirs.push(...versions.map(v => path.join(nvmRoot, v, 'bin')));
	} catch {}

	return dirs;
}

function executableNames(bin: string, env: Env, platform: NodeJS.Platform): string[] {
	if (platform !== 'win32') return [bin];
	const exts = (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean);
	return [bin, ...exts.map(ext => bin + ext.toLowerCase())];
}

async function isExecutable(file: string, platform: NodeJS.Platform): Promise<boolean> {
	try {
		const stat = await fs.stat(file);
		if (!stat.isFile()) return false;
		if (platform !== 'win32') await fs.access(file, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

export async function findInDirs(bins: string[], dirs: string[], env: Env, platform: NodeJS.Platform): Promise<string | undefined> {
	for (const dir of dirs) {
		for (const bin of bins) {
			for (const name of executableNames(bin, env, platform)) {
				const candidate = path.join(dir, name);
				if (await isExecutable(candidate, platform)) return candidate;
			}
		}
	}

	return undefined;
}

export function pathDirs(env: Env): string[] {
	return (env.PATH ?? '').split(path.delimiter).filter(Boolean);
}

/** Run `<bin> --version` and return its first non-empty output line. */
export function probeVersion(bin: string, timeout = 8000): Promise<string> {
	// npm installs Windows shims as .cmd files, which Node can only run through a shell.
	const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
	return new Promise((resolve, reject) => {
		execFile(shell ? `"${bin}"` : bin, ['--version'], {timeout, windowsHide: true, shell}, (error, stdout, stderr) => {
			const out = `${stdout}\n${stderr}`.split('\n').map(l => l.trim()).find(Boolean);
			if (error) {
				const reason = error.killed ? `no response after ${timeout / 1000}s` : (out ?? error.message);
				reject(new Error(reason));
				return;
			}

			resolve(out ?? 'unknown version');
		});
	});
}

async function probe(provider: ProviderId, file: string, source: DetectionSource, timeout?: number): Promise<Detection> {
	try {
		const version = await probeVersion(file, timeout);
		return {provider, status: 'found', path: file, version, source};
	} catch (error) {
		return {provider, status: 'broken', path: file, error: (error as Error).message, source};
	}
}

/**
 * Find one provider: the saved path first (if it still works), then PATH, then known install locations.
 * A saved path that stops working falls through to a fresh search rather than reporting broken.
 */
export async function detectProvider(provider: ProviderId, saved: ProviderEntry | undefined, options: DetectOptions = {}): Promise<Detection> {
	const env = options.env ?? process.env;
	const home = options.home ?? os.homedir();
	const platform = options.platform ?? process.platform;
	const def = PROVIDERS[provider];

	if (saved && (await isExecutable(saved.path, platform))) {
		const result = await probe(provider, saved.path, 'saved', options.timeout);
		if (result.status === 'found' || saved.source === 'manual') return result;
	}

	const onPath = await findInDirs(def.bins, pathDirs(env), env, platform);
	if (onPath) return probe(provider, onPath, 'path', options.timeout);

	const dirs = [...def.extraDirs(home), ...(await knownDirs(home, env, platform))];
	const known = await findInDirs(def.bins, dirs, env, platform);
	if (known) return probe(provider, known, 'known-location', options.timeout);

	return {provider, status: 'missing'};
}

export async function detectAll(config: GlobalConfig, options?: DetectOptions): Promise<Detection[]> {
	return Promise.all(PROVIDER_IDS.map(id => detectProvider(id, config.providers[id], options)));
}

/** Store found providers in the config. Missing ones are removed; broken manual entries are kept so the user can fix them. */
export function applyDetections(config: GlobalConfig, detections: Detection[]): GlobalConfig {
	const providers = {...config.providers};
	for (const d of detections) {
		if (d.status === 'found') {
			const previous = providers[d.provider];
			const source = d.source === 'saved' ? (previous?.source ?? 'path') : d.source;
			providers[d.provider] = {path: d.path, version: d.version, source};
		} else if (d.status === 'missing') {
			delete providers[d.provider];
		}
	}

	return {...config, providers};
}
