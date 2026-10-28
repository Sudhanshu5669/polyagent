import {Box, Text} from 'ink';
import {useKeys} from '../input.js';
import {useEffect, useRef, useState} from 'react';
import {PERMISSION_MODES} from '../../core/employees.js';
import {PROVIDERS, type ProviderId} from '../../core/providers.js';
import {proposeTeam, type ProposedEmployee, type StaffingResult} from '../../core/run/staffing.js';
import type {ChatEntry} from '../../core/transcript.js';
import {Frame} from '../components/Frame.js';
import type {Hint} from '../components/KeyHints.js';
import {Paragraph} from '../components/Paragraph.js';
import {RoleTag} from '../components/RoleTag.js';
import {Spinner} from '../components/Spinner.js';
import {TextInput} from '../components/TextInput.js';
import {icons, theme} from '../theme.js';

interface Props {
	request: string;
	cwd: string;
	orchestrator: ProviderId;
	orchestratorModel?: string;
	binaryFor: (provider: ProviderId) => string | undefined;
	/** Save the approved employees and start the run. */
	onHire: (employees: ProposedEmployee[]) => Promise<void>;
	onBack: () => void;
}

type Phase = 'working' | 'review' | 'feedback' | 'hiring' | 'failed';

function describe(entry: ChatEntry): string | undefined {
	if (entry.kind === 'tool') return `${entry.name} ${entry.summary}`.trim();
	if (entry.kind === 'thinking') return 'Thinking…';
	return undefined;
}

