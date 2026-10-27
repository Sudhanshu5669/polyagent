import {Box, Text, useApp, useInput} from 'ink';
import {useState, useSyncExternalStore, type ReactNode} from 'react';
import {ADAPTERS} from '../../core/agents/runner.js';
import type {ChatHub} from '../../core/chat.js';
import type {AppContext} from '../../core/context.js';
import type {Detection} from '../../core/detect.js';
import type {BrokenEmployee, Employee} from '../../core/employees.js';
import {tildify} from '../../core/paths.js';
import {PROVIDERS, PROVIDER_IDS, type ProviderId} from '../../core/providers.js';
import {Frame} from '../components/Frame.js';
import type {Hint} from '../components/KeyHints.js';
import {Paragraph} from '../components/Paragraph.js';
import {ProviderBadges} from '../components/ProviderRows.js';
import {RoleTag} from '../components/RoleTag.js';
import {Spinner} from '../components/Spinner.js';
import {icons, theme} from '../theme.js';

interface Props {
	ctx: AppContext;
	detections: Partial<Record<ProviderId, Detection>>;
	employees: Employee[];
	broken: BrokenEmployee[];
	presets: string[];
	hub: ChatHub;
	selectedId?: string;
	onSelect: (id: string) => void;
	onChat: (employee: Employee) => void;
	onHire: () => void;
	onEdit: (employee: Employee) => void;
	onOpenFile: (file: string) => void;
	onDelete: (id: string) => void;
	onOpenSettings: () => void;
	onOpenHelp: () => void;
	notice?: ReactNode;
}

const LIST_WIDTH = 32;

