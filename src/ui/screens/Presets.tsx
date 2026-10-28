import {Box, Text} from 'ink';
import {useEffect, useState} from 'react';
import type {Detection} from '../../core/detect.js';
import type {Employee} from '../../core/employees.js';
import {globalDir} from '../../core/paths.js';
import {applyPreset, deletePreset, listPresets, savePreset, type ApplyResult, type BrokenPreset, type Preset} from '../../core/presets.js';
import {PROVIDERS, PROVIDER_IDS, type ProviderId} from '../../core/providers.js';
import {Frame} from '../components/Frame.js';
import type {Hint} from '../components/KeyHints.js';
import {Menu} from '../components/Menu.js';
import {Paragraph} from '../components/Paragraph.js';
import {RoleTag} from '../components/RoleTag.js';
import {TextInput} from '../components/TextInput.js';
import {useKeys} from '../input.js';
import {icons, theme} from '../theme.js';

type Step = {kind: 'browse'} | {kind: 'apply'} | {kind: 'confirm-delete'} | {kind: 'save'; field: 'name' | 'description' | 'scope'; name: string; description: string};

interface Props {
	workspaceDir: string;
	team: Employee[];
	detections: Partial<Record<ProviderId, Detection>>;
	/** The CLI built-in presets use, and the fallback for employees whose CLI isn't installed. */
	defaultProvider: ProviderId;
	onApplied: (preset: Preset, result: ApplyResult) => void;
	onBack: () => void;
}

const SCOPES: {scope: Preset['scope']; title: string}[] = [
	{scope: 'repo', title: 'THIS REPO'},
	{scope: 'global', title: 'GLOBAL'},
	{scope: 'builtin', title: 'BUILT-IN'},
];

export function Presets({workspaceDir, team, detections, defaultProvider, onApplied, onBack}: Props) {
	const [presets, setPresets] = useState<Preset[]>([]);
	const [broken, setBroken] = useState<BrokenPreset[]>([]);
	const [row, setRow] = useState(0);
	const [step, setStep] = useState<Step>({kind: 'browse'});
	const [flash, setFlash] = useState<{text: string; failed?: boolean}>();

	const reload = async () => {
		const loaded = await listPresets(workspaceDir, globalDir());
		setPresets(loaded.presets);
		setBroken(loaded.broken);
	};

	useEffect(() => void reload(), [workspaceDir]);

	// Ordered by scope, the same order they're drawn in.
	const ordered = SCOPES.flatMap(({scope}) => presets.filter(p => p.scope === scope));
	const preset = ordered[Math.min(row, ordered.length - 1)];
	const installed = PROVIDER_IDS.filter(id => detections[id] === undefined || detections[id]?.status === 'found');
	const switching = preset && preset.scope !== 'builtin' ? preset.employees.filter(e => !installed.includes(e.provider)) : [];

	const apply = async (mode: 'add' | 'replace') => {
		if (!preset) return;
		const result = await applyPreset(workspaceDir, preset, {mode, installed, fallback: defaultProvider, provider: defaultProvider});
		onApplied(preset, result);
	};

	useKeys(
		(input, key) => {
			setFlash(undefined);
			if (step.kind === 'confirm-delete') {
				if (input === 'y' && preset) {
					void deletePreset(preset)
						.then(reload)
						.then(() => setFlash({text: `Deleted ${preset.name}`}));
				}

				setStep({kind: 'browse'});
				return;
			}

			if (step.kind !== 'browse') {
				if (key.escape) setStep({kind: 'browse'});
				return;
			}

			if (key.escape) return onBack();
			if (key.upArrow || input === 'k') setRow(r => Math.max(0, r - 1));
			else if (key.downArrow || input === 'j') setRow(r => Math.min(ordered.length - 1, r + 1));
			else if (key.return && preset) setStep({kind: 'apply'});
			else if (input === 's') {
				if (team.length === 0) setFlash({text: 'Hire some employees first, then save them as a preset.', failed: true});
				else setStep({kind: 'save', field: 'name', name: '', description: ''});
			} else if (input === 'd' && preset && preset.scope !== 'builtin') setStep({kind: 'confirm-delete'});
		},
		// While typing a name or description, the text input owns the keyboard (esc included).
		{isActive: step.kind !== 'save' || step.field === 'scope'},
	);

	const hints: Hint[] =
		step.kind === 'confirm-delete'
			? [['y', 'delete'], ['any key', 'cancel']]
			: step.kind === 'browse'
				? [['↑↓', 'select'], ['⏎', 'use'], ['s', 'save current team'], ...(preset && preset.scope !== 'builtin' ? ([['d', 'delete']] as Hint[]) : []), ['esc', 'back']]
				: [['⏎', 'choose'], ['esc', 'back']];

	return (
		<Frame
			title="polyagent · team presets"
			hints={hints}
			notice={
				step.kind === 'confirm-delete' && preset ? (
					<Text color={theme.warn}>
						Delete the preset "{preset.name}"? Your current team isn't affected.
					</Text>
				) : flash ? (
					<Text color={flash.failed ? theme.warn : theme.ok}>
						{flash.failed ? icons.warn : icons.ok} {flash.text}
					</Text>
				) : undefined
			}
		>
			<Box flexGrow={1}>
				<Box flexDirection="column" width={32} flexShrink={0} marginRight={2}>
					{SCOPES.map(({scope, title}) => {
						const inScope = presets.filter(p => p.scope === scope);
						return (
							<Box key={scope} flexDirection="column" marginBottom={1} flexShrink={0}>
								<Text bold color={theme.muted}>
									{title}
								</Text>
								{inScope.length === 0 ? (
									<Text color={theme.muted}>  {scope === 'repo' ? 'None saved here' : 'None saved'}</Text>
								) : (
									inScope.map(p => {
										const selected = p === preset;
										return (
											<Text key={`${scope}-${p.id}`} wrap="truncate">
												<Text color={theme.accent}>{selected ? `${icons.pointer} ` : '  '}</Text>
												<Text bold={selected}>{p.name}</Text>
												<Text color={theme.muted}> ({p.employees.length})</Text>
											</Text>
										);
									})
								)}
								{broken
									.filter(b => b.scope === scope)
									.map(b => (
										<Text key={b.id} color={theme.warn} wrap="truncate">
											{'  '}
											{icons.warn} {b.id}: {b.error}
										</Text>
									))}
							</Box>
						);
					})}
				</Box>

				<Box flexDirection="column" flexGrow={1} flexBasis={0}>
					{step.kind === 'save' ? (
						<SaveForm
							step={step}
							teamSize={team.length}
							onStep={setStep}
							onSave={async (scopeDir, label) => {
								try {
									await savePreset(scopeDir, step.name, step.description, team);
								} catch (error) {
									setStep({kind: 'browse'});
									setFlash({text: (error as Error).message, failed: true});
									return;
								}

								await reload();
								setStep({kind: 'browse'});
								setFlash({text: `Saved your team as "${step.name}" (${label})`});
							}}
							workspaceDir={workspaceDir}
						/>
					) : preset ? (
						<>
							<Text>
								<Text bold>{preset.name}</Text>
								<Text color={theme.muted}> · {preset.scope === 'builtin' ? 'built-in' : preset.scope === 'repo' ? 'this repo' : 'global'}</Text>
							</Text>
							{preset.description ? <Paragraph color={theme.muted}>{preset.description}</Paragraph> : null}
							<Box flexDirection="column" marginY={1} flexShrink={0}>
								{preset.employees.map(e => (
									<Text key={e.id} wrap="truncate">
										{'  '}
										{e.name} <RoleTag role={e.role} />
										<Text color={theme.muted}>
											{'  '}
											{preset.scope === 'builtin' ? PROVIDERS[defaultProvider].label : PROVIDERS[e.provider].label} · {e.permissions}
										</Text>
										{switching.includes(e) ? <Text color={theme.warn}> {icons.warn} not installed</Text> : null}
									</Text>
								))}
							</Box>
							{step.kind === 'apply' ? (
								<Box flexDirection="column" flexShrink={0}>
									{preset.scope === 'builtin' ? (
										<Paragraph color={theme.muted}>{`Everyone will run on ${PROVIDERS[defaultProvider].label}. You can change each employee afterwards.`}</Paragraph>
									) : null}
									{switching.length ? (
										<Paragraph color={theme.warn}>{`${switching.map(e => e.name).join(', ')} will switch to ${PROVIDERS[defaultProvider].label}, because their CLI isn't installed.`}</Paragraph>
									) : null}
									<Box marginTop={1}>
										<Menu<'add' | 'replace' | 'cancel'>
											items={[
												{label: 'Add to your team', value: 'add', hint: team.length ? 'anyone with the same id gets a numbered name' : undefined},
												...(team.length
													? [{label: 'Replace your team', value: 'replace' as const, hint: `removes ${team.map(e => e.name).join(', ')} and their chats`}]
													: []),
												{label: 'Cancel', value: 'cancel'},
											]}
											onSelect={choice => (choice === 'cancel' ? setStep({kind: 'browse'}) : void apply(choice))}
										/>
									</Box>
								</Box>
							) : null}
						</>
					) : (
						<Text color={theme.muted}>No presets.</Text>
					)}
				</Box>
			</Box>
		</Frame>
	);
}

