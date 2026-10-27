import path from 'node:path';
import {Box, Text} from 'ink';
import {useKeys} from '../input.js';
import {useState} from 'react';
import {
	loadGlobalConfig,
	loadRepoConfig,
	resolveSettings,
	saveGlobalConfig,
	saveRepoConfig,
	type GlobalConfig,
	type SettingKey,
	type Settings as SettingsValues,
	type SettingSource,
} from '../../core/config.js';
import type {AppContext} from '../../core/context.js';
import {applyDetections, detectAll, type Detection} from '../../core/detect.js';
import {tildify, WORKSPACE_DIRNAME} from '../../core/paths.js';
import {PROVIDERS, PROVIDER_IDS, type ProviderId} from '../../core/providers.js';
import {AddProviderFlow} from '../components/AddProviderFlow.js';
import {Frame} from '../components/Frame.js';
import {Paragraph} from '../components/Paragraph.js';
import {TextInput} from '../components/TextInput.js';
import type {Hint} from '../components/KeyHints.js';
import {ProviderBadges, ProviderRows} from '../components/ProviderRows.js';
import {Spinner} from '../components/Spinner.js';
import {icons, theme} from '../theme.js';
import {useAddProvider} from '../useAddProvider.js';
import {SETTINGS_META} from './settingsMeta.js';

type Tab = 'repo' | 'global' | 'providers';
type Detections = Partial<Record<ProviderId, Detection>>;

interface Props {
	ctx: AppContext;
	detections: Detections;
	/** Called after anything is saved, so the app reloads config and re-syncs .gitignore. */
	onSaved: () => Promise<void>;
	onDetections: (detections: Detections, global: GlobalConfig) => void;
	onBack: () => void;
}

const LABEL_WIDTH = Math.max(...SETTINGS_META.map(m => m.label.length)) + 2;
const VALUE_WIDTH = Math.max(...SETTINGS_META.flatMap(m => m.options.map(o => m.format(o).length)), 12);

