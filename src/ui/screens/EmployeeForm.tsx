import {Box, Text, useApp, useInput} from 'ink';
import {useState} from 'react';
import {ADAPTERS} from '../../core/agents/runner.js';
import type {Detection} from '../../core/detect.js';
import {PERMISSION_MODES, saveEmployee, uniqueId, type Employee, type PermissionMode} from '../../core/employees.js';
import {PROVIDERS, PROVIDER_IDS, type ProviderId} from '../../core/providers.js';
import {ROLE_TEMPLATES, type RoleTemplate} from '../../core/roles.js';
import {editorCommand, editText} from '../editor.js';
import {Frame} from '../components/Frame.js';
import type {Hint} from '../components/KeyHints.js';
import {Menu} from '../components/Menu.js';
import {Paragraph} from '../components/Paragraph.js';
import {RoleTag} from '../components/RoleTag.js';
import {TextInput} from '../components/TextInput.js';
import {icons, theme} from '../theme.js';

interface Draft {
	name: string;
	role: string;
	provider: ProviderId;
	model: string;
	permissions: PermissionMode;
	owns: string;
	summary: string;
	briefing: string;
	systemPrompt: string;
}

type TextField = 'name' | 'role' | 'model' | 'owns' | 'summary' | 'briefing';
type Field = TextField | 'provider' | 'permissions' | 'systemPrompt' | 'save';

const FIELDS: {key: Field; label: string; help: string}[] = [
	{key: 'name', label: 'Name', help: 'What you and the orchestrator call this employee.'},
	{key: 'role', label: 'Role', help: 'Shown as a tag, e.g. frontend, backend, reviewer, art.'},
	{key: 'provider', label: 'Agent CLI', help: 'Which tool does the work.'},
	{key: 'model', label: 'Model', help: "Leave empty to use the CLI's default model. Otherwise any model name the CLI accepts."},
	{key: 'permissions', label: 'Permissions', help: ''},
	{key: 'owns', label: 'Works in', help: 'Comma-separated paths or globs, e.g. src/api/**, migrations/**. Helps the orchestrator avoid overlapping work.'},
	{key: 'summary', label: 'Summary', help: 'What this employee handles. The orchestrator assigns work based on this.'},
	{key: 'briefing', label: 'Briefing', help: 'How this employee likes to receive tasks. The orchestrator writes briefs in this style.'},
	{key: 'systemPrompt', label: 'System prompt', help: ''},
	{key: 'save', label: '', help: ''},
];

const PERMISSION_HELP: Record<PermissionMode, string> = {
	'read-only': 'Can read and search the repo. Edits and commands that need approval are blocked.',
	'auto-edit': 'Can edit files in the repo. Riskier actions that need approval stay blocked.',
	'full-auto': 'No restrictions: can edit anything and run any command. Only for trusted tasks.',
};

const LABEL_WIDTH = 15;

interface Props {
	workspaceDir: string;
	/** Undefined when hiring someone new. */
	employee?: Employee;
	takenIds: string[];
	detections: Partial<Record<ProviderId, Detection>>;
	defaultProvider: ProviderId;
	onSaved: (id: string) => void;
	onBack: () => void;
}

function fromEmployee(e: Employee): Draft {
	return {...e, model: e.model ?? '', owns: e.owns.join(', ')};
}

function fromTemplate(t: RoleTemplate | undefined, provider: ProviderId): Draft {
	return {
		name: '',
		role: t?.role ?? '',
		provider,
		model: '',
		permissions: t?.permissions ?? 'read-only',
		owns: t?.owns.join(', ') ?? '',
		summary: t?.summary ?? '',
		briefing: t?.briefing ?? '',
		systemPrompt: t?.systemPrompt ?? '',
	};
}

