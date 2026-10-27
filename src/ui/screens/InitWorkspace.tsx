import {Box, Text, useApp} from 'ink';
import {useKeys} from '../input.js';
import {useState} from 'react';
import type {GitTracking} from '../../core/config.js';
import {tildify, WORKSPACE_DIRNAME} from '../../core/paths.js';
import {initWorkspace, type WorkspaceLocation} from '../../core/workspace.js';
import {Frame} from '../components/Frame.js';
import {Menu} from '../components/Menu.js';
import {icons, theme} from '../theme.js';
import {GIT_TRACKING_LABELS} from './settingsMeta.js';

interface Props {
	workspace: WorkspaceLocation;
	gitTracking: GitTracking;
	onDone: () => void;
}

/** Asks before creating .polyagent/ — we never write into a folder silently. */
export function InitWorkspace({workspace, gitTracking, onDone}: Props) {
	const {exit} = useApp();
	const [error, setError] = useState<string>();

	useKeys(input => {
		if (input === 'q') exit();
	});

	const create = async () => {
		try {
			await initWorkspace(workspace.root, gitTracking);
			onDone();
		} catch (e) {
			setError((e as Error).message);
		}
	};

	return (
		<Frame title="polyagent · set up this folder" hints={[['↑↓', 'move'], ['⏎', 'choose'], ['q', 'quit']]}>
			<Text>
				Set up polyagent in <Text bold>{tildify(workspace.root)}</Text>?
			</Text>
			<Box flexDirection="column" marginY={1}>
				<Text color={theme.muted}>
					Creates {WORKSPACE_DIRNAME}/ for this project's employees, presets and run history.
				</Text>
				<Text color={theme.muted}>
					Git: {GIT_TRACKING_LABELS[gitTracking].toLowerCase()}. Change any time in Settings → Git tracking.
				</Text>
				{workspace.git?.branch ? (
					<Text color={theme.muted}>
						Employees will work on your current branch, {workspace.git.branch}.
					</Text>
				) : null}
			</Box>
			{workspace.warnings.map(w => (
				<Text key={w} color={theme.warn}>
					{icons.warn} {w}
				</Text>
			))}
			<Box marginTop={1}>
				<Menu
					items={[
						{label: 'Yes, set it up', value: 'yes'},
						{label: 'Not now', value: 'no', hint: 'quits'},
					]}
					onSelect={v => (v === 'yes' ? void create() : exit())}
				/>
			</Box>
			{error ? <Text color={theme.fail}>{error}</Text> : null}
		</Frame>
	);
}
