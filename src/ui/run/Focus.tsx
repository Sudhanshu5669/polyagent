import {Box, Text, type DOMElement} from 'ink';
import {useEffect, useState, type ReactNode, type Ref} from 'react';
import {PROVIDERS} from '../../core/providers.js';
import type {RunEngine} from '../../core/run/engine.js';
import {diffStats, formatSpan, formatTokens, isTestRun, laneProgress, laneState, parseTestCounts} from '../../core/run/progress.js';
import {isFinished, ORCHESTRATOR, type Task} from '../../core/run/types.js';
import type {ChatEntry} from '../../core/transcript.js';
import {Spinner} from '../components/Spinner.js';
import {buildRows, wrapText, type Row} from '../components/Transcript.js';
import {statusGlyph, theme} from '../theme.js';
import {lanesFor, orchestratorLabel} from './Lanes.js';
import type {WhoFn} from './parts.js';

export type Tab = 'stream' | 'diff' | 'tests' | 'chat';
export const TABS: Tab[] = ['stream', 'diff', 'tests', 'chat'];

/** The orchestrator has no files or tests of its own. */
export function tabsFor(agent: string): Tab[] {
	return agent === ORCHESTRATOR ? ['stream', 'chat'] : TABS;
}

export const SIDEBAR_MIN = 18;
export const SIDEBAR_MAX = 44;

// ── content ────────────────────────────────────────────────────────────────

const text = (key: string, node: ReactNode): Row => ({key, node});

export function diffRows(patch: string, width: number): Row[] {
	const stats = new Map(diffStats(patch).map(s => [s.file, s]));
	const rows: Row[] = [];
	patch.split('\n').forEach((line, i) => {
		const key = `d${i}`;
		const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
		if (header) {
			const s = stats.get(header[2]!);
			if (rows.length) rows.push(text(`${key}-gap`, <Text> </Text>));
			rows.push(
				text(
					key,
					<Text>
						<Text bold color={theme.strong}>
							{header[2]}
						</Text>
						{s ? (
							<Text>
								{'  '}
								<Text color={theme.ok}>+{s.added}</Text> <Text color={theme.fail}>−{s.removed}</Text>
							</Text>
						) : null}
					</Text>,
				),
			);
		} else if (/^(index |--- |\+\+\+ |new file mode|deleted file mode|old mode|new mode|similarity|rename |Binary)/.test(line)) {
			if (line.startsWith('Binary')) rows.push(text(key, <Text color={theme.dim}>  {line}</Text>));
		} else if (line.startsWith('@@')) rows.push(text(key, <Text color={theme.dim}>  {line.slice(0, Math.max(10, width - 2))}</Text>));
		else if (line.startsWith('+')) rows.push(text(key, <Text color={theme.ok}>{`  ${line}`}</Text>));
		else if (line.startsWith('-')) rows.push(text(key, <Text color={theme.fail}>{`  ${line}`}</Text>));
		else if (line.trim() || line.startsWith(' ')) rows.push(text(key, <Text color={theme.muted}>{`  ${line}`}</Text>));
	});
	return rows;
}

const FAILING = /\b(FAIL|FAILED|ERROR|Error|✗|×|AssertionError)\b|^\s*●/;

export function testRows(log: ChatEntry[], width: number): Row[] {
	const runs = log.filter(isTestRun).reverse();
	const rows: Row[] = [];
	runs.forEach((entry, n) => {
		const counts = parseTestCounts(entry.output);
		const icon = entry.status === 'running' ? <Spinner /> : entry.status === 'done' && !counts?.failed ? <Text color={theme.ok}>✓</Text> : <Text color={theme.fail}>✗</Text>;
		if (n > 0) rows.push(text(`t${n}-gap`, <Text> </Text>));
		rows.push(
			text(
				`t${n}`,
				<Text>
					{icon} <Text color={theme.strong}>{entry.summary}</Text>
					{counts ? (
						<Text color={theme.muted}>
							{'  '}
							{counts.passed}
							{counts.total ? ` / ${counts.total}` : ''} passing{counts.failed ? <Text color={theme.fail}>{` · ${counts.failed} failing`}</Text> : null}
						</Text>
					) : null}
				</Text>,
			),
		);
		// Only the latest run shows its output; older ones are a line each.
		if (n === 0 && entry.output) {
			const lines = wrapText(entry.output.trimEnd(), width - 4).slice(-16);
			lines.forEach((line, i) => rows.push(text(`t${n}-o${i}`, <Text color={FAILING.test(line) ? theme.fail : theme.muted}>{`    ${line}`}</Text>)));
		}
	});
	return rows;
}

export function chatRows(log: ChatEntry[], name: string, role: string, width: number): Row[] {
	return buildRows(
		log.filter(e => e.kind === 'user' || e.kind === 'text' || e.kind === 'brief' || e.kind === 'error'),
		name,
		role,
		width,
		false,
	);
}

