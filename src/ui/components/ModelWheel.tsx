import {Box, Text} from 'ink';
import {useKeys} from '../input.js';
import {useState} from 'react';
import type {ModelOption} from '../../core/models.js';
import type {ModelList} from '../useModels.js';
import {icons, theme} from '../theme.js';
import {Spinner} from './Spinner.js';
import {TextInput} from './TextInput.js';

/** Rows shown at once; the selection stays in the middle as the list turns. */
const VISIBLE = 7;
const OTHER = Symbol('other');

interface WheelItem {
	value: string | typeof OTHER;
	text: string;
	hint?: string;
}

/** Everything the wheel offers: the CLI default, the listed models, the current value if the CLI no longer lists it, and a way to type one. */
export function wheelItems(list: ModelList, current: string): WheelItem[] {
	const models: ModelOption[] = list.status === 'ready' ? list.models : [];
	const items: WheelItem[] = [
		{value: '', text: 'CLI default', hint: "Whatever the CLI picks when no model is given"},
		...models.map(m => ({value: m.id, text: m.label ?? m.id, hint: m.hint ?? (m.label ? m.id : undefined)})),
	];
	if (current && !models.some(m => m.id === current)) items.push({value: current, text: current, hint: 'current, not listed by the CLI'});
	items.push({value: OTHER, text: 'Other…', hint: 'Type a model name'});
	return items;
}

/** The model ids the ←→ keys step through on a form row: the default, then each listed model. */
export function cycleModels(list: ModelList): string[] {
	return ['', ...(list.status === 'ready' ? list.models.map(m => m.id) : [])];
}

interface Props {
	list: ModelList;
	/** The CLI's name, for status messages. */
	cli: string;
	/** '' = the CLI's default. */
	value: string;
	onSubmit: (model: string) => void;
	onCancel: () => void;
}

/** Pick a model from what the CLI reports: ↑↓ turn the wheel, ⏎ chooses, esc cancels. */
export function ModelWheel({list, cli, value, onSubmit, onCancel}: Props) {
	const items = wheelItems(list, value);
	const [index, setIndex] = useState(() => Math.max(0, items.findIndex(i => i.value === value)));
	const [typing, setTyping] = useState(false);
	const current = Math.min(index, items.length - 1);

	// Follow the current value once the list arrives, unless the user has already moved.
	const [settled, setSettled] = useState(list.status !== 'loading');
	if (!settled && list.status !== 'loading') {
		setSettled(true);
		setIndex(Math.max(0, items.findIndex(i => i.value === value)));
	}

	useKeys(
		(input, key) => {
			if (key.escape) return onCancel();
			if (key.upArrow || input === 'k') {
				setSettled(true);
				setIndex((current - 1 + items.length) % items.length);
			} else if (key.downArrow || input === 'j') {
				setSettled(true);
				setIndex((current + 1) % items.length);
			} else if (key.return) {
				const item = items[current]!;
				if (item.value === OTHER) setTyping(true);
				else onSubmit(item.value);
			}
		},
		{isActive: !typing},
	);

	if (typing) {
		return (
			<Box flexDirection="column">
				<TextInput prompt="› " initialValue={value} allowEmpty placeholder="model name, empty for the CLI default" onSubmit={onSubmit} onCancel={() => setTyping(false)} />
				<Text color={theme.muted}>Any name {cli} accepts for --model.</Text>
			</Box>
		);
	}

	const start = items.length <= VISIBLE ? 0 : Math.min(Math.max(0, current - Math.floor(VISIBLE / 2)), items.length - VISIBLE);
	const shown = items.slice(start, start + VISIBLE);
	const textWidth = Math.max(...shown.map(i => i.text.length));

	return (
		<Box flexDirection="column">
			<Text color={theme.muted}>{start > 0 ? `  ↑ ${start} more` : ' '}</Text>
			{shown.map((item, i) => {
				const distance = Math.abs(start + i - current);
				return (
					<Text key={typeof item.value === 'string' ? `m:${item.value}` : 'other'} wrap="truncate">
						<Text color={theme.accent}>{distance === 0 ? `${icons.pointer} ` : '  '}</Text>
						<Text bold={distance === 0} color={distance === 0 ? theme.accent : undefined} dimColor={distance > 1}>
							{item.text.padEnd(textWidth)}
						</Text>
						{item.hint ? <Text color={theme.muted} dimColor={distance > 1}>  {item.hint}</Text> : null}
					</Text>
				);
			})}
			<Text color={theme.muted}>{start + VISIBLE < items.length ? `  ↓ ${items.length - start - VISIBLE} more` : ' '}</Text>
			{list.status === 'loading' ? (
				<Text>
					<Spinner /> Asking {cli} for its models…
				</Text>
			) : list.status === 'failed' ? (
				<Text color={theme.warn}>
					{icons.warn} Couldn't list {cli}'s models ({list.error}). Choose Other… to type one.
				</Text>
			) : list.status === 'unavailable' ? (
				<Text color={theme.warn}>
					{icons.warn} {cli} isn't installed, so its models can't be listed. Choose Other… to type one.
				</Text>
			) : null}
		</Box>
	);
}
