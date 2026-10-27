import {Box, Text} from 'ink';
import type {Detection} from '../../core/detect.js';
import {tildify} from '../../core/paths.js';
import {PROVIDERS, PROVIDER_IDS, type ProviderId} from '../../core/providers.js';
import {icons, theme} from '../theme.js';
import {Spinner} from './Spinner.js';

const LABEL_WIDTH = Math.max(...PROVIDER_IDS.map(id => PROVIDERS[id].label.length));

interface Props {
	detections: Partial<Record<ProviderId, Detection>>;
	/** Highlight one row (used by the Providers settings tab). */
	selected?: ProviderId;
}

/** One line per provider: status icon, name, path, version. A missing entry in `detections` means "still scanning". */
export function ProviderRows({detections, selected}: Props) {
	return (
		<Box flexDirection="column">
			{PROVIDER_IDS.map(id => {
				const d = detections[id];
				const label = PROVIDERS[id].label.padEnd(LABEL_WIDTH);
				const pointer = selected === undefined ? '' : selected === id ? `${icons.pointer} ` : '  ';
				return (
					<Text key={id} wrap="truncate">
						<Text color={theme.accent}>{pointer}</Text>
						{d === undefined ? <Spinner /> : <StatusIcon d={d} />}
						<Text bold={selected === id}> {label}  </Text>
						<Detail d={d} />
					</Text>
				);
			})}
		</Box>
	);
}

function StatusIcon({d}: {d: Detection}) {
	if (d.status === 'found') return <Text color={theme.ok}>{icons.ok}</Text>;
	return <Text color={theme.fail}>{icons.fail}</Text>;
}

function Detail({d}: {d: Detection | undefined}) {
	if (d === undefined) return <Text color={theme.muted}>looking…</Text>;
	switch (d.status) {
		case 'found':
			// Version first: long paths get truncated at the end of the line.
			return (
				<Text>
					<Text color={theme.muted}>{d.version}  </Text>
					{tildify(d.path)}
				</Text>
			);
		case 'broken':
			return (
				<Text>
					<Text color={theme.fail}>doesn't run: {d.error}  </Text>
					{tildify(d.path)}
				</Text>
			);
		case 'missing':
			return <Text color={theme.muted}>not found</Text>;
	}
}

/** Compact header badges: "claude ✓  codex ✗  agy ✗". */
export function ProviderBadges({detections}: {detections: Partial<Record<ProviderId, Detection>>}) {
	return (
		<Text>
			{PROVIDER_IDS.map((id, i) => {
				const d = detections[id];
				return (
					<Text key={id}>
						{i > 0 ? '  ' : ''}
						<Text color={theme.muted}>{PROVIDERS[id].bins[0]} </Text>
						{d === undefined ? <Spinner /> : <StatusIcon d={d} />}
					</Text>
				);
			})}
		</Text>
	);
}
