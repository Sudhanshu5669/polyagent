import {Box, Text, useInput} from 'ink';
import {Frame} from '../components/Frame.js';
import {theme} from '../theme.js';

type Section = [title: string, keys: [string, string][]];

// Two columns so everything fits in an 80×24 terminal.
const LEFT: Section[] = [
	[
		'Everywhere',
		[
			['↑↓ j k', 'move'],
			['⏎', 'choose'],
			['esc', 'go back'],
			['?', 'this help'],
			['q', 'quit or go back'],
			['ctrl+c', 'stop employees, or quit'],
		],
	],
	[
		'Dashboard',
		[
			['n', 'hire an employee'],
			['⏎', 'chat with employee'],
			['e', 'edit'],
			['o', 'open file in $EDITOR'],
			['d', 'remove'],
			['s', 'settings'],
		],
	],
	[
		'Employee editor',
		[
			['⏎', 'edit field'],
			['ctrl+s', 'save'],
		],
	],
];

const RIGHT: Section[] = [
	[
		'Chat',
		[
			['⏎', 'send'],
			['↑↓ pgup pgdn', 'scroll'],
			['ctrl+g', 'jump to latest'],
			['ctrl+o', 'thinking + tool output'],
			['ctrl+n', 'new session'],
			['ctrl+c', 'stop the employee'],
		],
	],
	[
		'Settings',
		[
			['tab', 'switch tab'],
			['← → space', 'change value'],
			['x', 'reset to inherited'],
			['⏎', 'set CLI path'],
			['r', 're-check CLIs'],
		],
	],
];

function Column({sections}: {sections: Section[]}) {
	return (
		<Box flexDirection="column" width="50%">
			{sections.map(([title, keys]) => (
				<Box key={title} flexDirection="column" marginBottom={1} flexShrink={0}>
					<Text bold>{title}</Text>
					{keys.map(([key, label]) => (
						<Text key={key + label} wrap="truncate">
							{'  '}
							<Text color={theme.accent}>{key.padEnd(13)}</Text>
							{label}
						</Text>
					))}
				</Box>
			))}
		</Box>
	);
}

export function Help({onBack}: {onBack: () => void}) {
	useInput((input, key) => {
		if (key.escape || key.return || input === 'q' || input === '?') onBack();
	});

	return (
		<Frame title="polyagent · keys" hints={[['esc', 'back']]} notice={<Text color={theme.muted}>Scripting: polyagent doctor · polyagent config · polyagent --help</Text>}>
			<Box>
				<Column sections={LEFT} />
				<Column sections={RIGHT} />
			</Box>
		</Frame>
	);
}
