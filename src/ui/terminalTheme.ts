import {modeFromEnv, modeFromOsc11, setThemeMode, type ThemeMode} from './theme.js';

/** Ask the terminal for its background color (OSC 11) and read the answer; undefined if it doesn't reply in time. */
export function queryBackground(stdin: NodeJS.ReadStream, stdout: NodeJS.WriteStream, timeoutMs = 250): Promise<ThemeMode | undefined> {
	return new Promise(resolve => {
		if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== 'function') return resolve(undefined);

		let buffer = '';
		let settled = false;
		const finish = (mode: ThemeMode | undefined) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			stdin.off('data', onData);
			stdin.setRawMode(false);
			stdin.pause();
			resolve(mode);
		};

		const onData = (chunk: Buffer | string) => {
			buffer += chunk.toString();
			// The reply ends with BEL or ST (ESC \).
			if (/\x1b\]11;[^\x07\x1b]*(\x07|\x1b\\)/.test(buffer)) finish(modeFromOsc11(buffer));
		};

		const timer = setTimeout(() => finish(undefined), timeoutMs);
		stdin.setRawMode(true);
		stdin.on('data', onData);
		stdin.resume();
		stdout.write('\x1b]11;?\x07');
	});
}

/** Choose dark or light once at startup: an explicit override first, then the terminal's own answer, then COLORFGBG. */
export async function applyTerminalTheme(stdin = process.stdin, stdout = process.stdout): Promise<ThemeMode> {
	const forced = process.env.POLYAGENT_THEME?.toLowerCase();
	const mode = forced === 'light' || forced === 'dark' ? forced : ((await queryBackground(stdin, stdout)) ?? modeFromEnv() ?? 'dark');
	setThemeMode(mode);
	return mode;
}