export function Settings({ctx, detections, onSaved, onDetections, onBack}: Props) {
	const tabs: Tab[] = ctx.workspace.exists ? ['repo', 'global', 'providers'] : ['global', 'providers'];
	const [tab, setTab] = useState<Tab>(tabs[0]!);
	const [row, setRow] = useState(0);
	const [providerRow, setProviderRow] = useState(0);
	const [flash, setFlash] = useState<string>();
	const [rescanning, setRescanning] = useState(false);
	/** True while typing a free-text setting. */
	const [typing, setTyping] = useState(false);
	const add = useAddProvider();

	const scoped = tab === 'repo' ? ctx.settings : resolveSettings(ctx.global);
	const selectedMeta = SETTINGS_META[row]!;
	const selectedProvider = PROVIDER_IDS[providerRow]!;

	const write = async (key: SettingKey, value: SettingsValues[SettingKey] | undefined) => {
		const apply = <T extends {settings: Partial<SettingsValues>}>(config: T): T => {
			const settings = {...config.settings};
			if (value === undefined) delete settings[key];
			else Object.assign(settings, {[key]: value});
			return {...config, settings};
		};

		// Re-read from disk so we never clobber edits made by `polyagent config set` in another terminal.
		if (tab === 'repo') await saveRepoConfig(ctx.workspace.root, apply(await loadRepoConfig(ctx.workspace.root)));
		else await saveGlobalConfig(apply(await loadGlobalConfig()));
		await onSaved();
		setFlash(tab === 'repo' ? `Saved to ${WORKSPACE_DIRNAME}/config.json` : 'Saved as global default');
	};

	const cycle = (delta: number) => {
		if (selectedMeta.options.length === 0) return;
		const current = scoped.values[selectedMeta.key];
		const i = selectedMeta.options.indexOf(current);
		const next = selectedMeta.options[(i + delta + selectedMeta.options.length) % selectedMeta.options.length];
		void write(selectedMeta.key, next);
	};

	const rescan = async () => {
		setRescanning(true);
		const global = await loadGlobalConfig();
		const results = await detectAll(global);
		const next = applyDetections(global, results);
		await saveGlobalConfig(next);
		onDetections(Object.fromEntries(results.map(d => [d.provider, d])), next);
		setRescanning(false);
		setFlash('Providers re-checked');
	};

	useKeys(
		(input, key) => {
			setFlash(undefined);
			if (key.escape || input === 'q') return onBack();
			if (key.tab) {
				const i = tabs.indexOf(tab);
				setTab(tabs[(i + (key.shift ? -1 : 1) + tabs.length) % tabs.length]!);
				return;
			}

			if (tab === 'providers') {
				if (key.upArrow || input === 'k') setProviderRow(r => (r - 1 + PROVIDER_IDS.length) % PROVIDER_IDS.length);
				else if (key.downArrow || input === 'j') setProviderRow(r => (r + 1) % PROVIDER_IDS.length);
				else if (key.return) {
					const current = ctx.global.providers[selectedProvider]?.path;
					add.start(current ? tildify(current) : undefined);
				} else if (input === 'r' && !rescanning) void rescan();
				return;
			}

			if (key.upArrow || input === 'k') setRow(r => (r - 1 + SETTINGS_META.length) % SETTINGS_META.length);
			else if (key.downArrow || input === 'j') setRow(r => (r + 1) % SETTINGS_META.length);
			else if (key.return && selectedMeta.parse) setTyping(true);
			else if (key.rightArrow || input === 'l' || key.return || input === ' ') cycle(1);
			else if (key.leftArrow || input === 'h') cycle(-1);
			else if (input === 'x' && scoped.sources[selectedMeta.key] === (tab === 'repo' ? 'repo' : 'global')) {
				void write(selectedMeta.key, undefined);
			}
		},
		{isActive: add.state.step === 'idle' && !typing},
	);

	const confirmProvider = async (provider: ProviderId, file: string, version: string) => {
		const global = await loadGlobalConfig();
		const next: GlobalConfig = {...global, providers: {...global.providers, [provider]: {path: file, version, source: 'manual'}}};
		await saveGlobalConfig(next);
		onDetections({...detections, [provider]: {provider, status: 'found', path: file, version, source: 'manual'}}, next);
		add.cancel();
		setFlash(`${PROVIDERS[provider].label} now uses ${tildify(file)}`);
	};

	const hints: Hint[] =
		add.state.step !== 'idle' || typing
			? [['⏎', typing ? 'save' : 'confirm'], ['esc', 'back']]
			: tab === 'providers'
				? [['tab', 'next tab'], ['↑↓', 'move'], ['⏎', 'set path'], ['r', 're-check'], ['esc', 'back']]
				: [['tab', 'next tab'], ['↑↓', 'move'], selectedMeta.parse ? ['⏎', 'edit'] : ['←→', 'change'], ['x', 'reset'], ['esc', 'back']];

	return (
		<Frame title="polyagent · settings" right={<ProviderBadges detections={detections} />} hints={hints}>
			<Box marginBottom={1}>
				{tabs.map(t => (
					<Box key={t} marginRight={2}>
						<Text bold={t === tab} color={t === tab ? theme.accent : theme.muted} underline={t === tab}>
							{TAB_LABEL[t]}
						</Text>
					</Box>
				))}
			</Box>

			{tab === 'providers' ? (
				<Box flexDirection="column">
					<ProviderRows detections={detections} selected={add.state.step === 'idle' ? selectedProvider : undefined} />
					<Box marginTop={1} flexDirection="column">
						{add.state.step !== 'idle' ? (
							<AddProviderFlow
								state={add.state}
								onSubmitPath={p => void add.submitPath(p)}
								onCancel={add.cancel}
								onConfirm={(provider, file, version) => void confirmProvider(provider, file, version)}
							/>
						) : rescanning ? (
							<Text>
								<Spinner /> Re-checking…
							</Text>
						) : (
							<Text color={theme.muted}>Paths are shared by every repo. Press ⏎ to point a provider at a specific executable.</Text>
						)}
					</Box>
				</Box>
			) : (
				<Box flexDirection="column">
					<Text color={theme.muted}>
						{tab === 'repo'
							? `Applies only to ${path.basename(ctx.workspace.root)}. Anything not set here comes from your global defaults.`
							: 'Defaults for every repo. A repo can override any of these.'}
					</Text>
					<Box flexDirection="column" marginY={1}>
						{SETTINGS_META.map((m, i) => {
							const selected = i === row;
							const value = scoped.values[m.key];
							const notInstalled = m.key === 'orchestrator' && detections[value as ProviderId]?.status === 'missing';
							return (
								selected && typing ? (
									<Box key={m.key}>
										<Text color={theme.accent}>{icons.pointer} </Text>
										<Text bold>{m.label.padEnd(LABEL_WIDTH)}</Text>
										<TextInput
											prompt=""
											initialValue={typeof value === 'string' ? value : ''}
											allowEmpty
											placeholder={m.format(null as never)}
											onSubmit={text => {
												setTyping(false);
												void write(m.key, m.parse!(text));
											}}
											onCancel={() => setTyping(false)}
										/>
									</Box>
								) : (
								<Text key={m.key} wrap="truncate">
									<Text color={theme.accent}>{selected ? `${icons.pointer} ` : '  '}</Text>
									<Text bold={selected}>{m.label.padEnd(LABEL_WIDTH)}</Text>
									<Text color={selected ? theme.accent : undefined}>
										{selected && m.options.length ? '‹ ' : '  '}
										{m.format(value).padEnd(VALUE_WIDTH)}
										{selected && m.options.length ? ' ›' : '  '}
									</Text>
									{notInstalled ? <Text color={theme.warn}> {icons.warn} not installed</Text> : null}
									<Text color={theme.muted}>  {sourceLabel(tab, scoped.sources[m.key])}</Text>
								</Text>
								)
							);
						})}
					</Box>
					<Paragraph>{selectedMeta.help(scoped.values[selectedMeta.key])}</Paragraph>
					{tab === 'global' && ctx.settings.sources[selectedMeta.key] === 'repo' ? (
						<Text color={theme.muted}>This repo overrides it with: {selectedMeta.format(ctx.settings.values[selectedMeta.key])}</Text>
					) : null}
				</Box>
			)}

			<Box flexGrow={1} />
			{flash ? (
				<Text color={theme.ok}>
					{icons.ok} {flash}
				</Text>
			) : null}
		</Frame>
	);
}

const TAB_LABEL: Record<Tab, string> = {repo: 'This repo', global: 'Global defaults', providers: 'Agent CLIs'};

function sourceLabel(tab: Tab, source: SettingSource): string {
	if (tab === 'repo') return source === 'repo' ? 'set here' : `from ${source}`;
	return source === 'default' ? 'default' : 'set';
}