/** Which task's changes to show for an employee: the one running, else the latest that changed files. */
export function diffTask(tasks: Task[], employeeId: string): Task | undefined {
	const mine = tasks.filter(t => t.assignee === employeeId);
	return mine.find(t => t.status === 'running') ?? [...mine].reverse().find(t => t.patch);
}

// ── sidebar ────────────────────────────────────────────────────────────────

export function Sidebar({run, who, selected, width, height, now}: {run: RunEngine; who: WhoFn; selected: string; width: number; height: number; now: number}) {
	const {state} = run;
	const lanes = lanesFor(run);
	const inner = width - 2;
	const worktrees = state.tasks.filter(t => t.files?.length || t.status === 'running').slice(-6);
	return (
		<Box flexDirection="column" width={width} height={height} flexShrink={0} paddingRight={1}>
			<Text color={theme.faint}>EMPLOYEES</Text>
			{lanes.map(lane => {
				const w = who(lane.agent);
				const isSelected = lane.agent === selected;
				let glyph: ReactNode;
				let line: string;
				if (lane.employee) {
					const s = laneState(lane.agent, state.tasks, run.logs[lane.agent] ?? []);
					glyph = s.kind === 'working' || s.kind === 'attention' ? <Spinner color={w.color} /> : <Text color={theme.dim}>{s.kind === 'done' ? statusGlyph.done : s.kind === 'stuck' ? statusGlyph.stuck : s.kind === 'idle' ? statusGlyph.idle : statusGlyph.waiting}</Text>;
					line = s.kind === 'working' ? (s.task?.title ?? 'working') : s.kind === 'waiting' ? `waiting${s.on ? ` · ${who(s.on).name}` : ''}` : s.kind === 'done' ? 'done' : s.kind === 'stuck' ? 'stuck' : s.kind === 'attention' ? 'needs you' : s.kind;
				} else {
					glyph = run.state.orchestrator.working ? <Spinner color={w.color} /> : <Text color={theme.dim}>{statusGlyph.idle}</Text>;
					line = orchestratorLabel(state, run.interrupted);
				}

				return (
					<Box key={lane.agent} flexDirection="column" flexShrink={0} width={inner}>
						<Text wrap="truncate">
							<Text color={theme.accent}>{isSelected ? '▌' : ' '}</Text>
							<Text color={w.color} bold={isSelected}>{`${w.glyph} ${w.name}`}</Text> {glyph}
						</Text>
						<Text wrap="truncate" color={isSelected ? theme.soft : theme.dim}>
							{'  '}
							{line}
						</Text>
					</Box>
				);
			})}
			{worktrees.length ? (
				<Box flexDirection="column" marginTop={1} flexShrink={0}>
					<Text color={theme.faint}>WORKTREES</Text>
					{worktrees.map(t => {
						const w = who(t.assignee);
						const added = t.patch ? diffStats(t.patch).reduce((n, s) => n + s.added, 0) : 0;
						return (
							<Text key={t.id} wrap="truncate" color={theme.muted}>
								⎇ {t.id} {t.status === 'done' ? <Text color={theme.strong}>merged</Text> : t.conflicts?.length ? <Text color={theme.warn}>clash</Text> : added ? <Text color={w.color}>+{added}</Text> : null}
							</Text>
						);
					})}
				</Box>
			) : null}
			<Box flexGrow={1} />
			<Text color={theme.dim} wrap="truncate">
				{state.costUsd > 0 ? `$${state.costUsd.toFixed(2)} · ` : ''}
				{formatTokens(state.tokens)} tok · {formatSpan((state.endedAt ?? now) - state.createdAt)}
			</Text>
		</Box>
	);
}

// ── main pane ──────────────────────────────────────────────────────────────

interface FocusProps {
	run: RunEngine;
	who: WhoFn;
	agent: string;
	tab: Tab;
	/** Rows scrolled up from the end (stream, tests, chat) or down from the start (diff). */
	offset: number;
	details: boolean;
	width: number;
	height: number;
	now: number;
	tabsRef?: Ref<DOMElement>;
}

/** Where each tab label sits, as offsets from the left edge of the bar, for clicks. */
export function tabOffsets(agent: string): {tab: Tab; start: number; end: number}[] {
	let at = 0;
	return tabsFor(agent).map(tab => {
		const start = at + 1; // each tab has one column of margin before it
		at = start + tab.length + 2;
		return {tab, start, end: at};
	});
}

export function TabBar({agent, tab, barRef}: {agent: string; tab: Tab; barRef?: Ref<DOMElement>}) {
	return (
		<Box ref={barRef}>
			{tabsFor(agent).map(t => (
				<Box key={t} marginLeft={1}>
					<Text backgroundColor={t === tab ? theme.rule : undefined} color={t === tab ? theme.strong : theme.dim}>
						{` ${t} `}
					</Text>
				</Box>
			))}
		</Box>
	);
}

