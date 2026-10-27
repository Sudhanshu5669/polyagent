import os from 'node:os';
import path from 'node:path';

export const APP_NAME = 'polyagent';
export const WORKSPACE_DIRNAME = '.polyagent';

export type Env = Record<string, string | undefined>;

/** Global config dir: $POLYAGENT_HOME, else %APPDATA%\polyagent on Windows, else $XDG_CONFIG_HOME/polyagent (~/.config/polyagent). */
export function globalDir(env: Env = process.env, platform: NodeJS.Platform = process.platform): string {
	if (env.POLYAGENT_HOME) return env.POLYAGENT_HOME;
	if (platform === 'win32') {
		return path.join(env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), APP_NAME);
	}

	return path.join(env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), APP_NAME);
}

export function globalConfigPath(env?: Env): string {
	return path.join(globalDir(env), 'config.json');
}

/** Replace a leading ~ with the home dir, and the home dir with ~ for display. */
export function expandHome(p: string, home = os.homedir()): string {
	if (p === '~') return home;
	if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(home, p.slice(2));
	return p;
}

export function tildify(p: string, home = os.homedir()): string {
	if (p === home) return '~';
	if (p.startsWith(home + path.sep)) return '~' + p.slice(home.length);
	return p;
}
