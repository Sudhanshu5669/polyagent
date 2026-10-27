import {Box, Text} from 'ink';
import {useContext} from 'react';
import {describeRequest} from '../../core/approvals.js';
import {AgentNamesContext, usePendingApprovals} from '../approvalsContext.js';
import {theme} from '../theme.js';

/** The banner every frame shows while someone is waiting for an answer. */
export function ApprovalBanner() {
	const pending = usePendingApprovals();
	const nameOf = useContext(AgentNamesContext);
	const first = pending[0];
	if (!first) return null;
	return (
		<Box paddingX={1}>
			<Text color={theme.warn} wrap="truncate">
				⚑ {nameOf(first.agent)} wants to {describeRequest(first)}
				{pending.length > 1 ? ` (+${pending.length - 1} more)` : ''} · <Text bold>ctrl+a</Text> to answer
			</Text>
		</Box>
	);
}
