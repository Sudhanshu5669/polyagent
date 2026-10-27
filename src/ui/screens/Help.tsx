import {Box, Text} from 'ink';
import {useKeys} from '../input.js';
import {Frame} from '../components/Frame.js';
import {theme} from '../theme.js';

type Section = [title: string, keys: [string, string][]];

// Two columns so everything fits in an 80×24 terminal.
const LEFT: Section[] = [
	[
		'Everywhere',
		[
			['↑↓ ⏎ esc', 'move, choose, back'],
			['?', 'this help'],
			['q', 'quit or go back'],
			['ctrl+a', 'answer an approval'],
			['ctrl+c', 'stop work, or quit'],
		],
	],
	[
		'Dashboard',
		[
			['r', 'new run / open run'],
			['n', 'hire an employee'],
			['⏎', 'chat / open past run'],
			['e  o  d', 'edit, open file, remove'],
			['s', 'settings'],
		],
	],
	[
		'Settings',
		[
			['tab', 'switch tab'],
			['← →  x', 'change, reset'],
			['⏎  r', 'set CLI path, re-check'],
		],
	],
];

const RIGHT: Section[] = [
	[
		'Run',
		[
			['⏎', 'watch, or start plan'],
			['tab', 'next agent (watching)'],
			['ctrl+t', 'task list'],
			['ctrl+p', 'pause / resume'],
			['ctrl+r', 'continue interrupted'],
			['type ⏎', 'tell the orchestrator'],
		],
	],
	[
		'Chat and watching',
		[
			['↑↓ pgup pgdn', 'scroll'],
			['ctrl+g', 'jump to latest'],
			['ctrl+o', 'more detail'],
			['ctrl+n', 'new session (chat)'],
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
	useKeys((input, key) => {
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
