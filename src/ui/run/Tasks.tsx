import {Box, Text} from 'ink';
import type {ReactNode} from 'react';
import type {RunEngine} from '../../core/run/engine.js';
import {formatSpan, formatTokens} from '../../core/run/progress.js';
import type {TaskStatus} from '../../core/run/types.js';
import {Paragraph} from '../components/Paragraph.js';
import {Spinner} from '../components/Spinner.js';
import {icons, statusGlyph, theme} from '../theme.js';
import type {WhoFn} from './parts.js';

function taskIcon(status: TaskStatus, color?: string): ReactNode {
	switch (status) {
		case 'blocked':
		case 'ready':
			return <Text color={theme.muted}>{statusGlyph.waiting}</Text>;
		case 'running':
			return <Spinner color={color} />;
		case 'done':
			return <Text color={theme.ok}>{icons.ok}</Text>;
		case 'failed':
			return <Text color={theme.fail}>{icons.fail}</Text>;
		case 'cancelled':
			return <Text color={theme.muted}>⊘</Text>;
	}
}

export function clip(text: string, lines: number, width: number): string {
	const all = text.split('\n').flatMap(l => (l.length > width ? (l.match(new RegExp(`.{1,${width}}`, 'g')) ?? [l]) : [l]));
	return all.length > lines ? `${all.slice(0, lines).join('\n')}\n…` : text;
}

/** Every task with its brief and report: the plan, as a table. */
export function TasksView({run, who, row, width, height, now}: {run: RunEngine; who: WhoFn; row: number; width: number; height: number; now: number}) {
	const {tasks} = run.state;
	const task = tasks[Math.min(row, tasks.length - 1)];
	const list = Math.max(3, Math.min(tasks.length, height - 12));
	const top = Math.max(0, Math.min(row - Math.floor(list / 2), tasks.length - list));
	return (
		<Box flexDirection="column" width={width} height={height} overflow="hidden">
			<Text color={theme.strong}>
				Tasks <Text color={theme.dim}>· {tasks.filter(t => t.status === 'done').length}/{tasks.length} done</Text>
			</Text>
			{tasks.length === 0 ? <Text color={theme.dim}>No tasks yet. The orchestrator is still planning.</Text> : null}
			<Box flexDirection="column" marginTop={1} flexShrink={0}>
				{tasks.slice(top, top + list).map((t, i) => {
					const w = who(t.assignee);
					const selected = top + i === row;
					return (
						<Text key={t.id} wrap="truncate">
							<Text color={theme.accent}>{selected ? '▌' : ' '}</Text> {taskIcon(t.status, w.color)} <Text bold={selected} color={selected ? theme.strong : undefined}>{t.id.padEnd(18)}</Text>
							<Text color={w.color}>{`${w.glyph} ${w.name}`.padEnd(13)}</Text>
							{t.title}
							<Text color={theme.dim}>
								{t.dependsOn.length ? `  after ${t.dependsOn.join(', ')}` : ''}
								{t.revisions ? `  revised ${t.revisions}×` : ''}
								{t.startedAt ? `  ${formatSpan((t.endedAt ?? now) - t.startedAt)}` : ''}
								{t.tokens ? `  ${formatTokens(t.tokens)} tok` : ''}
							</Text>
						</Text>
					);
				})}
			</Box>
			{task ? (
				<Box flexDirection="column" marginTop={1} flexShrink={0}>
					<Text color={theme.dim}>Brief</Text>
					<Paragraph>{clip(task.brief, 6, width)}</Paragraph>
					{task.files?.length ? (
						<Text wrap="truncate">
							<Text color={theme.dim}>Changed </Text>
							{task.files.join(', ')}
						</Text>
					) : null}
					{task.report || task.error ? (
						<>
							<Text color={theme.dim}>{task.error ? 'Error' : 'Report'}</Text>
							<Paragraph color={task.error ? theme.fail : undefined}>{clip(task.error ?? task.report ?? '', 6, width)}</Paragraph>
						</>
					) : null}
				</Box>
			) : null}
		</Box>
	);
}
