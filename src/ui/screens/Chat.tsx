import {Box, Text, useAnimation, useWindowSize} from 'ink';
import {useKeys} from '../input.js';
import {useEffect, useMemo, useState, useSyncExternalStore} from 'react';
import {ADAPTERS} from '../../core/agents/runner.js';
import type {EmployeeChat} from '../../core/chat.js';
import type {Employee} from '../../core/employees.js';
import {PROVIDERS} from '../../core/providers.js';
import {Frame} from '../components/Frame.js';
import type {Hint} from '../components/KeyHints.js';
import {RoleTag} from '../components/RoleTag.js';
import {Spinner} from '../components/Spinner.js';
import {TextInput} from '../components/TextInput.js';
import {buildRows, Viewport} from '../components/Transcript.js';
import {usePendingApprovals} from '../approvalsContext.js';
import {icons, theme} from '../theme.js';

interface Props {
	employee: Employee;
	chat: EmployeeChat;
	/** Path of the provider's CLI, or undefined when it isn't installed. */
	binary?: string;
	cwd: string;
	/** Routes Claude Code approval requests to the user, when approvals are on. */
	approvalArgs?: string[];
	onBack: () => void;
}

// Header, two border lines, divider, status line, input line, key hints.
const CHROME_ROWS = 7;

export function Chat({employee, chat, binary, cwd, approvalArgs, onBack}: Props) {
	useSyncExternalStore(chat.subscribe, () => chat.version);
	const pending = usePendingApprovals();
	const {columns, rows} = useWindowSize();
	const [offset, setOffset] = useState(0);
	const [details, setDetails] = useState(false);
	const [confirmReset, setConfirmReset] = useState(false);
	const [notice, setNotice] = useState<string>();

	const width = columns - 4;
	const height = Math.max(3, rows - CHROME_ROWS - (notice || confirmReset ? 1 : 0));
	const allRows = useMemo(
		() => buildRows(chat.entries, employee.name, employee.role, width, details),
		// chat.version changes whenever entries do.
		[chat.version, employee.name, employee.role, width, details],
	);
	const maxOffset = Math.max(0, allRows.length - height);

	// New output while scrolled up keeps your place instead of jumping.
	useEffect(() => setOffset(o => Math.min(o, maxOffset)), [maxOffset]);

	const page = Math.max(1, height - 2);
	useKeys((input, key) => {
		if (confirmReset) {
			if (input === 'y') void chat.reset().then(() => setNotice('Started a fresh session.'));
			setConfirmReset(false);
			return;
		}

		if (key.escape) return onBack();
		if (key.upArrow) setOffset(o => Math.min(maxOffset, o + 1));
		else if (key.downArrow) setOffset(o => Math.max(0, o - 1));
		else if (key.pageUp) setOffset(o => Math.min(maxOffset, o + page));
		else if (key.pageDown) setOffset(o => Math.max(0, o - page));
		else if (key.ctrl && input === 'g') setOffset(0);
		else if (key.ctrl && input === 'o') setDetails(d => !d);
		else if (key.ctrl && input === 'n') {
			if (chat.working) setNotice(`Wait for ${employee.name} to finish, or press ctrl+c to stop.`);
			else setConfirmReset(true);
		}
	});

	const send = (text: string) => {
		setNotice(undefined);
		if (chat.working) {
			setNotice(`${employee.name} is still working. Wait, or press ctrl+c to stop.`);
			return;
		}

		if (!binary) {
			setNotice(`${PROVIDERS[employee.provider].label} isn't installed. Set it up in Settings → Agent CLIs, or edit ${employee.name}.`);
			return;
		}

		setOffset(0);
		void chat.send(employee, binary, cwd, text, {approvalArgs}).catch((error: Error) => setNotice(error.message));
	};

	const adapter = ADAPTERS[employee.provider];
	const title = `${employee.name} · ${PROVIDERS[employee.provider].label} · ${employee.permissions}${employee.model ? ` · ${employee.model}` : ''}`;
	const hints: Hint[] = confirmReset
		? [['y', 'start fresh'], ['any key', 'cancel']]
		: [['⏎', 'send'], ['↑↓ pgup pgdn', 'scroll'], ['ctrl+o', details ? 'hide details' : 'details'], ['ctrl+n', 'new session'], ['ctrl+c', 'stop'], ['esc', 'back']];

	return (
		<Frame
			title={title}
			right={
				<Text>
					<RoleTag role={employee.role} />
					<Text color={theme.muted}> {chat.sessionId ? `session ${chat.sessionId.slice(0, 8)}` : 'new session'}</Text>
				</Text>
			}
			hints={hints}
			notice={
				confirmReset ? (
					<Text color={theme.warn}>Clear this chat and start a new session? {employee.name} will forget this conversation.</Text>
				) : notice ? (
					<Text color={theme.warn}>{notice}</Text>
				) : undefined
			}
		>
			{allRows.length === 0 ? (
				<Box height={height} flexDirection="column" justifyContent="flex-end">
					<Text color={theme.muted}>
						Talk to {employee.name} directly. They work in {cwd} with {employee.permissions} permissions.
					</Text>
					{!adapter.verified ? (
						<Text color={theme.warn}>
							{icons.warn} {PROVIDERS[employee.provider].label} support is experimental: polyagent hasn't been verified against its output yet.
						</Text>
					) : null}
				</Box>
			) : (
				<Viewport rows={allRows} height={height} offset={offset} />
			)}
			<Text color={theme.border}>{'─'.repeat(width)}</Text>
			<StatusLine chat={chat} name={employee.name} offset={offset} waiting={pending.some(r => r.agent === employee.id)} />
			<TextInput placeholder={`Message ${employee.name}`} onSubmit={send} clearOnSubmit isActive={!confirmReset} />
		</Frame>
	);
}

function StatusLine({chat, name, offset, waiting}: {chat: EmployeeChat; name: string; offset: number; waiting: boolean}) {
	// Ticks once a second so the elapsed time stays current.
	useAnimation({interval: 1000, isActive: chat.working});
	if (chat.working && waiting) {
		return (
			<Text color={theme.warn}>
				⚑ {name} is waiting for your approval · <Text bold>ctrl+a</Text> to answer
			</Text>
		);
	}

	if (chat.working) {
		const seconds = Math.round((Date.now() - (chat.startedAt ?? Date.now())) / 1000);
		return (
			<Text>
				<Spinner /> {name} is working · {seconds}s<Text color={theme.muted}> · ctrl+c to stop</Text>
			</Text>
		);
	}

	if (offset > 0) return <Text color={theme.muted}>Scrolled up {offset} lines · ctrl+g to jump to the latest</Text>;
	return <Text> </Text>;
}
