import {Box, Text} from 'ink';
import type {ReactNode} from 'react';
import type {ChatEntry} from '../../core/chat.js';
import {icons, theme} from '../theme.js';
import {roleColor} from './RoleTag.js';
import {Spinner} from './Spinner.js';

export interface Row {
	key: string;
	node: ReactNode;
}

/** Word-wrap to a width, keeping blank lines. Long words are hard-split. */
export function wrapText(text: string, width: number): string[] {
	const out: string[] = [];
	const max = Math.max(10, width);
	for (const paragraph of text.replace(/\t/g, '  ').split('\n')) {
		if (paragraph.length <= max) {
			out.push(paragraph);
			continue;
		}

		let line = '';
		for (const word of paragraph.split(/(\s+)/)) {
			if (line.length + word.length <= max) {
				line += word;
				continue;
			}

			if (line.trim()) out.push(line.trimEnd());
			line = word.trimStart();
			while (line.length > max) {
				out.push(line.slice(0, max));
				line = line.slice(max);
			}
		}

		if (line.trim() || out.length === 0) out.push(line.trimEnd());
	}

	return out;
}

const TOOL_ICON: Record<string, ReactNode> = {
	done: <Text color={theme.ok}>{icons.ok}</Text>,
	failed: <Text color={theme.fail}>{icons.fail}</Text>,
	denied: <Text color={theme.warn}>⊘ blocked</Text>,
};

function formatDuration(ms: number): string {
	const s = Math.round(ms / 1000);
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function formatTokens(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function turnSummary(entry: Extract<ChatEntry, {kind: 'turn'}>): string {
	const parts = [entry.cancelled ? `stopped after ${formatDuration(entry.durationMs)}` : `${entry.ok ? 'done' : 'failed'} in ${formatDuration(entry.durationMs)}`];
	if (entry.costUsd !== undefined) parts.push(`$${entry.costUsd.toFixed(4)}`);
	if (entry.inputTokens !== undefined) parts.push(`${formatTokens(entry.inputTokens)} in`);
	if (entry.outputTokens !== undefined) parts.push(`${formatTokens(entry.outputTokens)} out`);
	return parts.join(' · ');
}

/**
 * Flatten a transcript into one-line rows so it can be scrolled by line.
 * `details` also shows thinking and tool output.
 */
export function buildRows(entries: ChatEntry[], name: string, role: string, width: number, details: boolean): Row[] {
	const rows: Row[] = [];
	const add = (key: string, node: ReactNode) => rows.push({key, node});
	const labelled = (key: string, label: ReactNode, labelWidth: number, text: string, color?: string) => {
		wrapText(text, width - labelWidth).forEach((line, i) =>
			add(`${key}-${i}`, (
				<Text>
					{i === 0 ? label : ' '.repeat(labelWidth)}
					<Text color={color}>{line}</Text>
				</Text>
			)),
		);
	};

	entries.forEach((entry, n) => {
		const key = String(n);
		switch (entry.kind) {
			case 'user':
				if (rows.length > 0) add(`${key}-gap`, <Text> </Text>);
				labelled(key, <Text bold color={theme.accent}>you › </Text>, 6, entry.text);
				break;
			case 'text': {
				const label = `${name} › `;
				labelled(key, <Text bold color={roleColor(role)}>{label}</Text>, label.length, entry.text);
				break;
			}

			case 'thinking':
				if (details) labelled(key, <Text color={theme.muted}>  ∴ </Text>, 4, entry.text, theme.muted);
				break;
			case 'tool':
				add(key, (
					<Text>
						{'  '}
						<Text color={theme.muted}>▸ {entry.name.padEnd(7)}</Text>
						{entry.summary}{' '}
						{entry.status === 'running' ? <Spinner /> : TOOL_ICON[entry.status]}
					</Text>
				));
				if (details && entry.output) {
					const lines = wrapText(entry.output.trimEnd(), width - 6);
					for (const [i, line] of lines.slice(0, 8).entries()) add(`${key}-o${i}`, <Text color={theme.muted}>{'      '}{line}</Text>);
					if (lines.length > 8) add(`${key}-more`, <Text color={theme.muted}>{'      '}… {lines.length - 8} more lines</Text>);
				}

				break;
			case 'error':
				labelled(key, <Text color={theme.fail}>  {icons.fail} </Text>, 4, entry.message, theme.fail);
				break;
			case 'note':
				labelled(key, <Text color={theme.muted}>  · </Text>, 4, entry.text, theme.muted);
				break;
			case 'turn':
				add(key, <Text color={theme.muted}>  ─ {turnSummary(entry)}</Text>);
				break;
		}
	});

	return rows;
}

/** Shows `height` rows ending `offset` rows above the bottom. */
export function Viewport({rows, height, offset}: {rows: Row[]; height: number; offset: number}) {
	const end = Math.max(0, rows.length - offset);
	const visible = rows.slice(Math.max(0, end - height), end);
	return (
		<Box flexDirection="column" height={height} justifyContent="flex-end" overflow="hidden">
			{visible.map(row => (
				<Text key={row.key} wrap="truncate">
					{row.node}
				</Text>
			))}
		</Box>
	);
}
