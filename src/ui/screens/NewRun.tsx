import {Box, Text, useInput} from 'ink';
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
	onStart: (request: string) => void;
	onBack: () => void;
}

export function NewRun({employees, orchestrator, detections, autoRun, root, branch, onStart, onBack}: Props) {
	useInput((_, key) => {
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
					{`Employees work in ${tildify(root)}${branch ? ` on ${branch}` : ''}. Changes are left uncommitted for you to review. ${
						autoRun ? 'The plan starts as soon as it is made.' : 'You approve the plan before anyone starts.'
					} For now tasks run one at a time; parallel work arrives with worktree isolation.`}
				</Paragraph>
			</Box>
		</Frame>
	);
}
