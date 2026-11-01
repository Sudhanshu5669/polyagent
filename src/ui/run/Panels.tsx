import {Box, Text} from 'ink';
import type {RunEngine} from '../../core/run/engine.js';
import {diffStats, formatSpan, formatTokens} from '../../core/run/progress.js';
import {isFinished} from '../../core/run/types.js';
import {theme} from '../theme.js';
import type {WhoFn} from './parts.js';

const money = (n: number | undefined) => (n ? `$${n.toFixed(2)}` : '–');

/** /cost: spend per employee and task. */
export function CostPanel({run, who, width}: {run: RunEngine; who: WhoFn; width: number}) {
	const {state} = run;
	const byEmployee = new Map<string, {cost: number; tokens: number; tasks: typeof state.tasks}>();
	for (const task of state.tasks) {
		const row = byEmployee.get(task.assignee) ?? {cost: 0, tokens: 0, tasks: []};
		row.cost += task.costUsd ?? 0;
		row.tokens += task.tokens ?? 0;
		row.tasks.push(task);
		byEmployee.set(task.assignee, row);
	}

	const employeesCost = [...byEmployee.values()].reduce((sum, r) => sum + r.cost, 0);
	const orchestrator = Math.max(0, state.costUsd - employeesCost);
	const budget = run.budget;
	return (
		<Box flexDirection="column" width={width}>
			<Text color={theme.strong}>
				Spend <Text color={theme.dim}>· {money(state.costUsd)} · {formatTokens(state.tokens)} tokens{budget ? ` · budget ${money(budget)}` : ''}</Text>
			</Text>
			<Text color={theme.dim}>Claude Code reports cost; Codex and Antigravity report tokens only.</Text>
			<Box flexDirection="column" marginTop={1}>
				{[...byEmployee.entries()].map(([id, row]) => {
					const w = who(id);
					return (
						<Box key={id} flexDirection="column">
							<Text wrap="truncate">
								<Text color={w.color}>{`${w.glyph} ${w.name}`.padEnd(14)}</Text>
								<Text color={theme.strong}>{money(row.cost).padStart(8)}</Text>
								<Text color={theme.dim}>{`  ${formatTokens(row.tokens)} tok`}</Text>
							</Text>
							{row.tasks.map(t => (
								<Text key={t.id} wrap="truncate" color={theme.dim}>
									{'    '}
									{t.id.padEnd(18)}
									{money(t.costUsd).padStart(8)}
									{`  ${formatTokens(t.tokens ?? 0)} tok`}
									{t.startedAt ? `  ${formatSpan((t.endedAt ?? Date.now()) - t.startedAt)}` : ''}
								</Text>
							))}
						</Box>
					);
				})}
				<Text wrap="truncate">
					<Text color={who('orchestrator').color}>{'◆ orchestrator'.padEnd(14)}</Text>
					<Text color={theme.strong}>{money(orchestrator).padStart(8)}</Text>
					<Text color={theme.dim}>{`  ${state.orchestrator.turns} turn${state.orchestrator.turns === 1 ? '' : 's'}`}</Text>
				</Text>
			</Box>
		</Box>
	);
}

/** /merge: what each employee changed, and where it went. */
export function MergePanel({run, who, width}: {run: RunEngine; who: WhoFn; width: number}) {
	const {state} = run;
	const worktrees = state.isolation?.mode === 'worktrees';
	return (
		<Box flexDirection="column" width={width}>
			<Text color={theme.strong}>
				Worktrees <Text color={theme.dim}>· {worktrees ? 'each employee works in their own; finished work is merged into your working tree' : `one task at a time: ${state.isolation?.mode === 'shared' ? state.isolation.reason : 'not started yet'}`}</Text>
			</Text>
			<Box flexDirection="column" marginTop={1}>
				{state.tasks.length === 0 ? <Text color={theme.dim}>No tasks yet.</Text> : null}
				{state.tasks.map(t => {
					const w = who(t.assignee);
					const stats = t.patch ? diffStats(t.patch) : [];
					const added = stats.reduce((n, s) => n + s.added, 0);
					const removed = stats.reduce((n, s) => n + s.removed, 0);
					const where = t.conflicts?.length ? <Text color={theme.warn}>conflict, not applied</Text> : t.status === 'done' ? <Text color={theme.strong}>merged</Text> : <Text color={theme.dim}>{t.status}</Text>;
					return (
						<Text key={t.id} wrap="truncate">
							<Text color={w.color}>⎇ {t.id.padEnd(20)}</Text>
							{where}
							{t.files?.length ? (
								<Text color={theme.dim}>
									{'  '}
									{t.files.length} file{t.files.length === 1 ? '' : 's'}{' '}
									<Text color={theme.ok}>+{added}</Text> <Text color={theme.fail}>−{removed}</Text>
								</Text>
							) : null}
						</Text>
					);
				})}
			</Box>
			{state.unapplied.length ? (
				<Box flexDirection="column" marginTop={1}>
					<Text color={theme.warn}>Kept aside because you changed them during the run:</Text>
					<Text color={theme.muted} wrap="truncate">
						{state.unapplied.join(', ')}
					</Text>
				</Box>
			) : null}
			{state.isolation?.mode === 'worktrees' ? (
				<Box marginTop={1}>
					<Text color={theme.dim} wrap="truncate">
						{isFinished(state.status) ? 'Recover the run' : 'The run'} is kept at {state.isolation.ref}
					</Text>
				</Box>
			) : null}
		</Box>
	);
}
