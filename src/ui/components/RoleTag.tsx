import {Text} from 'ink';
import {theme} from '../theme.js';

const PALETTE = ['magenta', 'cyan', 'yellow', 'green', 'blue', 'red'];

/** Same role → same color every time, so tags are recognisable at a glance. */
export function roleColor(role: string): string | undefined {
	if (!theme.accent) return undefined;
	let hash = 0;
	for (const char of role.toLowerCase()) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
	return PALETTE[hash % PALETTE.length];
}

export function RoleTag({role}: {role: string}) {
	return <Text color={roleColor(role)}>[{role}]</Text>;
}
