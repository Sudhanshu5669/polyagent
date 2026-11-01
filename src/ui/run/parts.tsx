import {Box, Text, useWindowSize} from 'ink';
import type {ReactNode} from 'react';
import type {Employee} from '../../core/employees.js';
import {ORCHESTRATOR} from '../../core/run/types.js';
import {ApprovalBanner} from '../components/ApprovalBanner.js';
import {identities, MIN_COLUMNS, MIN_ROWS, orchestratorIdentity, theme} from '../theme.js';

/** Who someone is on screen: a glyph and a color that are always shown together with the name. */
export interface Who {
	id: string;
	glyph: string;
	color: string | undefined;
	name: string;
}

export type WhoFn = (agent: string) => Who;

export function makeWho(employees: Employee[]): WhoFn {
	const team = identities(employees.map(e => e.id));
	return agent => {
		if (agent === ORCHESTRATOR) return {id: agent, ...orchestratorIdentity(), name: 'orchestrator'};
		if (agent === 'user') return {id: agent, glyph: '›', color: theme.strong, name: 'you'};
		const employee = employees.find(e => e.id === agent);
		const identity = team.get(agent);
		return {id: agent, glyph: identity?.glyph ?? '·', color: identity?.color ?? theme.muted, name: employee?.name ?? agent};
	};
}

export function AgentTag({who, bold}: {who: Who; bold?: boolean}) {
	return (
		<Text color={who.color} bold={bold}>
			{who.glyph} {who.name}
		</Text>
	);
}

/** A progress bar: employee-colored where filled, a dim track elsewhere. Falls back to ━/─ without color. */
export function Bar({width, fraction, color}: {width: number; fraction: number; color?: string}) {
	const filled = Math.max(0, Math.min(width, Math.round(width * fraction)));
	const plain = theme.track === undefined;
	return (
		<Text>
			<Text color={color}>{'━'.repeat(filled)}</Text>
			<Text color={theme.track}>{(plain ? '─' : '━').repeat(width - filled)}</Text>
		</Text>
	);
}

/** The bar as a plain string, for rows built as one line. */
export function barText(width: number, fraction: number): {filled: string; rest: string} {
	const filled = Math.max(0, Math.min(width, Math.round(width * fraction)));
	return {filled: '━'.repeat(filled), rest: (theme.track === undefined ? '─' : '━').repeat(width - filled)};
}

export type KeyHint = [key: string, label: string];

export function HintBar({left, right = []}: {left: KeyHint[]; right?: KeyHint[]}) {
	const render = (hints: KeyHint[]) =>
		hints.map(([key, label], i) => (
			<Text key={key + label}>
				{i > 0 ? '   ' : ''}
				<Text color={theme.text}>{key}</Text>
				<Text color={theme.dim}> {label}</Text>
			</Text>
		));
	return (
		<Box>
			<Box flexGrow={1} flexShrink={1}>
				<Text wrap="truncate">{render(left)}</Text>
			</Box>
			{right.length ? (
				<Box flexShrink={0} marginLeft={2}>
					<Text>{render(right)}</Text>
				</Box>
			) : null}
		</Box>
	);
}

interface CanvasProps {
	hints: KeyHint[];
	rightHints?: KeyHint[];
	/** Lines above the hints for confirmations and warnings. */
	notice?: ReactNode;
	children: ReactNode;
}

/** The run screens' full-screen layout: open (no border), padded, hints along the bottom. */
export function Canvas({hints, rightHints, notice, children}: CanvasProps) {
	const {columns, rows} = useWindowSize();
	if (columns < MIN_COLUMNS || rows < MIN_ROWS) {
		return (
			<Box height={rows} width={columns} alignItems="center" justifyContent="center" flexDirection="column">
				<Text>Terminal too small</Text>
				<Text color={theme.muted}>
					Resize to at least {MIN_COLUMNS}×{MIN_ROWS} (now {columns}×{rows})
				</Text>
			</Box>
		);
	}

	return (
		<Box flexDirection="column" height={rows} width={columns} paddingX={2} paddingTop={1}>
			<Box flexDirection="column" flexGrow={1} overflow="hidden">
				{children}
			</Box>
			<ApprovalBanner />
			{notice ? <Box flexDirection="column">{notice}</Box> : null}
			<HintBar left={hints} right={rightHints} />
		</Box>
	);
}

/** A rule with a title: "While you were away · 18m ─────────". */
export function Rule({title, width, color = theme.strong}: {title: ReactNode; width: number; color?: string}) {
	return (
		<Box width={width}>
			<Text>
				<Text color={color}>{title}</Text>
				<Text color={theme.rule}> {'─'.repeat(Math.max(0, width - 2))}</Text>
			</Text>
		</Box>
	);
}

export function clock(at: number): string {
	const d = new Date(at);
	return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
