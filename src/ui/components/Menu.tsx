import {Box, Text} from 'ink';
import {useKeys} from '../input.js';
import {useState} from 'react';
import {icons, theme} from '../theme.js';

export interface MenuItem<T> {
	label: string;
	value: T;
	hint?: string;
	disabled?: boolean;
}

interface Props<T> {
	items: MenuItem<T>[];
	onSelect: (value: T) => void;
	isActive?: boolean;
	initialIndex?: number;
}

/** Vertical menu: ↑↓ or j/k to move (skipping disabled items), enter to choose. */
export function Menu<T>({items, onSelect, isActive = true, initialIndex}: Props<T>) {
	const firstEnabled = Math.max(0, items.findIndex(i => !i.disabled));
	const [index, setIndex] = useState(initialIndex ?? firstEnabled);
	const current = Math.min(index, items.length - 1);
	const labelWidth = Math.max(...items.map(i => i.label.length));

	const move = (delta: number) => {
		for (let step = 1; step <= items.length; step++) {
			const next = (current + delta * step + items.length) % items.length;
			if (!items[next]?.disabled) {
				setIndex(next);
				return;
			}
		}
	};

	useKeys(
		(input, key) => {
			if (key.upArrow || input === 'k') move(-1);
			else if (key.downArrow || input === 'j') move(1);
			else if (key.return) {
				const item = items[current];
				if (item && !item.disabled) onSelect(item.value);
			}
		},
		{isActive},
	);

	return (
		<Box flexDirection="column">
			{items.map((item, i) => {
				const selected = i === current;
				return (
					<Text key={item.label} wrap="truncate">
						<Text color={theme.accent}>{selected ? `${icons.pointer} ` : '  '}</Text>
						<Text bold={selected} color={item.disabled ? theme.muted : undefined} dimColor={item.disabled}>
							{item.label}
						</Text>
						{item.hint ? <Text color={theme.muted}>{' '.repeat(labelWidth - item.label.length + 2)}{item.hint}</Text> : null}
					</Text>
				);
			})}
		</Box>
	);
}