export function EmployeeForm({workspaceDir, employee, takenIds, detections, defaultProvider, onSaved, onBack}: Props) {
	const {suspendTerminal} = useApp();
	const [draft, setDraft] = useState<Draft | undefined>(employee ? fromEmployee(employee) : undefined);
	const [initial, setInitial] = useState(draft);
	const [row, setRow] = useState(0);
	const [editing, setEditing] = useState<TextField | undefined>();
	const [error, setError] = useState<string>();
	const [confirmDiscard, setConfirmDiscard] = useState(false);

	const field = FIELDS[row]!;
	const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
	const installed = (id: ProviderId) => detections[id]?.status === 'found';

	const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft(d => (d ? {...d, [key]: value} : d));

	const cycle = (delta: number) => {
		if (!draft) return;
		if (field.key === 'provider') {
			const i = PROVIDER_IDS.indexOf(draft.provider);
			set('provider', PROVIDER_IDS[(i + delta + PROVIDER_IDS.length) % PROVIDER_IDS.length]!);
		} else if (field.key === 'permissions') {
			const i = PERMISSION_MODES.indexOf(draft.permissions);
			set('permissions', PERMISSION_MODES[(i + delta + PERMISSION_MODES.length) % PERMISSION_MODES.length]!);
		}
	};

	const editPrompt = async () => {
		if (!draft) return;
		try {
			let text = draft.systemPrompt;
			await suspendTerminal(async () => {
				text = await editText(draft.systemPrompt, `${draft.name || 'employee'}-system-prompt.md`);
			});
			set('systemPrompt', text.trim());
		} catch (e) {
			setError(`Couldn't open your editor (${editorCommand()}): ${(e as Error).message}. Set $EDITOR to change it.`);
		}
	};

	const save = async () => {
		if (!draft) return;
		if (!draft.name.trim()) return setError('Give this employee a name.');
		if (!draft.role.trim()) return setError('Give this employee a role.');
		const id = employee?.id ?? uniqueId(draft.name, takenIds);
		try {
			await saveEmployee(workspaceDir, id, {
				name: draft.name.trim(),
				role: draft.role.trim().toLowerCase(),
				provider: draft.provider,
				model: draft.model.trim() || undefined,
				permissions: draft.permissions,
				owns: draft.owns.split(',').map(s => s.trim()).filter(Boolean),
				summary: draft.summary.trim(),
				briefing: draft.briefing.trim(),
				systemPrompt: draft.systemPrompt,
			});
			onSaved(id);
		} catch (e) {
			setError((e as Error).message);
		}
	};

	useInput(
		(input, key) => {
			setError(undefined);
			if (confirmDiscard) {
				if (input === 'y') onBack();
				setConfirmDiscard(false);
				return;
			}

			if (key.escape) {
				if (dirty) setConfirmDiscard(true);
				else onBack();
				return;
			}

			if (key.ctrl && input === 's') return void save();
			if (key.upArrow || input === 'k') setRow(r => (r - 1 + FIELDS.length) % FIELDS.length);
			else if (key.downArrow || input === 'j' || key.tab) setRow(r => (r + 1) % FIELDS.length);
			else if (key.leftArrow || input === 'h') cycle(-1);
			else if (key.rightArrow || input === 'l' || input === ' ') cycle(1);
			else if (key.return) {
				if (field.key === 'save') void save();
				else if (field.key === 'systemPrompt') void editPrompt();
				else if (field.key === 'provider' || field.key === 'permissions') cycle(1);
				else setEditing(field.key);
			}
		},
		{isActive: draft !== undefined && editing === undefined},
	);

	// Step 1 when hiring: pick a starting template.
	if (!draft) {
		return (
			<Frame title="polyagent · hire an employee" hints={[['↑↓', 'move'], ['⏎', 'choose'], ['esc', 'cancel']]}>
				<TemplateStep
					onPick={template => {
						const next = fromTemplate(template, defaultProvider);
						setDraft(next);
						setInitial(next);
						setEditing('name');
					}}
					onCancel={onBack}
				/>
			</Frame>
		);
	}

	const value = (key: Field) => {
		switch (key) {
			case 'provider': {
				const adapter = ADAPTERS[draft.provider];
				return (
					<Text>
						{PROVIDERS[draft.provider].label}
						{!installed(draft.provider) ? <Text color={theme.warn}> {icons.warn} not installed</Text> : null}
						{!adapter.verified ? <Text color={theme.muted}> (experimental)</Text> : null}
					</Text>
				);
			}

			case 'permissions':
				return <Text color={draft.permissions === 'full-auto' ? theme.warn : undefined}>{draft.permissions}</Text>;
			case 'model':
				return draft.model ? <Text>{draft.model}</Text> : <Text color={theme.muted}>CLI default</Text>;
			case 'systemPrompt': {
				const lines = draft.systemPrompt.split('\n').filter(l => l.trim());
				return lines.length ? (
					<Text>
						{lines[0]}
						<Text color={theme.muted}> ({lines.length} line{lines.length === 1 ? '' : 's'})</Text>
					</Text>
				) : (
					<Text color={theme.muted}>empty</Text>
				);
			}

			case 'save':
				return null;
			default:
				return draft[key] ? <Text>{draft[key]}</Text> : <Text color={theme.muted}>empty</Text>;
		}
	};

	const help =
		field.key === 'permissions'
			? PERMISSION_HELP[draft.permissions]
			: field.key === 'systemPrompt'
				? `Press ⏎ to edit in ${editorCommand()}. polyagent also tells the employee their name, role, summary and areas.`
				: field.help;

	const hints: Hint[] = editing
		? [['⏎', 'done'], ['esc', 'cancel edit']]
		: confirmDiscard
			? [['y', 'discard'], ['any key', 'keep editing']]
			: [['↑↓', 'move'], ['⏎', 'edit'], ['←→', 'change'], ['ctrl+s', 'save'], ['esc', 'back']];

	return (
		<Frame
			title={employee ? `polyagent · edit ${employee.name}` : 'polyagent · hire an employee'}
			right={draft.role ? <RoleTag role={draft.role} /> : undefined}
			hints={hints}
			notice={
				confirmDiscard ? (
					<Text color={theme.warn}>Discard your changes?</Text>
				) : error ? (
					<Text color={theme.fail}>
						{icons.fail} {error}
					</Text>
				) : undefined
			}
		>
			{FIELDS.map((f, i) => {
				const selected = i === row;
				if (f.key === 'save') {
					return (
						<Box key="save" marginTop={1}>
							<Text color={theme.accent}>{selected ? `${icons.pointer} ` : '  '}</Text>
							<Text bold inverse={selected}>
								{employee ? ' Save changes ' : ' Hire '}
							</Text>
						</Box>
					);
				}

				const cyclable = f.key === 'provider' || f.key === 'permissions';
				return (
					<Box key={f.key}>
						{/* Fixed-width columns so long values truncate instead of squeezing the labels. */}
						<Box width={2} flexShrink={0}>
							<Text color={theme.accent}>{selected ? icons.pointer : ' '}</Text>
						</Box>
						<Box width={LABEL_WIDTH} flexShrink={0}>
							<Text bold={selected}>{f.label}</Text>
						</Box>
						{editing === f.key ? (
							<TextInput
								prompt=""
								initialValue={draft[f.key as TextField]}
								allowEmpty
								onSubmit={v => {
									set(f.key as TextField, v);
									setEditing(undefined);
									if (f.key === 'name' && !employee) setRow(r => r + 1);
								}}
								onCancel={() => setEditing(undefined)}
							/>
						) : (
							<Box flexGrow={1}>
								<Text wrap="truncate">
									{selected && cyclable ? <Text color={theme.accent}>‹ </Text> : null}
									{value(f.key)}
									{selected && cyclable ? <Text color={theme.accent}> ›</Text> : null}
								</Text>
							</Box>
						)}
					</Box>
				);
			})}
			<Box marginTop={1}>
				<Paragraph color={theme.muted}>{help}</Paragraph>
			</Box>
		</Frame>
	);
}

function TemplateStep({onPick, onCancel}: {onPick: (t: RoleTemplate | undefined) => void; onCancel: () => void}) {
	useInput((_, key) => {
		if (key.escape) onCancel();
	});

	return (
		<Box flexDirection="column">
			<Text bold>Start from a role</Text>
			<Text color={theme.muted}>Fills in a summary, briefing style, permissions and system prompt. You can change everything next.</Text>
			<Box marginTop={1}>
				<Menu<RoleTemplate | undefined>
					items={[
						...ROLE_TEMPLATES.map(t => ({label: t.role, value: t as RoleTemplate | undefined, hint: t.summary})),
						{label: 'blank', value: undefined, hint: 'Start from scratch'},
					]}
					onSelect={onPick}
				/>
			</Box>
		</Box>
	);
}
