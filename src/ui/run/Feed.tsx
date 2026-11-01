import {Box, Text} from 'ink';
import {useRef, type ReactNode} from 'react';
import {formatSpan} from '../../core/run/progress.js';
import type {RunEvent} from '../../core/run/types.js';
import {wrapText} from '../components/Transcript.js';
import {theme} from '../theme.js';
import {clock, type Who, type WhoFn} from './parts.js';

export interface FeedRow {
	key: string;
	/** The event this row belongs to; undefined for section rules. */
	eventId?: number;
	node: ReactNode;
}

export interface FeedLayout {
	rows: FeedRow[];
	/** First and last row (exclusive) of each event, for keeping the selection in view. */
	spans: Map<number, {start: number; end: number}>;
	/** Events in the order they are listed, newest first. */
	order: RunEvent[];
}

interface FeedOptions {
	events: RunEvent[];
	who: WhoFn;
	width: number;
	selected?: number;
	expanded: ReadonlySet<number>;
	/** Events after this moment are "while you were away". */
	awaySince?: number;
	now: number;
}

const TIME_WIDTH = 7;

function tag(w: Who, bold = false): ReactNode {
	return (
		<Text color={w.color} bold={bold}>
			{w.glyph} {w.name}
		</Text>
	);
}

const muted = (text: string) => <Text color={theme.dim}>{text}</Text>;

/** The sentence an event is shown as. */
export function eventLine(e: RunEvent, who: WhoFn): ReactNode {
	const a = who(e.agent);
	const to = e.to ? who(e.to) : undefined;
	switch (e.kind) {
		case 'start':
			return (
				<>
					{tag(a)} started <Text color={theme.strong}>{e.text}</Text>
				</>
			);
		case 'done':
			return (
				<>
					{tag(a)} finished <Text color={theme.strong}>{e.text}</Text>
				</>
			);
		case 'failed':
			return (
				<>
					{tag(a)} <Text color={theme.fail}>failed</Text> <Text color={theme.strong}>{e.text}</Text>
				</>
			);
		case 'handoff':
			return (
				<>
					{tag(a)} {muted('→')} {to ? tag(to) : null} handoff {muted(`· ${e.text}`)}
				</>
			);
		case 'conflict':
			return (
				<>
					{tag(a)} <Text color={theme.warn}>conflict</Text> {e.text}
				</>
			);
		case 'user':
			return (
				<>
					{tag(a, true)} {muted('→')} {to ? tag(to) : null} {e.text}
				</>
			);
		case 'plan':
		case 'replan':
		case 'decision':
		case 'revision':
		case 'cancel':
		case 'finish':
		case 'merge':
		case 'pause':
		case 'resume':
		case 'hire':
		case 'fire':
			return (
				<>
					{tag(a)} {e.text}
				</>
			);
	}
}

/** Extra text under an event: always for handoffs (their message), otherwise only when expanded. */
function detailLines(e: RunEvent, width: number, expanded: boolean): string[] {
	if (!e.detail) return [];
	if (e.kind === 'handoff' && !expanded) return wrapText(e.detail, width - 4).slice(0, 3);
	return expanded ? wrapText(e.detail, width - 2) : [];
}

