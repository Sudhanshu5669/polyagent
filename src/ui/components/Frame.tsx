import {Box, Text, useWindowSize} from 'ink';
import type {ReactNode} from 'react';
import {MIN_COLUMNS, MIN_ROWS, theme} from '../theme.js';
import {ApprovalBanner} from './ApprovalBanner.js';
import {KeyHints, type Hint} from './KeyHints.js';

interface Props {
	title: string;
	/** Right side of the header, e.g. provider badges. */
	right?: ReactNode;
	hints: Hint[];
	/** One line above the key hints, for confirmations and transient messages. */
	notice?: ReactNode;
	/** The approval prompt hides the banner that points to it. */
	hideApprovalBanner?: boolean;
	children: ReactNode;
}

/** Full-screen layout shared by every screen: header, bordered body, key-hint footer. */
export function Frame({title, right, hints, notice, hideApprovalBanner, children}: Props) {
	const {columns, rows} = useWindowSize();

	if (columns < MIN_COLUMNS || rows < MIN_ROWS) {
		return (
			<Box height={rows} width={columns} alignItems="center" justifyContent="center" flexDirection="column">
				<Text>Terminal too small</Text>
				<Text color={theme.muted}>
					Resize to at least {MIN_COLUMNS}×{MIN_ROWS} (now {columns}×{rows})
				</Text>
			</Box>
		);
	}

	return (
		<Box flexDirection="column" height={rows} width={columns}>
			<Box paddingX={1}>
				{/* Long repo paths shrink from the middle so the folder name and the badges stay visible. */}
				<Box flexGrow={1} flexShrink={1}>
					<Text bold wrap="truncate-middle">
						{title}
					</Text>
				</Box>
				{right ? (
					<Box flexShrink={0} marginLeft={2}>
						{right}
					</Box>
				) : null}
			</Box>
			<Box borderStyle="round" borderColor={theme.border} flexGrow={1} flexDirection="column" paddingX={1} overflow="hidden">
				{children}
			</Box>
			{hideApprovalBanner ? null : <ApprovalBanner />}
			{notice ? <Box paddingX={1}>{notice}</Box> : null}
			<KeyHints hints={hints} />
		</Box>
	);
}