/** The orchestrator looks at the project and proposes a team for the request; the user trims it and hires. */
export function TeamProposal({request, cwd, orchestrator, orchestratorModel, binaryFor, onHire, onBack}: Props) {
	const [phase, setPhase] = useState<Phase>('working');
	const [result, setResult] = useState<StaffingResult>();
	const [employees, setEmployees] = useState<ProposedEmployee[]>([]);
	const [keep, setKeep] = useState<boolean[]>([]);
	const [row, setRow] = useState(0);
	const [activity, setActivity] = useState<string>();
	const [error, setError] = useState<string>();
	/** Feedback for the next attempt; a new value starts one. */
	const [ask, setAsk] = useState<{feedback?: string}>({});
	const cancel = useRef<() => void>(undefined);
	const cli = PROVIDERS[orchestrator].label;

	useEffect(() => {
		setPhase('working');
		setActivity(undefined);
		const attempt = proposeTeam(
			{
				cwd,
				request,
				orchestrator,
				orchestratorModel,
				binaryFor,
				retry: ask.feedback ? {sessionId: result?.sessionId, feedback: ask.feedback} : undefined,
			},
			entry => {
				const text = describe(entry);
				if (text) setActivity(text);
			},
		);
		cancel.current = attempt.cancel;
		let live = true;
		attempt.done.then(
			next => {
				if (!live) return;
				setResult(next);
				setEmployees(next.proposal.employees);
				setKeep(next.proposal.employees.map(() => true));
				setRow(0);
				setPhase('review');
			},
			(e: Error) => {
				if (!live) return;
				setError(e.message);
				setPhase('failed');
			},
		);
		return () => {
			live = false;
			attempt.cancel();
		};
	}, [ask]);

	const kept = employees.filter((_, i) => keep[i]);

	const hire = async () => {
		if (kept.length === 0) return setError('Keep at least one employee.');
		setPhase('hiring');
		try {
			await onHire(kept);
		} catch (e) {
			setError((e as Error).message);
			setPhase('review');
		}
	};

	const cyclePermissions = (delta: number) => {
		setEmployees(list =>
			list.map((e, i) => {
				if (i !== row) return e;
				const at = PERMISSION_MODES.indexOf(e.permissions);
				return {...e, permissions: PERMISSION_MODES[(at + delta + PERMISSION_MODES.length) % PERMISSION_MODES.length]!};
			}),
		);
	};

	useKeys(
		(input, key) => {
			setError(undefined);
			if (key.escape) {
				cancel.current?.();
				return onBack();
			}

			if (phase === 'failed') {
				if (input === 'r') setAsk({feedback: ask.feedback});
				return;
			}

			if (phase !== 'review') return;
			if (key.upArrow || input === 'k') setRow(r => (r - 1 + employees.length) % employees.length);
			else if (key.downArrow || input === 'j') setRow(r => (r + 1) % employees.length);
			else if (input === ' ') setKeep(k => k.map((v, i) => (i === row ? !v : v)));
			else if (key.leftArrow || input === 'h') cyclePermissions(-1);
			else if (key.rightArrow || input === 'l') cyclePermissions(1);
			else if (input === 'r') setPhase('feedback');
			else if (key.return) void hire();
		},
		{isActive: phase !== 'feedback' && phase !== 'hiring'},
	);

	const hints: Hint[] =
		phase === 'review'
			? [['↑↓', 'move'], ['space', 'keep/drop'], ['←→', 'permissions'], ['r', 'ask again'], ['⏎', 'hire and start'], ['esc', 'cancel']]
			: phase === 'feedback'
				? [['⏎', 'ask'], ['esc', 'back']]
				: phase === 'failed'
					? [['r', 'try again'], ['esc', 'back']]
					: [['esc', 'cancel']];

	return (
		<Frame
			title="polyagent · pick a team"
			hints={hints}
			notice={
				error && phase !== 'failed' ? (
					<Text color={theme.fail}>
						{icons.fail} {error}
					</Text>
				) : undefined
			}
		>
			<Text wrap="truncate">
				<Text color={theme.muted}>Request </Text>
				{request}
			</Text>

			{phase === 'working' ? (
				<Box marginTop={1} flexDirection="column">
					<Text>
						<Spinner /> {cli} is looking at the project and picking a team…
					</Text>
					{activity ? (
						<Text color={theme.muted} wrap="truncate">
							{'  '}
							{activity}
						</Text>
					) : null}
				</Box>
			) : phase === 'failed' ? (
				<Box marginTop={1}>
					<Paragraph color={theme.fail}>{`${icons.fail} Couldn't get a team: ${error ?? 'unknown error'}`}</Paragraph>
				</Box>
			) : (
				<Box marginTop={1} flexDirection="column">
					{result?.proposal.note ? <Paragraph>{result.proposal.note}</Paragraph> : null}
					<Box marginTop={1} flexDirection="column">
						{employees.map((e, i) => {
							const selected = i === row && phase === 'review';
							const on = keep[i];
							return (
								<Box key={`${i}:${e.name}`} flexDirection="column" marginBottom={i < employees.length - 1 ? 1 : 0}>
									<Text wrap="truncate">
										<Text color={theme.accent}>{selected ? `${icons.pointer} ` : '  '}</Text>
										<Text color={on ? theme.ok : theme.muted}>{on ? `[${icons.ok}]` : '[ ]'}</Text>{' '}
										<Text bold={selected} dimColor={!on}>
											{e.name}
										</Text>{' '}
										<RoleTag role={e.role} />
										<Text color={theme.muted} dimColor={!on}>
											{'  '}
											{PROVIDERS[e.provider].label} · {e.model ?? 'CLI default'} ·{' '}
										</Text>
										<Text color={e.permissions === 'full-auto' ? theme.warn : selected ? theme.accent : undefined} dimColor={!on}>
											{selected ? '‹ ' : ''}
											{e.permissions}
											{selected ? ' ›' : ''}
										</Text>
									</Text>
									<Text color={theme.muted} dimColor={!on} wrap="truncate">
										{'      '}
										{e.summary || 'No summary'}
									</Text>
									{e.owns.length ? (
										<Text color={theme.muted} dimColor={!on} wrap="truncate">
											{'      works in '}
											{e.owns.join(', ')}
										</Text>
									) : null}
								</Box>
							);
						})}
					</Box>
					<Box marginTop={1} flexDirection="column">
						{phase === 'feedback' ? (
							<>
								<Text>What should change?</Text>
								<TextInput
									placeholder="e.g. Drop the reviewer and use Codex for the backend"
									onSubmit={feedback => setAsk({feedback})}
									onCancel={() => setPhase('review')}
								/>
							</>
						) : phase === 'hiring' ? (
							<Text>
								<Spinner /> Hiring {kept.length} and starting the run…
							</Text>
						) : (
							<Paragraph color={theme.muted}>
								{`Hiring ${kept.length} of ${employees.length}. They join your team like anyone you hire yourself, so you can edit them later.${result?.costUsd ? ` Picking the team cost $${result.costUsd.toFixed(2)}.` : ''}`}
							</Paragraph>
						)}
					</Box>
				</Box>
			)}
		</Frame>
	);
}
