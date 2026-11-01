import {Box, Text} from 'ink';
import {useState} from 'react';
import type {Employee} from '../../core/employees.js';
import {suggest} from '../../core/run/input.js';
import {TextInput} from '../components/TextInput.js';
import {theme} from '../theme.js';
import type {Who} from './parts.js';

interface Props {
	/** Typing (insert mode) or just showing the placeholder (normal mode). */
	typing: boolean;
	employees: Employee[];
	/** Who plain text goes to: the orchestrator, or the employee being watched. */
	target: Who;
	placeholder: string;
	/** Text to start with, e.g. "@" or "/". */
	initial?: string;
	onSubmit: (text: string) => void;
	/** Every change to what is typed, so the screen can leave room for the suggestions. */
	onDraft?: (text: string) => void;
	/** esc: back to normal mode. */
	onExit: () => void;
	width: number;
	/** The run has ended or was interrupted: say so instead of taking input. */
	disabled?: string;
}

/** The one prompt: plain text, @employee, /command. Normal mode shows it at rest; insert mode takes input. */
export function Prompt({typing, employees, target, placeholder, initial = '', onSubmit, onDraft, onExit, width, disabled}: Props) {
	const [draft, setDraft] = useState(initial);
	const active = typing && !disabled;
	const suggestions = active ? suggest(draft, employees).slice(0, 5) : [];
	const prompt = target.id === 'orchestrator' ? '› ' : `${target.glyph} › `;
	return (
		<Box flexDirection="column" width={width}>
			{suggestions.length ? (
				<Box flexDirection="column" paddingLeft={2}>
					{suggestions.map((s, i) => (
						<Text key={s.value} wrap="truncate">
							<Text color={i === 0 ? theme.strong : theme.soft}>{s.label.padEnd(18)}</Text>
							<Text color={theme.dim}>{s.hint}</Text>
							{i === 0 ? <Text color={theme.faint}> tab</Text> : null}
						</Text>
					))}
				</Box>
			) : null}
			<Box borderStyle="round" borderColor={active ? target.color : theme.faint} paddingX={1} width={width}>
				{disabled ? (
					<Text color={theme.dim}>{disabled}</Text>
				) : active ? (
					<TextInput
						initialValue={initial}
						prompt={prompt}
						promptColor={target.color}
						placeholder={placeholder}
						onChange={text => {
							setDraft(text);
							onDraft?.(text);
						}}
						onSubmit={text => {
							setDraft('');
							onDraft?.('');
							onSubmit(text);
						}}
						onCancel={onExit}
						complete={async value => {
							const first = suggest(value, employees)[0];
							return {value: first?.value ?? value, candidates: []};
						}}
						clearOnSubmit
					/>
				) : (
					<Text wrap="truncate">
						<Text color={target.color}>{prompt}</Text>
						<Text color={theme.dim}>{placeholder}</Text>
					</Text>
				)}
			</Box>
		</Box>
	);
}
