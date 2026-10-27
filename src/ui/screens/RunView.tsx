import {Box, Text, useAnimation, useInput, useWindowSize} from 'ink';
import {useEffect, useMemo, useState, useSyncExternalStore, type ReactNode} from 'react';
import type {Employee} from '../../core/employees.js';
import {PROVIDERS} from '../../core/providers.js';
import type {RunEngine} from '../../core/run/engine.js';
import {isFinished, ORCHESTRATOR, type RunState, type Task, type TaskStatus} from '../../core/run/types.js';
import {Frame} from '../components/Frame.js';
import type {Hint} from '../components/KeyHints.js';
import {Paragraph} from '../components/Paragraph.js';
import {RoleTag} from '../components/RoleTag.js';
import {Spinner} from '../components/Spinner.js';
import {TextInput} from '../components/TextInput.js';
import {buildRows, Viewport} from '../components/Transcript.js';
import {icons, theme} from '../theme.js';

type Mode = 'overview' | 'watch' | 'tasks';

interface Props {
	run: RunEngine;
	onBack: () => void;
}

export function formatElapsed(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const pad = (n: number) => String(n).padStart(2, '0');
	return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

const TASK_ICON: Record<TaskStatus, ReactNode> = {
	blocked: <Text color={theme.muted}>◷</Text>,
	ready: <Text color={theme.muted}>◷</Text>,
	running: <Spinner />,
	done: <Text color={theme.ok}>{icons.ok}</Text>,
	failed: <Text color={theme.fail}>{icons.fail}</Text>,
	cancelled: <Text color={theme.muted}>⊘</Text>,
};

type EmployeeStatus = {label: string; icon: ReactNode; task?: Task; since?: number};

/** What an employee is doing right now, from their tasks in this run. */
function employeeStatus(employee: Employee, tasks: Task[]): EmployeeStatus {
	const mine = tasks.filter(t => t.assignee === employee.id);
	const running = mine.find(t => t.status === 'running');
	if (running) return {label: 'working', icon: <Spinner />, task: running, since: running.startedAt};
	const waiting = mine.find(t => t.status === 'ready' || t.status === 'blocked');
	if (waiting) return {label: waiting.status === 'ready' ? 'queued' : 'waiting', icon: TASK_ICON.blocked, task: waiting};
	const last = mine.at(-1);
	if (last?.status === 'failed') return {label: 'failed', icon: TASK_ICON.failed, task: last};
	if (last?.status === 'done') return {label: 'done', icon: TASK_ICON.done, task: last};
	return {label: 'idle', icon: <Text color={theme.muted}>{icons.dot}</Text>};
}

function orchestratorStatus(state: RunState): string {
	if (state.status === 'planning') return 'planning';
	if (state.status === 'awaiting-approval') return 'waiting for your approval';
	if (state.orchestrator.working) return 'reviewing';
	if (isFinished(state.status)) return state.status;
	return 'waiting for employees';
}

export function RunView({run, onBack}: Props) {
	useSyncExternalStore(run.subscribe, () => run.version);
	// Ticks once a second for the clocks.
	useAnimation({interval: 1000, isActive: !isFinished(run.state.status)});
	const {columns, rows} = useWindowSize();
	const {state} = run;

	const [mode, setMode] = useState<Mode>('overview');
	const [selected, setSelected] = useState(0);
	const [taskRow, setTaskRow] = useState(0);
	const [offset, setOffset] = useState(0);
	const [details, setDetails] = useState(false);
	const [draft, setDraft] = useState('');

	// Employees with work in this run come first.
	const roster = useMemo(() => {
		const involved = new Set(state.tasks.map(t => t.assignee));
		return [...run.employees.filter(e => involved.has(e.id)), ...run.employees.filter(e => !involved.has(e.id))];
	}, [run.employees, state.tasks.length]);
	const agents = [ORCHESTRATOR, ...roster.map(e => e.id)];
	const agentId = agents[Math.min(selected, agents.length - 1)]!;
	const agentEmployee = roster.find(e => e.id === agentId);

	const width = columns - 4;
	const finished = isFinished(state.status);
	const awaiting = state.status === 'awaiting-approval';
	const page = Math.max(1, rows - 12);

	useEffect(() => setOffset(0), [agentId, mode]);

	useInput((input, key) => {
		const empty = draft.trim() === '';
		if (key.ctrl && input === 't') return setMode(m => (m === 'tasks' ? 'overview' : 'tasks'));
		if (key.ctrl && input === 'o') return setDetails(d => !d);

		if (mode === 'overview') {
			if (key.escape) return onBack();
			if (key.upArrow) setSelected(s => (s - 1 + agents.length) % agents.length);
			else if (key.downArrow) setSelected(s => (s + 1) % agents.length);
			else if (key.return && empty) {
				if (awaiting) run.approve();
				else setMode('watch');
			}

			return;
		}

		if (mode === 'watch') {
			if (key.escape) return setMode('overview');
			if (key.tab) setSelected(s => (s + (key.shift ? -1 : 1) + agents.length) % agents.length);
			else if (key.upArrow) setOffset(o => o + 1);
			else if (key.downArrow) setOffset(o => Math.max(0, o - 1));
			else if (key.pageUp) setOffset(o => o + page);
			else if (key.pageDown) setOffset(o => Math.max(0, o - page));
			else if (key.ctrl && input === 'g') setOffset(0);
			return;
		}

		if (key.escape) return setMode('overview');
		if (key.upArrow) setTaskRow(r => Math.max(0, r - 1));
		else if (key.downArrow) setTaskRow(r => Math.min(state.tasks.length - 1, r + 1));
	});

	const tell = (text: string) => {
		const prefix = mode === 'watch' && agentEmployee ? `(about ${agentEmployee.name}) ` : '';
		run.tell(prefix + text);
	};

	const counts = {
		working: state.tasks.filter(t => t.status === 'running').length,
		waiting: state.tasks.filter(t => t.status === 'blocked' || t.status === 'ready').length,
		done: state.tasks.filter(t => t.status === 'done').length,
	};
	const elapsed = formatElapsed((state.endedAt ?? Date.now()) - state.createdAt);
	const right = (
		<Text color={theme.muted}>
			{finished ? state.status : `${counts.working} working · ${counts.waiting} waiting`} · {elapsed}
			{state.costUsd > 0 ? ` · $${state.costUsd.toFixed(2)}` : ''}
		</Text>
	);

	const hints: Hint[] =
		mode === 'watch'
			? [['tab', 'next agent'], ['↑↓ pgup pgdn', 'scroll'], ['ctrl+o', details ? 'less' : 'details'], ['ctrl+t', 'tasks'], ['esc', 'overview']]
			: mode === 'tasks'
				? [['↑↓', 'select'], ['ctrl+t', 'close'], ['esc', 'overview']]
				: awaiting
					? [['⏎', 'start the plan'], ['type', 'ask for changes'], ['ctrl+c', 'cancel run'], ['esc', 'dashboard']]
					: [['↑↓', 'select'], ['⏎', 'watch'], ['ctrl+t', 'tasks'], ...(finished ? [] : ([['ctrl+c', 'stop run']] as Hint[])), ['esc', 'dashboard']];

	const input = finished ? (
		<Text color={theme.muted}>This run has ended.</Text>
	) : (
		<TextInput
			placeholder={mode === 'watch' && agentEmployee ? `Tell the orchestrator about ${agentEmployee.name}` : 'Tell the orchestrator something'}
			onSubmit={tell}
			onChange={setDraft}
			clearOnSubmit
		/>
	);

	const title = `run · ${state.request.replace(/\s+/g, ' ')}`;

	if (mode === 'watch') {
		const name = agentEmployee?.name ?? 'Orchestrator';
		const task = agentEmployee ? employeeStatus(agentEmployee, state.tasks).task : undefined;
		const height = Math.max(3, rows - 7);
		const allRows = buildRows(run.logs[agentId] ?? [], name, agentEmployee?.role ?? 'orchestrator', width, details);
		const clamped = Math.min(offset, Math.max(0, allRows.length - height));
		return (
			<Frame
				title={`${name} · ${agentEmployee ? PROVIDERS[agentEmployee.provider].label : PROVIDERS[state.orchestrator.provider].label}${task ? ` · ${task.title}` : ''}`}
				right={
					<Text>
						{agentEmployee ? <RoleTag role={agentEmployee.role} /> : <Text color={theme.accent}>◆ orchestrator</Text>}
						<Text color={theme.muted}>
							{' '}
							{selected + 1}/{agents.length}
						</Text>
					</Text>
				}
				hints={hints}
			>
				{allRows.length ? (
					<Viewport rows={allRows} height={height} offset={clamped} />
				) : (
					<Box height={height}>
						<Text color={theme.muted}>
							{task?.status === 'blocked'
								? `${name}'s task "${task.title}" starts when ${task.dependsOn.join(', ')} ${task.dependsOn.length > 1 ? 'are' : 'is'} done.`
								: task?.status === 'ready'
									? `${name}'s task "${task.title}" is queued and starts when a slot frees up.`
									: agentEmployee
										? `${name} hasn't been given any work in this run.`
										: 'The orchestrator is starting up.'}
						</Text>
					</Box>
				)}
				<Text color={theme.border}>{'─'.repeat(width)}</Text>
				{input}
			</Frame>
		);
	}

	if (mode === 'tasks') {
		const task = state.tasks[Math.min(taskRow, state.tasks.length - 1)];
		const nameOf = (id: string) => run.employees.find(e => e.id === id)?.name ?? id;
		return (
			<Frame title={`${title} · tasks`} right={right} hints={hints}>
				{state.tasks.length === 0 ? <Text color={theme.muted}>No tasks yet. The orchestrator is still planning.</Text> : null}
				{state.tasks.map((t, i) => (
					<Text key={t.id} wrap="truncate">
						<Text color={theme.accent}>{i === taskRow ? `${icons.pointer} ` : '  '}</Text>
						{TASK_ICON[t.status]} <Text bold={i === taskRow}>{t.id.padEnd(16)}</Text> {nameOf(t.assignee).padEnd(10)} {t.title}
						<Text color={theme.muted}>
							{t.dependsOn.length ? `  after ${t.dependsOn.join(', ')}` : ''}
							{t.revisions ? `  revised ${t.revisions}×` : ''}
						</Text>
					</Text>
				))}
				{task ? (
					<Box flexDirection="column" marginTop={1}>
						<Text color={theme.muted}>Brief</Text>
						<Paragraph>{clip(task.brief, 6, width)}</Paragraph>
						{task.report || task.error ? (
							<>
								<Text color={theme.muted}>{task.error ? 'Error' : 'Report'}</Text>
								<Paragraph color={task.error ? theme.fail : undefined}>{clip(task.error ?? task.report ?? '', 6, width)}</Paragraph>
							</>
						) : null}
					</Box>
				) : null}
			</Frame>
		);
	}

	// Overview
	const tail = buildRows(run.logs[agentId] ?? [], agentEmployee?.name ?? 'Orchestrator', agentEmployee?.role ?? 'orchestrator', width - 2, false).slice(-3);
	return (
		<Frame title={title} right={right} hints={hints} notice={awaiting ? <Text color={theme.warn}>Review the plan below. ⏎ starts it; type to ask the orchestrator for changes.</Text> : undefined}>
			<Text wrap="truncate">
				<Text color={theme.accent}>{selected === 0 ? `${icons.pointer} ` : '  '}</Text>
				<Text bold color={theme.accent}>
					◆ ORCHESTRATOR
				</Text>
				<Text color={theme.muted}> {PROVIDERS[state.orchestrator.provider].bins[0]} </Text>
				{state.orchestrator.working ? <Spinner /> : null} {orchestratorStatus(state)}
				<Text color={theme.muted}>
					{' '}
					· {counts.done}/{state.tasks.length} tasks done
				</Text>
			</Text>
			{state.orchestrator.note ? (
				<Text color={theme.muted} wrap="truncate">
					{'    '}
					{state.orchestrator.note}
				</Text>
			) : null}

			<Box marginTop={1} flexDirection="column" flexShrink={0}>
				<Text color={theme.muted} wrap="truncate">
					{'    '}
					{'EMPLOYEE'.padEnd(11)}
					{'CLI'.padEnd(8)}
					{'ROLE'.padEnd(14)}
					{'STATUS'.padEnd(11)}TASK
				</Text>
				{roster.map((e, i) => {
					const status = employeeStatus(e, state.tasks);
					const isSelected = selected === i + 1;
					const role = `[${e.role}]`;
					return (
						<Text key={e.id} wrap="truncate" dimColor={status.label === 'idle'}>
							<Text color={theme.accent}>{isSelected ? `${icons.pointer} ` : '  '}</Text>
							{status.icon} <Text bold={isSelected}>{e.name.slice(0, 10).padEnd(11)}</Text>
							<Text color={theme.muted}>{PROVIDERS[e.provider].bins[0]!.padEnd(8)}</Text>
							<RoleTag role={e.role} />
							{' '.repeat(Math.max(1, 14 - role.length))}
							{status.label.padEnd(11)}
							{status.task ? status.task.title : ''}
							<Text color={theme.muted}>{status.since ? `  ${formatElapsed(Date.now() - status.since)}` : ''}</Text>
						</Text>
					);
				})}
			</Box>

			<Box marginTop={1} flexDirection="column" flexShrink={0}>
				<Text color={theme.muted}>── {agentEmployee?.name ?? 'Orchestrator'} ──</Text>
				{tail.length ? tail.map(r => <Text key={r.key} wrap="truncate">{r.node}</Text>) : <Text color={theme.muted}>Nothing yet.</Text>}
			</Box>

			<Box marginTop={1} flexDirection="column" flexShrink={0}>
				{finished ? (
					<>
						<Text>
							{state.status === 'done' ? <Text color={theme.ok}>{icons.ok} Done</Text> : state.status === 'failed' ? <Text color={theme.fail}>{icons.fail} Failed</Text> : <Text color={theme.muted}>⊘ Stopped</Text>}
							<Text color={theme.muted}> after {elapsed}</Text>
						</Text>
						{state.summary ? <Paragraph>{state.summary}</Paragraph> : null}
					</>
				) : (
					<Text wrap="truncate">
						<Text color={theme.muted}>TASKS </Text>
						{state.tasks.length === 0 ? <Text color={theme.muted}>planning…</Text> : null}
						{state.tasks.map(t => (
							<Text key={t.id}>
								{' '}
								{TASK_ICON[t.status]} {t.id}
							</Text>
						))}
					</Text>
				)}
			</Box>

			<Box flexGrow={1} />
			<Text color={theme.border}>{'─'.repeat(width)}</Text>
			{input}
		</Frame>
	);
}

function clip(text: string, lines: number, width: number): string {
	const all = text.split('\n').flatMap(l => (l.length > width ? l.match(new RegExp(`.{1,${width}}`, 'g')) ?? [l] : [l]));
	return all.length > lines ? `${all.slice(0, lines).join('\n')}\n…` : text;
}
