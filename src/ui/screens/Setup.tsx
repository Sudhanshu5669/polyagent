import {Box, Text, useApp} from 'ink';
import {useKeys} from '../input.js';
import {useCallback, useEffect, useState} from 'react';
import type {GlobalConfig} from '../../core/config.js';
import {applyDetections, detectProvider, type Detection} from '../../core/detect.js';
import {PROVIDERS, PROVIDER_IDS, type ProviderId} from '../../core/providers.js';
import {AddProviderFlow} from '../components/AddProviderFlow.js';
import {Frame} from '../components/Frame.js';
import type {Hint} from '../components/KeyHints.js';
import {Menu} from '../components/Menu.js';
import {ProviderRows} from '../components/ProviderRows.js';
import {theme} from '../theme.js';
import {useAddProvider} from '../useAddProvider.js';

type Detections = Partial<Record<ProviderId, Detection>>;
type Choice = 'continue' | 'add' | 'install' | 'rescan' | 'quit';

interface Props {
	config: GlobalConfig;
	onDone: (config: GlobalConfig, detections: Detections) => void;
}

/** First-run wizard: find the agent CLIs, let the user add one by path, then save. */
export function Setup({config, onDone}: Props) {
	const {exit} = useApp();
	const [detections, setDetections] = useState<Detections>({});
	const [showInstall, setShowInstall] = useState(false);
	const add = useAddProvider();

	const scan = useCallback(() => {
		setDetections({});
		for (const id of PROVIDER_IDS) {
			void detectProvider(id, config.providers[id]).then(d => setDetections(prev => ({...prev, [id]: d})));
		}
	}, [config]);

	useEffect(scan, [scan]);

	const scanning = PROVIDER_IDS.some(id => detections[id] === undefined);
	const found = PROVIDER_IDS.filter(id => detections[id]?.status === 'found');
	const missing = PROVIDER_IDS.filter(id => detections[id]?.status !== 'found');
	const inMenu = add.state.step === 'idle' && !showInstall;

	useKeys(
		(input, key) => {
			if (showInstall && (key.escape || key.return || input === 'q')) setShowInstall(false);
			else if (inMenu && input === 'q') exit();
		},
		{isActive: add.state.step === 'idle'},
	);

	const choose = (choice: Choice) => {
		if (choice === 'continue') onDone(applyDetections(config, Object.values(detections)), detections);
		else if (choice === 'add') add.start();
		else if (choice === 'install') setShowInstall(true);
		else if (choice === 'rescan') scan();
		else exit();
	};

	const continueLabel = found.length > 0 ? `Continue with ${listOf(found.map(id => PROVIDERS[id].label))}` : 'Continue';

	const hints: Hint[] = showInstall
		? [['esc', 'back']]
		: add.state.step === 'idle'
			? [['↑↓', 'move'], ['⏎', 'choose'], ['q', 'quit']]
			: [['⏎', 'confirm'], ['esc', 'back']];

	return (
		<Frame title="polyagent · first-time setup" hints={hints}>
			<Text color={theme.muted}>polyagent runs your agent CLIs as a team. Looking for the ones you have installed:</Text>
			<Box marginY={1}>
				<ProviderRows detections={detections} />
			</Box>

			{showInstall ? (
				<InstallHelp missing={missing} />
			) : add.state.step !== 'idle' ? (
				<AddProviderFlow
					state={add.state}
					onSubmitPath={p => void add.submitPath(p)}
					onCancel={add.cancel}
					onConfirm={(provider, path, version) => {
						setDetections(prev => ({...prev, [provider]: {provider, status: 'found', path, version, source: 'manual'}}));
						add.cancel();
					}}
				/>
			) : scanning ? null : (
				<>
					{found.length === 0 ? (
						<Box marginBottom={1}>
							<Text color={theme.warn}>No agent CLIs found. Install at least one, or add its path if it's installed somewhere unusual.</Text>
						</Box>
					) : null}
					<Menu<Choice>
						items={[
							{label: continueLabel, value: 'continue', disabled: found.length === 0},
							{label: 'Add a CLI by path…', value: 'add'},
							{label: 'Show install commands', value: 'install', disabled: missing.length === 0},
							{label: 'Look again', value: 'rescan'},
							{label: 'Quit', value: 'quit'},
						]}
						onSelect={choose}
						isActive={inMenu}
					/>
				</>
			)}
		</Frame>
	);
}

function InstallHelp({missing}: {missing: ProviderId[]}) {
	return (
		<Box flexDirection="column">
			{missing.map(id => {
				const def = PROVIDERS[id];
				return (
					<Box key={id} flexDirection="column" marginBottom={1}>
						<Text bold>{def.label}</Text>
						{def.install.map(cmd => (
							<Text key={cmd}>
								{'  '}
								<Text color={theme.accent}>{cmd}</Text>
							</Text>
						))}
						<Text color={theme.muted}>  {def.docsUrl}</Text>
					</Box>
				);
			})}
			<Text color={theme.muted}>Install in another terminal, then choose "Look again".</Text>
		</Box>
	);
}

function listOf(items: string[]): string {
	if (items.length <= 1) return items.join('');
	return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}