function SaveForm({
	step,
	teamSize,
	workspaceDir,
	onStep,
	onSave,
}: {
	step: Extract<Step, {kind: 'save'}>;
	teamSize: number;
	workspaceDir: string;
	onStep: (step: Step) => void;
	onSave: (scopeDir: string, label: string) => Promise<void>;
}) {
	return (
		<Box flexDirection="column">
			<Text bold>Save your team ({teamSize}) as a preset</Text>
			<Box marginTop={1} flexDirection="column">
				<Text color={theme.muted}>Name</Text>
				{step.field === 'name' ? (
					<TextInput placeholder="e.g. Checkout team" onSubmit={name => onStep({...step, name, field: 'description'})} onCancel={() => onStep({kind: 'browse'})} />
				) : (
					<Text>  {step.name}</Text>
				)}
			</Box>
			{step.field !== 'name' ? (
				<Box marginTop={1} flexDirection="column">
					<Text color={theme.muted}>Description (optional)</Text>
					{step.field === 'description' ? (
						<TextInput placeholder="What this team is good at" allowEmpty onSubmit={description => onStep({...step, description, field: 'scope'})} onCancel={() => onStep({kind: 'browse'})} />
					) : (
						<Text>  {step.description || '—'}</Text>
					)}
				</Box>
			) : null}
			{step.field === 'scope' ? (
				<Box marginTop={1} flexDirection="column">
					<Text color={theme.muted}>Where</Text>
					<Menu<'repo' | 'global'>
						items={[
							{label: 'This repo', value: 'repo', hint: 'in .polyagent/presets, shared if git tracking shares the team'},
							{label: 'Every repo', value: 'global', hint: 'in your global polyagent folder'},
						]}
						onSelect={scope => void onSave(scope === 'repo' ? workspaceDir : globalDir(), scope === 'repo' ? 'this repo' : 'every repo')}
					/>
				</Box>
			) : null}
		</Box>
	);
}
