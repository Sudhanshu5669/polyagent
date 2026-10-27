import {Box, Text} from 'ink';
import {useKeys} from '../input.js';
import type {Detection} from '../../core/detect.js';
import type {Employee} from '../../core/employees.js';
import {tildify} from '../../core/paths.js';
import {PROVIDERS, type ProviderId} from '../../core/providers.js';
import {Frame} from '../components/Frame.js';
import {Paragraph} from '../components/Paragraph.js';
import {RoleTag} from '../components/RoleTag.js';
import {TextInput} from '../components/TextInput.js';
import {icons, theme} from '../theme.js';

interface Props {
	employees: Employee[];
	orchestrator: ProviderId;
	detections: Partial<Record<ProviderId, Detection>>;
	autoRun: boolean;
	root: string;
	branch?: string;
	/** In a git repo, employees get their own worktrees and work in parallel. */
	parallel: boolean;
	onStart: (request: string) => void;
	onBack: () => void;
}

export function NewRun({employees, orchestrator, detections, autoRun, root, branch, parallel, onStart, onBack}: Props) {
	useKeys((_, key) => {
		if (key.escape) onBack();
	});

	// Still being checked counts as available; only a finished check that came back negative blocks.
	const orchestratorMissing = detections[orchestrator] !== undefined && detections[orchestrator].status !== 'found';
	const blocked = employees.length === 0 ? 'Hire at least one employee first.' : orchestratorMissing ? `The orchestrator runs on ${PROVIDERS[orchestrator].label}, which isn't installed. Change it in Settings.` : undefined;

	return (
		<Frame title="polyagent · new run" hints={blocked ? [['esc', 'back']] : [['⏎', 'start'], ['esc', 'back']]}>
			<Text bold>What should the team do?</Text>
			<Box marginY={1}>
				{blocked ? (
					<Text color={theme.warn}>
						{icons.warn} {blocked}
					</Text>
				) : (
					<TextInput placeholder="e.g. Add a /health endpoint with tests, and show its status in the footer" onSubmit={onStart} />
				)}
			</Box>

			<Text>
				<Text color={theme.muted}>Orchestrator </Text>
				<Text color={theme.accent}>◆</Text> {PROVIDERS[orchestrator].label}
			</Text>
			<Text wrap="truncate">
				<Text color={theme.muted}>Team         </Text>
				{employees.map((e, i) => (
					<Text key={e.id}>
						{i > 0 ? '  ' : ''}
						{e.name} <RoleTag role={e.role} />
					</Text>
				))}
			</Text>
			<Box marginTop={1} flexDirection="column">
				<Paragraph color={theme.muted}>
					{`${
						parallel
							? `Each employee works in their own copy of ${tildify(root)} (a git worktree), so independent tasks run at the same time. Finished work is merged into your working tree${branch ? ` on ${branch}` : ''}.`
							: `${tildify(root)} isn't a git repository, so tasks run one at a time directly in it.`
					} Changes are left uncommitted for you to review. ${autoRun ? 'The plan starts as soon as it is made.' : 'You approve the plan before anyone starts.'}`}
				</Paragraph>
			</Box>
		</Frame>
	);
}
