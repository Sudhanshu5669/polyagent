import {Box, Text} from 'ink';
import {useMemo, useState, type ReactNode} from 'react';
import {fuzzyScore} from '../../core/run/input.js';
import {TextInput} from '../components/TextInput.js';
import {useKeys} from '../input.js';
import {theme} from '../theme.js';

export interface PaletteItem {
	id: string;
	group: string;
	label: string;
	/** Dimmed text after the label. */
	hint?: string;
	/** Colored lead-in, e.g. an employee's glyph. */
	lead?: ReactNode;
	run: () => void;
}

interface Props {
	items: PaletteItem[];
	width: number;
	height: number;
	onClose: () => void;
}

/** People and commands beat events when the match is otherwise similar. */
const GROUP_BONUS: Record<string, number> = {Employees: 30, Tasks: 15, Commands: 10, Events: 0};

/** ^k: fuzzy search over employees, tasks, events and commands. */
export function Palette({items, width, height, onClose}: Props) {
	const [query, setQuery] = useState('');
	const [row, setRow] = useState(0);
	const results = useMemo(() => {
		const scored: {item: PaletteItem; score: number}[] = [];
		for (const item of items) {
			const score = fuzzyScore(query, `${item.label} ${item.hint ?? ''}`);
			if (score !== undefined) scored.push({item, score: score + (GROUP_BONUS[item.group] ?? 0) - (query ? 0 : scored.length * 0.001)});
		}

		// With no query, keep the given order (it is already grouped); otherwise best match first.
		return (query ? scored.sort((a, b) => b.score - a.score) : scored).map(s => s.item);
	}, [items, query]);

	const visible = Math.max(3, height - 4);
	const at = Math.min(row, Math.max(0, results.length - 1));
	const top = Math.max(0, Math.min(at - Math.floor(visible / 2), results.length - visible));
	const shown = results.slice(top, top + visible);

	useKeys((_, key) => {
		if (key.escape) return onClose();
		if (key.upArrow) setRow(r => Math.max(0, r - 1));
		else if (key.downArrow || key.tab) setRow(r => Math.min(results.length - 1, r + 1));
		else if (key.return) {
			const picked = results[at];
			if (!picked) return;
			onClose();
			picked.run();
		}
	});

	return (
		<Box flexDirection="column" width={width} height={height}>
			<Box borderStyle="round" borderColor={theme.accent} paddingX={1} width={width}>
				<TextInput
					prompt="^k › "
					placeholder="search employees, tasks, events and commands"
					onChange={q => {
						setQuery(q);
						setRow(0);
					}}
					onSubmit={() => {}}
					allowEmpty
					// Enter and escape are handled above, where the results are known.
					isActive
				/>
			</Box>
			<Box flexDirection="column" paddingLeft={1} marginTop={1} flexShrink={0}>
				{shown.map((item, i) => {
					const selected = top + i === at;
					return (
						<Box key={item.id} flexShrink={0}>
							<Text wrap="truncate">
								<Text color={theme.accent}>{selected ? '▌' : ' '}</Text> {item.lead ? <>{item.lead} </> : null}
								<Text color={selected ? theme.strong : theme.text} bold={selected}>
									{item.label}
								</Text>
								{item.hint ? <Text color={theme.dim}> {item.hint}</Text> : null}
								<Text color={theme.faint}> · {item.group.toLowerCase()}</Text>
							</Text>
						</Box>
					);
				})}
				{results.length === 0 ? <Text color={theme.dim}>Nothing matches "{query}".</Text> : null}
			</Box>
		</Box>
	);
}
