import {Box, Text, useInput, usePaste} from 'ink';
import {useState} from 'react';
import {theme} from '../theme.js';

export interface Completion {
	value: string;
	/** Other matches, shown when the completion is ambiguous. */
	candidates: string[];
}

interface Props {
	initialValue?: string;
	placeholder?: string;
	prompt?: string;
	onSubmit: (value: string) => void;
	onCancel?: () => void;
	/** Called on tab. */
	complete?: (value: string) => Promise<Completion>;
	/** Submitting an empty value is allowed (e.g. clearing an optional field). */
	allowEmpty?: boolean;
	/** Clear after submit, for chat-style inputs. */
	clearOnSubmit?: boolean;
	/** Reports every change, so parents can tell whether the input is empty. */
	onChange?: (value: string) => void;
	isActive?: boolean;
}

/**
 * Single-line input. ←→ move, ctrl+a/e or home/end jump, ctrl+w deletes a word, ctrl+u clears,
 * enter submits, esc cancels. Pasted newlines become spaces.
 */
export function TextInput({initialValue = '', placeholder, prompt = '› ', onSubmit, onCancel, complete, allowEmpty, clearOnSubmit, onChange, isActive = true}: Props) {
	const [value, setValue] = useState(initialValue);
	const [cursor, setCursor] = useState(initialValue.length);
	const [candidates, setCandidates] = useState<string[]>([]);

	const replace = (next: string, nextCursor = next.length) => {
		setValue(next);
		onChange?.(next);
		setCursor(Math.max(0, Math.min(nextCursor, next.length)));
	};

	const insert = (text: string) => replace(value.slice(0, cursor) + text + value.slice(cursor), cursor + text.length);

	usePaste(text => insert(text.replace(/\r?\n/g, ' ')), {isActive});

	useInput(
		(input, key) => {
			if (key.return) {
				if (!value.trim() && !allowEmpty) return;
				onSubmit(value.trim());
				if (clearOnSubmit) replace('');
				return;
			}

			if (key.escape) return onCancel?.();
			if (key.tab && complete) {
				void complete(value).then(result => {
					replace(result.value);
					setCandidates(result.candidates);
				});
				return;
			}

			setCandidates([]);
			if (key.leftArrow) setCursor(c => Math.max(0, c - 1));
			else if (key.rightArrow) setCursor(c => Math.min(value.length, c + 1));
			else if (key.home || (key.ctrl && input === 'a')) setCursor(0);
			else if (key.end || (key.ctrl && input === 'e')) setCursor(value.length);
			else if (key.ctrl && input === 'u') replace('');
			else if (key.ctrl && input === 'w') {
				const before = value.slice(0, cursor).replace(/\S+\s*$/, '');
				replace(before + value.slice(cursor), before.length);
			} else if (key.backspace || key.delete) {
				// Most terminals send DEL for backspace, which Ink reports as delete.
				if (cursor > 0) replace(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1);
			} else if (input && !key.ctrl && !key.meta && !key.upArrow && !key.downArrow && !key.tab && !key.pageUp && !key.pageDown) {
				insert(input);
			}
		},
		{isActive},
	);

	const atEnd = cursor >= value.length;
	return (
		<Box flexDirection="column">
			<Text wrap="truncate-start">
				<Text color={theme.accent}>{prompt}</Text>
				{value ? (
					<>
						{value.slice(0, cursor)}
						<Text inverse={isActive}>{atEnd ? ' ' : value[cursor]}</Text>
						{atEnd ? '' : value.slice(cursor + 1)}
					</>
				) : (
					<>
						<Text inverse={isActive}> </Text>
						<Text color={theme.muted}>{placeholder}</Text>
					</>
				)}
			</Text>
			{candidates.length > 0 ? (
				<Text color={theme.muted} wrap="truncate">
					{'  '}
					{candidates.slice(0, 8).join('  ')}
					{candidates.length > 8 ? `  +${candidates.length - 8} more` : ''}
				</Text>
			) : null}
		</Box>
	);
}
