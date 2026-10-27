import {Box, Text} from 'ink';
import {useContext, useState} from 'react';
import {describeRequest, ruleFor} from '../../core/approvals.js';
import type {Employee} from '../../core/employees.js';
import {ApprovalsContext, usePendingApprovals} from '../approvalsContext.js';
import {Frame} from '../components/Frame.js';
import type {Hint} from '../components/KeyHints.js';
import {Menu} from '../components/Menu.js';
import {RoleTag} from '../components/RoleTag.js';
import {TextInput} from '../components/TextInput.js';
import {useKeys} from '../input.js';
import {icons, theme} from '../theme.js';

type Choice = 'allow' | 'always' | 'deny' | 'deny-why';

interface Props {
	employees: Employee[];
	onClose: () => void;
}

/** Full-screen prompt for the oldest pending request. Closes itself when none are left. */
export function ApprovalPrompt({employees, onClose}: Props) {
	const broker = useContext(ApprovalsContext)!;
	const pending = usePendingApprovals();
	const [reasoning, setReasoning] = useState(false);
	const request = pending[0];
	const employee = employees.find(e => e.id === request?.agent);
	const name = employee?.name ?? request?.agent ?? '';

	const decide = (choice: Choice, message?: string) => {
		if (!request) return;
		if (choice === 'deny-why') return setReasoning(true);
		broker.decide(request.id, choice, message);
		setReasoning(false);
		if (pending.length <= 1) onClose();
	};

	useKeys(
		(input, key) => {
			if (key.escape) return onClose();
			if (input === 'y') decide('allow');
			else if (input === 'a') decide('always');
			else if (input === 'n') decide('deny');
		},
		{isActive: !reasoning},
	);

	if (!request) {
		return (
			<Frame title="polyagent · approvals" hints={[['esc', 'back']]}>
				<Text color={theme.muted}>Nothing is waiting for you.</Text>
			</Frame>
		);
	}

	const hints: Hint[] = reasoning ? [['⏎', 'deny with this reason'], ['esc', 'back']] : [['y', 'allow'], ['a', 'always'], ['n', 'deny'], ['↑↓ ⏎', 'choose'], ['esc', 'later']];
	const details = JSON.stringify(request.input, null, 2).split('\n');

	return (
		<Frame
			hideApprovalBanner
			title="polyagent · approval needed"
			right={<Text color={theme.muted}>{pending.length > 1 ? `1 of ${pending.length} waiting` : 'waiting for you'}</Text>}
			hints={hints}
		>
			<Text wrap="truncate">
				<Text bold>{name}</Text> {employee ? <RoleTag role={employee.role} /> : null} wants to <Text bold>{describeRequest(request)}</Text>
			</Text>
			<Box flexDirection="column" marginY={1} flexShrink={0}>
				<Text color={theme.muted}>{request.toolName}</Text>
				{details.slice(0, 12).map((line, i) => (
					<Text key={i} color={theme.muted} wrap="truncate">
						{'  '}
						{line}
					</Text>
				))}
				{details.length > 12 ? <Text color={theme.muted}>  …</Text> : null}
			</Box>
			{reasoning ? (
				<Box flexDirection="column">
					<Text>Tell {name} why (they'll carry on without it):</Text>
					<TextInput placeholder="e.g. Don't install packages; use what's already there" onSubmit={text => decide('deny', text)} onCancel={() => setReasoning(false)} />
				</Box>
			) : (
				<Menu<Choice>
					items={[
						{label: 'Allow once', value: 'allow'},
						{label: `Always allow ${ruleFor(request.toolName, request.input)}`, value: 'always', hint: `for ${name}, until polyagent quits`},
						{label: 'Deny', value: 'deny'},
						{label: 'Deny and say why…', value: 'deny-why'},
					]}
					onSelect={decide}
				/>
			)}
			<Box flexGrow={1} />
			<Text color={theme.muted}>
				{icons.dot} {name} is paused until you answer. Esc leaves it waiting.
			</Text>
		</Frame>
	);
}
