import {execFile} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {Env} from './paths.js';
import type {ProviderId} from './providers.js';

export interface ModelOption {
	/** What gets passed to the CLI's --model flag. */
	id: string;
	/** Human name, when the CLI gives one. */
	label?: string;
	hint?: string;
}

/** Claude Code has no command that lists models, but these aliases always resolve to the latest of each family. */
export const CLAUDE_ALIASES: ModelOption[] = [
	{id: 'fable', hint: 'Latest Fable, the most capable'},
	{id: 'opus', hint: 'Latest Opus'},
	{id: 'sonnet', hint: 'Latest Sonnet, fast and capable'},
	{id: 'haiku', hint: 'Latest Haiku, the fastest'},
];

/** `codex debug models` prints the catalog as JSON. Hidden entries are internal models Codex's own picker leaves out. */
export function parseCodexModels(json: string): ModelOption[] {
	const parsed = JSON.parse(json) as {models?: {slug?: string; display_name?: string; description?: string; visibility?: string; priority?: number}[]};
	return (parsed.models ?? [])
		.filter(m => m.slug && m.visibility !== 'hide')
		.sort((a, b) => (a.priority ?? Infinity) - (b.priority ?? Infinity))
		.map(m => ({id: m.slug!, label: m.display_name, hint: m.description}));
}

/** `agy models` prints one `<id>\t<name>` line per model, after a "Fetching…" line. */
export function parseAgyModels(text: string): ModelOption[] {
	return text
		.split('\n')
		.map(line => line.trim().split('\t'))
		.filter(([id, label]) => id && label)
		.map(([id, label]) => ({id: id!, label: label!.trim()}));
}

/** Extra models Claude Code offers this account (beyond the aliases), cached in its config file. Best effort. */
async function claudeAccountModels(env: Env, home: string): Promise<ModelOption[]> {
	try {
		const file = path.join(env.CLAUDE_CONFIG_DIR ?? home, '.claude.json');
		const config = JSON.parse(await fs.readFile(file, 'utf8')) as {additionalModelOptionsCache?: {value?: string; label?: string; description?: string}[]};
		return (config.additionalModelOptionsCache ?? []).filter(m => m.value).map(m => ({id: m.value!, hint: m.description ?? m.label}));
	} catch {
		return [];
	}
}

function capture(bin: string, args: string[], timeout: number): Promise<string> {
	// npm installs Windows shims as .cmd files, which Node can only run through a shell.
	const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
	return new Promise((resolve, reject) => {
		execFile(shell ? `"${bin}"` : bin, args, {timeout, windowsHide: true, shell, maxBuffer: 16 * 1024 * 1024}, (error, stdout, stderr) => {
			if (error) {
				const out = `${stderr}`.split('\n').map(l => l.trim()).find(Boolean);
				reject(new Error(error.killed ? `no response after ${timeout / 1000}s` : (out ?? error.message)));
				return;
			}

			resolve(stdout);
		});
	});
}

export interface ListModelsOptions {
	env?: Env;
	home?: string;
	timeout?: number;
}

/** Ask a provider's CLI which models it can use. Rejects when the CLI can't tell us, so the user can type a name instead. */
export async function listModels(provider: ProviderId, binary: string, options: ListModelsOptions = {}): Promise<ModelOption[]> {
	const timeout = options.timeout ?? 20_000;
	switch (provider) {
		case 'claude': {
			const extra = await claudeAccountModels(options.env ?? process.env, options.home ?? os.homedir());
			return [...CLAUDE_ALIASES, ...extra.filter(m => !CLAUDE_ALIASES.some(a => a.id === m.id))];
		}

		case 'codex':
			return parseCodexModels(await capture(binary, ['debug', 'models'], timeout));
		case 'antigravity':
			return parseAgyModels(await capture(binary, ['models'], timeout));
	}
}

const cache = new Map<string, Promise<ModelOption[]>>();

/** listModels, remembered for the session per binary. A failed lookup is forgotten so the next one retries. */
export function cachedModels(provider: ProviderId, binary: string): Promise<ModelOption[]> {
	const key = `${provider}:${binary}`;
	let pending = cache.get(key);
	if (!pending) {
		pending = listModels(provider, binary);
		pending.catch(() => cache.delete(key));
		cache.set(key, pending);
	}

	return pending;
}
