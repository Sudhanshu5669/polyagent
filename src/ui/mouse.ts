import {useStdin} from 'ink';
import {useEffect, useRef} from 'react';

export interface MouseEvent {
	kind: 'down' | 'up' | 'drag' | 'wheel-up' | 'wheel-down';
	/** 0 = left, 1 = middle, 2 = right. */
	button: number;
	/** 0-based terminal column and row. */
	x: number;
	y: number;
}

// SGR mouse reports: ESC [ < button ; column ; row (M = press or motion, m = release).
const SGR = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

/** What Ink's keyboard parser hands to useInput for a mouse report (it strips the ESC). */
export const MOUSE_INPUT = /\[<\d+;\d+;\d+[Mm]/;

export function parseMouse(data: string): MouseEvent[] {
	const events: MouseEvent[] = [];
	for (const match of data.matchAll(SGR)) {
		const code = Number(match[1]);
		const x = Number(match[2]) - 1;
		const y = Number(match[3]) - 1;
		const released = match[4] === 'm';
		if (code & 64) events.push({kind: code & 1 ? 'wheel-down' : 'wheel-up', button: 0, x, y});
		else if (code & 32) events.push({kind: 'drag', button: code & 3, x, y});
		else events.push({kind: released ? 'up' : 'down', button: code & 3, x, y});
	}

	return events;
}

const ENABLE = '\x1b[?1000h\x1b[?1002h\x1b[?1006h';
const DISABLE = '\x1b[?1006l\x1b[?1002l\x1b[?1000l';

/** Mouse capture takes over text selection in most terminals (Shift+drag still selects), so it can be turned off. */
export function mouseEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return !['0', 'off', 'false', 'no'].includes((env.POLYAGENT_MOUSE ?? '').toLowerCase());
}

/** Only in a real terminal. `POLYAGENT_MOUSE=force` is for tests, which have no TTY. */
function mouseAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
	return (Boolean(process.stdout.isTTY) || env.POLYAGENT_MOUSE === 'force') && mouseEnabled(env);
}

/**
 * Report clicks, drags and the wheel while the component is mounted.
 * Does nothing outside a real terminal, so tests and pipes are left alone.
 */
export function useMouse(handler: (event: MouseEvent) => void, options: {isActive?: boolean} = {}): void {
	const {stdin} = useStdin();
	const latest = useRef(handler);
	latest.current = handler;
	const active = (options.isActive ?? true) && mouseAvailable();

	useEffect(() => {
		if (!active) return;
		const onData = (chunk: Buffer | string) => {
			const text = chunk.toString();
			if (!text.includes('\x1b[<')) return;
			for (const event of parseMouse(text)) latest.current(event);
		};

		process.stdout.write(ENABLE);
		stdin.on('data', onData);
		const off = () => process.stdout.write(DISABLE);
		process.once('exit', off);
		return () => {
			stdin.off('data', onData);
			process.off('exit', off);
			off();
		};
	}, [active, stdin]);
}
