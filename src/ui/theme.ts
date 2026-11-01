const noColor = Boolean(process.env.NO_COLOR);

export type ThemeMode = 'dark' | 'light';

/** OKLCH → sRGB hex. The design is specified in oklch (one hue per employee, same lightness and chroma). */
export function oklch(l: number, c: number, h: number): string {
	const a = c * Math.cos((h * Math.PI) / 180);
	const b = c * Math.sin((h * Math.PI) / 180);
	const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
	const linear = [4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_, -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_, -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_];
	const encode = (v: number) => {
		const x = Math.min(1, Math.max(0, v));
		const e = x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
		return Math.round(e * 255)
			.toString(16)
			.padStart(2, '0');
	};

	return `#${linear.map(encode).join('')}`;
}

/** Hue of the orchestrator (amber). Doubles as the app's accent. */
const ORCHESTRATOR_HUE = 85;
const RED_HUE = 20;

/** Employee hues, in the order they are handed out. The first four match the design's iris, forge, muse and pixel. */
const HUES = [295, 35, 155, 235, 340, 195, 120];
const GLYPHS = ['◎', '▲', '✦', '■', '◈', '❖', '✚'];
/** A second set, used only once a team outgrows the first. */
const GLYPHS_EXTRA = ['◑', '▽', '✧', '□', '◇', '⬡', '✛'];

interface Palette {
	/** Employee lightness (dark terminals 0.76–0.82, light terminals 0.55). */
	lightness: number;
	text: string;
	strong: string;
	soft: string;
	muted: string;
	dim: string;
	faint: string;
	track: string;
	rule: string;
}

const PALETTES: Record<ThemeMode, Palette> = {
	dark: {lightness: 0.78, text: '#d4d7de', strong: '#f2f3f5', soft: '#a4a9b6', muted: '#8a90a0', dim: '#6c7280', faint: '#4b505c', track: '#2e323b', rule: '#22252d'},
	light: {lightness: 0.55, text: '#2a2c31', strong: '#14161a', soft: '#4a4d55', muted: '#8a8780', dim: '#9a978f', faint: '#b8b5ad', track: '#e0ddd6', rule: '#d8d5ce'},
};

/** Colors are undefined under NO_COLOR, so status is always carried by glyphs + words, never color alone. */
const c = (value: string): string | undefined => (noColor ? undefined : value);

export const theme: {
	mode: ThemeMode;
	accent: string | undefined;
	ok: string | undefined;
	fail: string | undefined;
	warn: string | undefined;
	muted: string | undefined;
	border: string | undefined;
	/** Brightest text, for titles and the thing you are looking at. */
	strong: string | undefined;
	/** Normal text color; undefined lets the terminal's own foreground show through. */
	text: string | undefined;
	soft: string | undefined;
	dim: string | undefined;
	faint: string | undefined;
	/** The unfilled part of a progress bar. */
	track: string | undefined;
	rule: string | undefined;
} = {} as never;

let hueLightness = PALETTES.dark.lightness;

export function setThemeMode(mode: ThemeMode): void {
	const p = PALETTES[mode];
	hueLightness = p.lightness;
	const bright = mode === 'dark';
	Object.assign(theme, {
		mode,
		accent: c(oklch(bright ? 0.82 : 0.55, 0.12, ORCHESTRATOR_HUE)),
		ok: c(oklch(p.lightness, 0.12, 155)),
		fail: c(oklch(bright ? 0.72 : 0.55, 0.14, RED_HUE)),
		warn: c(oklch(bright ? 0.8 : 0.58, 0.13, 60)),
		muted: c(p.muted),
		border: c(p.faint),
		strong: c(p.strong),
		text: undefined,
		soft: c(p.soft),
		dim: c(p.dim),
		faint: c(p.faint),
		track: c(p.track),
		rule: c(p.rule),
	});
	identityCache.clear();
}

export const icons = {
	ok: '✓',
	fail: '✗',
	warn: '⚠',
	pointer: '›',
	dot: '·',
	branch: '⎇',
	handoff: '→',
};

/** Status glyphs shared by every screen. */
export const statusGlyph = {
	working: '●',
	tool: '⠹',
	waiting: '◌',
	idle: '○',
	done: '✓',
	stuck: '!',
};

export interface Identity {
	glyph: string;
	color: string | undefined;
}

export const orchestratorIdentity = (): Identity => ({glyph: '◆', color: theme.accent});

const identityCache = new Map<string, Map<string, Identity>>();

function hash(text: string): number {
	let h = 0;
	for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
	return h;
}

/**
 * A hue and glyph for each employee, stable for a given team: starts from a hash of the id and moves on
 * if a teammate already has it, so no two people on a team of up to seven look alike.
 */
export function identities(team: readonly string[]): Map<string, Identity> {
	const key = [...team].sort().join('\n');
	const cached = identityCache.get(key);
	if (cached) return cached;

	const result = new Map<string, Identity>();
	const taken = new Set<number>();
	for (const id of [...team].sort()) {
		let slot = hash(id) % HUES.length;
		for (let i = 0; i < HUES.length && taken.has(slot); i++) slot = (slot + 1) % HUES.length;
		const second = taken.has(slot);
		taken.add(slot);
		result.set(id, {glyph: (second ? GLYPHS_EXTRA : GLYPHS)[slot]!, color: c(oklch(hueLightness, 0.12, HUES[slot]!))});
	}

	if (identityCache.size > 20) identityCache.clear();
	identityCache.set(key, result);
	return result;
}

/** Look up one agent: the orchestrator, or an employee id. */
export function identityOf(agent: string, team: readonly string[]): Identity {
	if (agent === 'orchestrator') return orchestratorIdentity();
	return identities(team).get(agent) ?? {glyph: '·', color: theme.muted};
}

/** Pick the theme from the environment when the terminal can't be asked: POLYAGENT_THEME, then COLORFGBG. */
export function modeFromEnv(env: NodeJS.ProcessEnv = process.env): ThemeMode | undefined {
	const forced = env.POLYAGENT_THEME?.toLowerCase();
	if (forced === 'light' || forced === 'dark') return forced;
	// "fg;bg" (sometimes "fg;default;bg"): backgrounds 0–6 and 8 are dark, 7 and 9–15 light.
	const bg = Number(env.COLORFGBG?.split(';').at(-1));
	if (Number.isInteger(bg)) return bg === 7 || bg >= 9 ? 'light' : 'dark';
	return undefined;
}

/** Perceived lightness of an `rgb:RRRR/GGGG/BBBB` reply to OSC 11. */
export function modeFromOsc11(reply: string): ThemeMode | undefined {
	const match = /rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})/i.exec(reply);
	if (!match) return undefined;
	const [r, g, b] = [match[1]!, match[2]!, match[3]!].map(part => parseInt(part, 16) / (16 ** part.length - 1)) as [number, number, number];
	return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5 ? 'light' : 'dark';
}

export const MIN_COLUMNS = 60;
export const MIN_ROWS = 16;

setThemeMode('dark');