/** Rows for the current tab, and whether they scroll from the top (a diff) or stick to the bottom. */
export function useTabRows(run: RunEngine, agent: string, tab: Tab, width: number, details: boolean): {rows: Row[]; fromTop: boolean; empty: string} {
	const [live, setLive] = useState<string>();
	const task = diffTask(run.state.tasks, agent);
	const running = task?.status === 'running';
	const active = tab === 'diff' && running && !isFinished(run.state.status);
	useEffect(() => {
		if (!active) return;
		let stop = false;
		const load = () => void run.liveDiff(agent).then(d => !stop && setLive(d));
		load();
		const timer = setInterval(load, 3000);
		return () => {
			stop = true;
			clearInterval(timer);
		};
	}, [active, agent, run]);

	const log = run.logs[agent] ?? [];
	const employee = run.employees.find(e => e.id === agent);
	const name = employee?.name ?? 'Orchestrator';
	const role = employee?.role ?? 'orchestrator';
	switch (tab) {
		case 'stream':
			return {rows: buildRows(log, name, role, width, details), fromTop: false, empty: `${name} hasn't done anything in this run yet.`};
		case 'chat':
			return {rows: chatRows(log, name, role, width), fromTop: false, empty: `Nothing said yet. Type to message ${name}; it reaches them with their next task.`};
		case 'tests':
			return {rows: testRows(log, width), fromTop: false, empty: `${name} hasn't run any tests yet.`};
		case 'diff': {
			const patch = running ? (live ?? task?.patch) : task?.patch;
			if (run.state.isolation?.mode === 'shared') return {rows: [], fromTop: true, empty: 'Diffs are available when employees work in their own worktrees.'};
			return {rows: patch?.trim() ? diffRows(patch, width) : [], fromTop: true, empty: running ? `${name} hasn't changed any files yet.` : `${name} has no changes to show.`};
		}
	}
}

export function FocusMain({run, who, agent, tab, offset, details, width, height, now, tabsRef}: FocusProps) {
	const w = who(agent);
	const employee = run.employees.find(e => e.id === agent);
	const task = employee ? (run.state.tasks.filter(t => t.assignee === agent).find(t => t.status === 'running') ?? run.state.tasks.filter(t => t.assignee === agent).at(-1)) : undefined;
	const provider = PROVIDERS[employee?.provider ?? run.state.orchestrator.provider].label;
	const progress = employee ? laneProgress(run.state.tasks, agent) : undefined;
	const bodyHeight = Math.max(3, height - 4);
	const {rows, fromTop, empty} = useTabRows(run, agent, tab, width, details);
	const max = Math.max(0, rows.length - bodyHeight);
	const clamped = Math.min(offset, max);
	const visible = fromTop ? rows.slice(clamped, clamped + bodyHeight) : rows.slice(Math.max(0, rows.length - clamped - bodyHeight), rows.length - clamped);
	return (
		<Box flexDirection="column" width={width} height={height}>
			<Box>
				<Box flexGrow={1} flexShrink={1}>
					<Text wrap="truncate">
						<Text color={w.color} bold>
							{w.glyph} {w.name}
						</Text>
						<Text color={theme.muted}>
							{'  '}
							{employee ? `${employee.role} · ${provider}` : `orchestrator · ${provider}`}
							{progress?.total ? ` · ${progress.done}/${progress.total} tasks` : ''}
						</Text>
					</Text>
				</Box>
				<TabBar agent={agent} tab={tab} barRef={tabsRef} />
			</Box>
			<Text wrap="truncate" color={theme.strong}>
				{task ? task.title : employee ? 'No task in this run' : state(run)}
				{task?.startedAt ? <Text color={theme.dim}>{`  ${formatSpan((task.endedAt ?? now) - task.startedAt)}${task.costUsd ? ` · $${task.costUsd.toFixed(2)}` : ''}${task.tokens ? ` · ${formatTokens(task.tokens)} tok` : ''}`}</Text> : null}
			</Text>
			<Box flexDirection="column" height={bodyHeight} marginTop={1} overflow="hidden">
				{visible.length ? (
					visible.map(row => (
						<Box key={row.key} flexShrink={0}>
							<Text wrap="truncate">{row.node}</Text>
						</Box>
					))
				) : (
					<Text color={theme.dim}>{empty}</Text>
				)}
			</Box>
			{rows.length > bodyHeight ? (
				<Text color={theme.faint}>
					{fromTop ? `${clamped + 1}–${Math.min(rows.length, clamped + bodyHeight)} of ${rows.length}` : clamped ? `${clamped} rows above the end · g jumps back` : ''}
				</Text>
			) : null}
		</Box>
	);
}

function state(run: RunEngine): string {
	return orchestratorLabel(run.state, run.interrupted);
}
