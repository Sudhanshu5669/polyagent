import {Box, Text} from 'ink';
import type {ReactNode} from 'react';
import type {Employee} from '../../core/employees.js';
import {excerpt, formatSpan, laneProgress, laneState, runProgress, type LaneState} from '../../core/run/progress.js';
import {PROVIDERS} from '../../core/providers.js';
import type {RunEngine} from '../../core/run/engine.js';
import {isFinished, ORCHESTRATOR, type RunState} from '../../core/run/types.js';
import {Spinner} from '../components/Spinner.js';
import {statusGlyph, theme} from '../theme.js';
import {barText, type WhoFn} from './parts.js';

export interface Lane {
	/** 'orchestrator' or an employee id. */
	agent: string;
	employee?: Employee;
}

/** Orchestrator first, then employees with work in this run, then everyone else. */
export function lanesFor(run: RunEngine): Lane[] {
	const involved = new Set(run.state.tasks.map(t => t.assignee));
	const employees = [...run.employees.filter(e => involved.has(e.id)), ...run.employees.filter(e => !involved.has(e.id))];
	return [{agent: ORCHESTRATOR}, ...employees.map(employee => ({agent: employee.id, employee}))];
}

export function orchestratorLabel(state: RunState, interrupted: boolean): string {
	if (interrupted) return 'interrupted';
	if (state.paused) return state.paused.reason === 'budget' ? 'paused: budget reached' : 'paused';
	if (state.status === 'planning') return 'planning';
	if (state.status === 'awaiting-approval') return 'waiting for your approval';
	if (state.orchestrator.working) return 'reviewing';
	if (isFinished(state.status)) return state.status;
	return 'waiting for employees';
}

const stuck = (
	<Text backgroundColor={theme.fail} color="#101217" bold>
		{statusGlyph.stuck}
	</Text>
);

/** The status cell of a lane: glyph, then words. */
function status(lane: LaneState, who: WhoFn, color: string | undefined): {node: ReactNode; text: string} {
	switch (lane.kind) {
		case 'working': {
			const text = lane.activity?.text || lane.task?.title || 'working';
			return {text, node: <>{lane.activity?.running ? <Spinner color={color} /> : <Text color={color}>{statusGlyph.working}</Text>} <Text color={theme.text}>{text}</Text></>};
		}
		case 'attention':
			return {text: 'needs you', node: <Text color={theme.warn}>⚑ needs you <Text color={theme.dim}>ctrl+a</Text></Text>};
		case 'waiting': {
			const on = lane.on ? who(lane.on) : undefined;
			return {
				text: on ? `waiting on ${on.name}` : 'waiting',
				node: (
					<Text color={theme.muted}>
						{statusGlyph.waiting} waiting{on ? <> on <Text color={on.color}>{on.glyph} {on.name}</Text></> : null}
					</Text>
				),
			};
		}
		case 'queued':
			return {text: 'queued', node: <Text color={theme.muted}>{statusGlyph.waiting} queued</Text>};
		case 'done': {
			const what = lane.task?.files?.[0] ?? lane.task?.title ?? '';
			return {text: `done · ${what}`, node: <Text color={theme.muted}><Text color={theme.strong}>{statusGlyph.done}</Text> done{what ? ` · ${what}` : ''}</Text>};
		}
		case 'stuck': {
			const why = excerpt(lane.task?.error, 80);
			return {text: `stuck · ${why}`, node: <Text>{stuck} <Text color={theme.fail}>stuck</Text>{why ? <Text color={theme.muted}> · {why}</Text> : null}</Text>};
		}
		case 'idle':
			return {text: 'idle', node: <Text color={theme.dim}>{statusGlyph.idle} idle</Text>};
	}
}

interface LaneRowProps {
	index: number;
	lane: Lane;
	run: RunEngine;
	who: WhoFn;
	width: number;
	selected: boolean;
	needsYou: boolean;
	now: number;
}

const NAME = 15;
const ROLE = 10;
const BAR = 10;
const TIME = 6;

export function LaneRow({index, lane, run, who, width, selected, needsYou, now}: LaneRowProps) {
	const {state} = run;
	const w = who(lane.agent);
	const interrupted = run.interrupted;
	const showRole = width >= 70;
	const showBar = width >= 84;

	let cell: ReactNode;
	let fraction = 0;
	let time = '';
	if (lane.employee) {
		const s = laneState(lane.agent, state.tasks, run.logs[lane.agent] ?? [], needsYou);
		cell = status(s, who, w.color).node;
		fraction = laneProgress(state.tasks, lane.agent).fraction;
		if (s.since && (s.kind === 'working' || s.kind === 'attention')) time = formatSpan(now - s.since);
		else if (s.kind === 'done' && s.task?.startedAt && s.task.endedAt) time = formatSpan(s.task.endedAt - s.task.startedAt);
	} else {
		const label = orchestratorLabel(state, interrupted);
		const busy = state.orchestrator.working && !interrupted && !state.paused;
		cell = (
			<>
				{busy ? <Spinner color={w.color} /> : <Text color={theme.dim}>{isFinished(state.status) ? statusGlyph.done : statusGlyph.idle}</Text>} <Text color={busy ? theme.text : theme.muted}>{label}</Text>
			</>
		);
		fraction = runProgress(state).fraction;

	}

	const bar = barText(BAR, fraction);
	const role = (lane.employee?.role ?? PROVIDERS[state.orchestrator.provider].bins[0]!).slice(0, ROLE - 1).padEnd(ROLE);
	const name = `${w.glyph} ${w.name}`.slice(0, NAME - 1).padEnd(NAME);
	return (
		<Box width={width} flexShrink={0}>
			<Box flexGrow={1} flexShrink={1}>
				<Text wrap="truncate">
					<Text color={theme.accent}>{selected ? '▌' : ' '}</Text>
					<Text color={theme.dim}>{index} </Text>
					<Text color={w.color} bold={selected}>
						{name}
					</Text>
					{showRole ? <Text color={theme.dim}>{role}</Text> : null}
					{showBar ? (
						<Text>
							<Text color={w.color}>{bar.filled}</Text>
							<Text color={theme.track}>{bar.rest}</Text>
							{'  '}
						</Text>
					) : null}
					{cell}
				</Text>
			</Box>
			<Box flexShrink={0} width={TIME} justifyContent="flex-end">
				<Text color={theme.faint}>{time}</Text>
			</Box>
		</Box>
	);
}