export function Dashboard(props: Props) {
	const {ctx, detections, employees, broken, presets, hub, selectedId} = props;
	const {exit} = useApp();
	useSyncExternalStore(hub.subscribe, () => hub.version);
	const [confirm, setConfirm] = useState<'delete' | 'quit'>();

	const items: (Employee | BrokenEmployee)[] = [...employees, ...broken];
	const index = Math.max(0, items.findIndex(e => e.id === selectedId));
	const selected = items[index];
	const selectedEmployee = employees.find(e => e.id === selected?.id);

	useInput((input, key) => {
		if (confirm) {
			if (input === 'y') {
				if (confirm === 'delete' && selected) props.onDelete(selected.id);
				if (confirm === 'quit') {
					hub.cancelAll();
					exit();
				}
			}

			setConfirm(undefined);
			return;
		}

		const move = (delta: number) => items.length && props.onSelect(items[(index + delta + items.length) % items.length]!.id);
		if (key.upArrow || input === 'k') move(-1);
		else if (key.downArrow || input === 'j') move(1);
		else if (key.return && selectedEmployee) props.onChat(selectedEmployee);
		else if (input === 'n') props.onHire();
		else if (input === 'e' && selectedEmployee) props.onEdit(selectedEmployee);
		else if (input === 'o' && selected) props.onOpenFile(selected.file);
		else if (input === 'd' && selected) setConfirm('delete');
		else if (input === 's') props.onOpenSettings();
		else if (input === '?') props.onOpenHelp();
		else if (input === 'q') {
			if (hub.workingCount() > 0) setConfirm('quit');
			else exit();
		}
	});

	const {values} = ctx.settings;
	const branch = ctx.workspace.git?.branch;
	const checked = PROVIDER_IDS.every(id => detections[id] !== undefined);
	const noneWorking = checked && PROVIDER_IDS.every(id => detections[id]?.status !== 'found');
	const title = `polyagent · ${tildify(ctx.workspace.root)}${branch ? `  ${icons.branch} ${branch}` : ''}`;

	const hints: Hint[] = confirm
		? [['y', confirm === 'delete' ? 'remove' : 'stop them and quit'], ['any key', 'cancel']]
		: items.length === 0
			? [['n', 'hire'], ['s', 'settings'], ['?', 'help'], ['q', 'quit']]
			: [['↑↓', 'select'], ['⏎', 'chat'], ['n', 'hire'], ['e', 'edit'], ['o', 'open file'], ['d', 'remove'], ['s', 'settings'], ['?', 'help'], ['q', 'quit']];

	const working = hub.workingCount();
	const notice = confirm ? (
		<Text color={theme.warn}>
			{confirm === 'delete'
				? `Remove ${selected && 'name' in selected ? selected.name : selected?.id}? Their file and chat history are deleted.`
				: `${working} employee${working === 1 ? ' is' : 's are'} still working. Quit and stop them?`}
		</Text>
	) : noneWorking ? (
		<Text color={theme.fail}>{icons.fail} No agent CLI is working. Press s, then open Agent CLIs to fix it.</Text>
	) : (
		props.notice
	);

	return (
		<Frame title={title} right={<ProviderBadges detections={detections} />} hints={hints} notice={notice}>
			<Box flexGrow={1}>
				<Box flexDirection="column" width={LIST_WIDTH} marginRight={2}>
					<Text bold color={theme.muted}>
						EMPLOYEES{working > 0 ? <Text color={theme.accent}> · {working} working</Text> : null}
					</Text>
					{items.length === 0 ? <Text color={theme.muted}>  No employees yet</Text> : null}
					{employees.map(e => (
						<Text key={e.id} wrap="truncate">
							<Text color={theme.accent}>{e.id === selected?.id ? `${icons.pointer} ` : '  '}</Text>
							{hub.isWorking(e.id) ? <Spinner /> : <Text color={theme.muted}>{icons.dot}</Text>}{' '}
							<Text bold={e.id === selected?.id}>{e.name}</Text> <RoleTag role={e.role} />{' '}
							<Text color={theme.muted}>{PROVIDERS[e.provider].bins[0]}</Text>
						</Text>
					))}
					{broken.map(b => (
						<Text key={b.id} wrap="truncate">
							<Text color={theme.accent}>{b.id === selected?.id ? `${icons.pointer} ` : '  '}</Text>
							<Text color={theme.warn}>{icons.warn}</Text> <Text color={theme.muted}>{b.id} (can't read)</Text>
						</Text>
					))}
					<Box marginTop={1} flexDirection="column">
						<Text bold color={theme.muted}>
							PRESETS
						</Text>
						{presets.length === 0 ? (
							<Text color={theme.muted}>  No presets yet</Text>
						) : (
							presets.map(p => (
								<Text key={p} wrap="truncate">
									{'  '}
									{icons.dot} {p}
								</Text>
							))
						)}
					</Box>
				</Box>

				<Box flexDirection="column" flexGrow={1}>
					{selectedEmployee ? (
						<EmployeeDetails employee={selectedEmployee} installed={detections[selectedEmployee.provider]?.status === 'found'} working={hub.isWorking(selectedEmployee.id)} />
					) : selected ? (
						<BrokenDetails employee={selected as BrokenEmployee} />
					) : (
						<EmptyState orchestrator={PROVIDERS[values.orchestrator].label} />
					)}
				</Box>
			</Box>
		</Frame>
	);
}

function EmployeeDetails({employee, installed, working}: {employee: Employee; installed: boolean; working: boolean}) {
	const promptLines = employee.systemPrompt.split('\n').filter(l => l.trim());
	return (
		<Box flexDirection="column">
			<Text>
				<Text bold>{employee.name}</Text> <RoleTag role={employee.role} />
				{working ? (
					<Text>
						{'  '}
						<Spinner /> working
					</Text>
				) : null}
			</Text>
			<Box flexDirection="column" marginY={1} flexShrink={0}>
				<Field label="Agent CLI">
					{PROVIDERS[employee.provider].label}
					{employee.model ? ` · ${employee.model}` : ''}
					{!installed ? <Text color={theme.warn}> {icons.warn} not installed</Text> : null}
					{!ADAPTERS[employee.provider].verified ? <Text color={theme.muted}> (experimental)</Text> : null}
				</Field>
				<Field label="Permissions">{employee.permissions}</Field>
				<Field label="Works in">{employee.owns.length ? employee.owns.join(', ') : <Text color={theme.muted}>anywhere</Text>}</Field>
			</Box>
			<Section title="Summary" text={employee.summary} />
			<Section title="Briefing" text={employee.briefing} />
			<Section title="System prompt" text={promptLines.slice(0, 3).join(' ') + (promptLines.length > 3 ? ' …' : '')} />
		</Box>
	);
}

function BrokenDetails({employee}: {employee: BrokenEmployee}) {
	return (
		<Box flexDirection="column">
			<Text color={theme.warn}>
				{icons.warn} {tildify(employee.file)} can't be read
			</Text>
			<Paragraph>{employee.error}</Paragraph>
			<Box marginTop={1}>
				<Text color={theme.muted}>Press o to fix it in your editor, or d to remove it.</Text>
			</Box>
		</Box>
	);
}

function EmptyState({orchestrator}: {orchestrator: string}) {
	return (
		<Box flexDirection="column">
			<Text bold>Build your team</Text>
			<Box marginY={1} flexDirection="column">
				<Paragraph>
					{'Employees are agents with one job each: a frontend engineer, a backend engineer, a reviewer, an artist. Each one runs on the agent CLI you choose.'}
				</Paragraph>
				<Text> </Text>
				<Paragraph>{`Later, the orchestrator (${orchestrator}) will plan work and hand it to the right employees, in parallel where it can.`}</Paragraph>
			</Box>
			<Text>
				Press <Text bold color={theme.accent}>n</Text> to hire your first employee.
			</Text>
		</Box>
	);
}

function Section({title, text}: {title: string; text: string}) {
	return (
		<Box flexDirection="column" marginBottom={1} flexShrink={0}>
			<Text color={theme.muted}>{title}</Text>
			{text ? <Paragraph>{text}</Paragraph> : <Text color={theme.muted}>empty</Text>}
		</Box>
	);
}

function Field({label, children}: {label: string; children: ReactNode}) {
	return (
		<Text wrap="truncate">
			<Text color={theme.muted}>{label.padEnd(13)}</Text>
			{children}
		</Text>
	);
}
