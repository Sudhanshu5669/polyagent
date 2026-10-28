import path from 'node:path';

export const PROVIDER_IDS = ['claude', 'codex', 'antigravity'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface ProviderDef {
	id: ProviderId;
	label: string;
	/** Executable names to look for, in order of preference. */
	bins: string[];
	install: string[];
	docsUrl: string;
	/** Used to guess which provider a manually added binary belongs to. */
	versionPattern: RegExp;
	/** Install locations specific to this provider, beyond the shared ones in knownDirs(). */
	extraDirs: (home: string) => string[];
}

export const PROVIDERS: Record<ProviderId, ProviderDef> = {
	claude: {
		id: 'claude',
		label: 'Claude Code',
		bins: ['claude'],
		install: ['npm install -g @anthropic-ai/claude-code'],
		docsUrl: 'https://docs.claude.com/en/docs/claude-code',
		versionPattern: /claude/i,
		extraDirs: home => [path.join(home, '.claude', 'local')],
	},
	codex: {
		id: 'codex',
		label: 'Codex',
		bins: ['codex'],
		install: ['npm install -g @openai/codex'],
		docsUrl: 'https://github.com/openai/codex',
		versionPattern: /codex/i,
		extraDirs: () => [],
	},
	antigravity: {
		id: 'antigravity',
		label: 'Antigravity',
		bins: ['agy'],
		// The installer puts agy in ~/.local/bin, one of the shared known locations. The editor app doesn't include it.
		install: ['curl -fsSL https://antigravity.google/cli/install.sh | bash'],
		docsUrl: 'https://antigravity.google/docs/getting-started?tab=cli',
		versionPattern: /antigravity|\bagy\b/i,
		extraDirs: () => [],
	},
};

export function providerLabel(id: ProviderId): string {
	return PROVIDERS[id].label;
}

/**
 * Guess which provider a binary belongs to from its --version output, falling back to the file name.
 * Returns undefined when nothing matches so the user can pick.
 */
export function guessProvider(binPath: string, versionOutput: string): ProviderId | undefined {
	for (const def of Object.values(PROVIDERS)) {
		if (def.versionPattern.test(versionOutput)) return def.id;
	}

	const base = path.basename(binPath).replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
	return Object.values(PROVIDERS).find(def => def.bins.includes(base))?.id;
}
