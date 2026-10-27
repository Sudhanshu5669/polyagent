import {Box, Text} from 'ink';
import {tildify} from '../../core/paths.js';
import {PROVIDERS, PROVIDER_IDS, type ProviderId} from '../../core/providers.js';
import {theme} from '../theme.js';
import type {AddState} from '../useAddProvider.js';
import {Menu} from './Menu.js';
import {PathInput} from './PathInput.js';
import {Spinner} from './Spinner.js';

interface Props {
	state: AddState;
	onSubmitPath: (path: string) => void;
	onConfirm: (provider: ProviderId, path: string, version: string) => void;
	onCancel: () => void;
}

/** The UI half of useAddProvider. Renders nothing while idle. */
export function AddProviderFlow({state, onSubmitPath, onConfirm, onCancel}: Props) {
	switch (state.step) {
		case 'idle':
			return null;
		case 'typing':
			return (
				<Box flexDirection="column">
					<Text bold>Path to the CLI executable</Text>
					<Text color={theme.muted}>Tab completes. Esc goes back.</Text>
					<Box marginTop={1}>
						<PathInput initialValue={state.initial} placeholder="e.g. ~/.local/bin/claude" onSubmit={onSubmitPath} onCancel={onCancel} />
					</Box>
					{state.error ? <Text color={theme.fail}>{state.error}</Text> : null}
				</Box>
			);
		case 'probing':
			return (
				<Text>
					<Spinner /> Running {tildify(state.path)} --version…
				</Text>
			);
		case 'confirm': {
			const ordered = state.guess ? [state.guess, ...PROVIDER_IDS.filter(id => id !== state.guess)] : [...PROVIDER_IDS];
			return (
				<Box flexDirection="column">
					<Text bold>Which tool is this?</Text>
					<Text color={theme.muted} wrap="truncate">
						{tildify(state.path)} reports: {state.version}
					</Text>
					<Box marginTop={1}>
						<Menu
							items={[
								...ordered.map(id => ({
									label: PROVIDERS[id].label,
									value: id as ProviderId | 'cancel',
									hint: id === state.guess ? 'detected' : undefined,
								})),
								{label: 'Cancel', value: 'cancel' as const},
							]}
							onSelect={choice => (choice === 'cancel' ? onCancel() : onConfirm(choice, state.path, state.version))}
						/>
					</Box>
				</Box>
			);
		}
	}
}
