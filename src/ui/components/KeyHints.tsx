import {Box, Text} from 'ink';
import {theme} from '../theme.js';

export type Hint = [key: string, label: string];

export function KeyHints({hints}: {hints: Hint[]}) {
	return (
		<Box paddingX={1}>
			<Text wrap="truncate">
				{hints.map(([key, label], i) => (
					<Text key={key}>
						{i > 0 ? '  ' : ''}
						<Text bold color={theme.accent}>
							{key}
						</Text>
						<Text color={theme.muted}> {label}</Text>
					</Text>
				))}
			</Text>
		</Box>
	);
}
