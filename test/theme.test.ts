import {describe, expect, it} from 'vitest';
import {identities, modeFromEnv, modeFromOsc11, oklch, setThemeMode, theme} from '../src/ui/theme.js';

describe('oklch', () => {
	it('converts to sRGB hex', () => {
		expect(oklch(1, 0, 0)).toBe('#ffffff');
		expect(oklch(0, 0, 0)).toBe('#000000');
		expect(oklch(0.5, 0, 0)).toMatch(/^#([0-9a-f]{2})\1\1$/);
	});

	it('keeps hues apart', () => {
		expect(new Set([85, 295, 35, 155, 235].map(h => oklch(0.78, 0.12, h))).size).toBe(5);
	});
});

describe('identities', () => {
	const team = ['maya', 'leo', 'rex', 'ana', 'bo', 'cy', 'di'];

	it('gives every teammate their own glyph and hue, the same way each time', () => {
		const first = identities(team);
		const glyphs = new Set([...first.values()].map(i => i.glyph));
		const colors = new Set([...first.values()].map(i => i.color));
		expect(glyphs.size).toBe(team.length);
		expect(colors.size).toBe(team.length);
		expect(identities([...team].reverse())).toBe(first);
		expect(identities(team).get('maya')).toEqual(first.get('maya'));
	});

	it('keeps looking distinct past seven people', () => {
		const many = Array.from({length: 10}, (_, i) => `emp${i}`);
		const result = identities(many);
		const looks = new Set([...result.values()].map(i => `${i.glyph}${i.color}`));
		expect(looks.size).toBe(10);
	});

	it('uses lighter text colors on dark terminals than on light ones', () => {
		setThemeMode('dark');
		const dark = identities(['maya']).get('maya')!.color;
		setThemeMode('light');
		const light = identities(['maya']).get('maya')!.color;
		setThemeMode('dark');
		expect(dark).not.toBe(light);
		expect(theme.mode).toBe('dark');
	});
});

describe('terminal background', () => {
	it('reads OSC 11 replies', () => {
		expect(modeFromOsc11('\x1b]11;rgb:1010/1212/1717\x07')).toBe('dark');
		expect(modeFromOsc11('\x1b]11;rgb:ffff/ffff/ffff\x1b\\')).toBe('light');
		expect(modeFromOsc11('\x1b]11;rgb:f6/f5/f2\x07')).toBe('light');
		expect(modeFromOsc11('garbage')).toBeUndefined();
	});

	it('falls back to the environment', () => {
		expect(modeFromEnv({POLYAGENT_THEME: 'light'})).toBe('light');
		expect(modeFromEnv({COLORFGBG: '15;0'})).toBe('dark');
		expect(modeFromEnv({COLORFGBG: '0;15'})).toBe('light');
		expect(modeFromEnv({COLORFGBG: '0;default;7'})).toBe('light');
		expect(modeFromEnv({})).toBeUndefined();
	});
});