/** Lay the events out as one-line rows, newest first, under "while you were away" / "earlier" rules. */
export function buildFeed({events, who, width, selected, expanded, awaySince, now}: FeedOptions): FeedLayout {
	const order = [...events].reverse();
	const rows: FeedRow[] = [];
	const spans = new Map<number, {start: number; end: number}>();
	const body = Math.max(20, width - TIME_WIDTH - 2);

	const rule = (key: string, title: string) =>
		rows.push({
			key,
			node: (
				<Text wrap="truncate">
					<Text color={theme.strong}>{title}</Text>
					<Text color={theme.rule}> {'─'.repeat(Math.max(0, width - title.length - 1))}</Text>
				</Text>
			),
		});

	const add = (e: RunEvent) => {
		const start = rows.length;
		const mark = (on: boolean) => <Text color={theme.accent}>{on ? '▌' : ' '}</Text>;
		const isSelected = e.id === selected;
		const isExpanded = expanded.has(e.id);
		rows.push({
			key: `${e.id}`,
			eventId: e.id,
			node: (
				<Text wrap="truncate">
					{mark(isSelected)}
					<Text color={theme.dim}>{clock(e.at).padEnd(TIME_WIDTH - 1)}</Text> <Text color={isSelected ? theme.strong : theme.soft}>{eventLine(e, who)}</Text>
				</Text>
			),
		});

		const lines = detailLines(e, body, isExpanded);
		if (e.kind === 'handoff' && lines.length && !isExpanded) {
			// The message that was handed over, in a box, so handoffs read as the main thing in the feed.
			const inner = Math.min(Math.max(...lines.map(l => l.length)), body - 6);
			rows.push({key: `${e.id}-t`, eventId: e.id, node: <Text wrap="truncate">{mark(isSelected)}{' '.repeat(TIME_WIDTH - 1)} <Text color={theme.faint}>{`╭${'─'.repeat(inner + 2)}╮`}</Text></Text>});
			lines.forEach((line, i) =>
				rows.push({
					key: `${e.id}-q${i}`,
					eventId: e.id,
					node: (
						<Text wrap="truncate">
							{mark(isSelected)}
							{' '.repeat(TIME_WIDTH - 1)} <Text color={theme.faint}>│</Text> <Text color={theme.text}>{line.padEnd(inner)}</Text> <Text color={theme.faint}>│</Text>
						</Text>
					),
				}),
			);
			rows.push({key: `${e.id}-b`, eventId: e.id, node: <Text wrap="truncate">{mark(isSelected)}{' '.repeat(TIME_WIDTH - 1)} <Text color={theme.faint}>{`╰${'─'.repeat(inner + 2)}╯`}</Text></Text>});
		} else {
			lines.forEach((line, i) =>
				rows.push({
					key: `${e.id}-d${i}`,
					eventId: e.id,
					node: (
						<Text wrap="truncate">
							{mark(isSelected)}
							{' '.repeat(TIME_WIDTH - 1)} <Text color={theme.muted}>{line}</Text>
						</Text>
					),
				}),
			);
		}

		spans.set(e.id, {start, end: rows.length});
	};

	const fresh = awaySince === undefined ? [] : order.filter(e => e.at > awaySince);
	const older = awaySince === undefined ? order : order.filter(e => e.at <= awaySince);
	if (fresh.length) {
		rule('away', `While you were away · ${formatSpan(now - awaySince!)} · ${fresh.length} event${fresh.length === 1 ? '' : 's'}`);
		fresh.forEach(add);
	}

	if (older.length) {
		rule('earlier', fresh.length ? 'Earlier' : `Activity · ${older.length} event${older.length === 1 ? '' : 's'}`);
		older.forEach(add);
	}

	if (rows.length === 0) rows.push({key: 'empty', node: <Text color={theme.dim}>Nothing has happened yet.</Text>});
	return {rows, spans, order: [...fresh, ...older]};
}

/** Shows a window of rows and keeps the selected event inside it. */
export function FeedView({layout, selected, height}: {layout: FeedLayout; selected?: number; height: number}) {
	const top = useRef(0);
	const total = layout.rows.length;
	const span = selected === undefined ? undefined : layout.spans.get(selected);
	let at = top.current;
	if (span) {
		if (span.start < at) at = span.start;
		else if (span.end > at + height) at = Math.min(span.start, span.end - height);
	}

	at = Math.max(0, Math.min(at, Math.max(0, total - height)));
	top.current = at;
	return (
		<Box flexDirection="column" height={height} overflow="hidden">
			{layout.rows.slice(at, at + height).map(row => (
				<Box key={row.key} flexShrink={0}>
					{row.node}
				</Box>
			))}
		</Box>
	);
}
