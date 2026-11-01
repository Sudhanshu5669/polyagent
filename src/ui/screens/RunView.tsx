import {Box, measureElement, Text, useAnimation, useWindowSize, type DOMElement} from 'ink';
import {useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject} from 'react';
import type {Employee} from '../../core/employees.js';
import {COMMANDS, parseInput, suggest} from '../../core/run/input.js';
import type {RunEngine} from '../../core/run/engine.js';
import {estimateEta, excerpt, formatClock, formatSpan, formatTokens, runProgress} from '../../core/run/progress.js';
import {isFinished, ORCHESTRATOR} from '../../core/run/types.js';
import {Paragraph} from '../components/Paragraph.js';
import {usePendingApprovals} from '../approvalsContext.js';
import {useKeys} from '../input.js';
import {buildFeed, FeedView} from '../run/Feed.js';
import {useMouse} from '../mouse.js';
import {FocusMain, Sidebar, SIDEBAR_MAX, SIDEBAR_MIN, tabOffsets, tabsFor, type Tab} from '../run/Focus.js';
import {LaneRow, lanesFor} from '../run/Lanes.js';
import {Palette, type PaletteItem} from '../run/Palette.js';
import {CostPanel, MergePanel} from '../run/Panels.js';
import {Bar, Canvas, makeWho, type KeyHint} from '../run/parts.js';
import {Prompt} from '../run/Prompt.js';
import {TasksView} from '../run/Tasks.js';
import {theme} from '../theme.js';

type View = {name: 'briefing'} | {name: 'focus'; agent: string; tab: Tab} | {name: 'tasks'; row: number};
type Panel = 'cost' | 'merge';

interface Props {
	run: RunEngine;
	onBack: () => void;
	/** Continue a run that was interrupted when polyagent last quit. */
	onContinue: () => void;
	/** /hire: go to the hire form. */
	onHire?: () => void;
	/** /fire: let an employee go. */
	onFire?: (employee: Employee) => void;
}

/** How long away counts as away. */
const AWAY_MS = 60_000;
/** After this much quiet, the next key press opens an "away" window. */
const IDLE_MS = 5 * 60_000;
/** How long the "while you were away" banner stays before the feed goes back to plain activity. */
const AWAY_SHOWN_MS = 5 * 60_000;

export function RunView({run, onBack, onContinue, onHire, onFire}: Props) {
	useSyncExternalStore(run.subscribe, () => run.version);
	const pending = usePendingApprovals();
	// Ticks once a second for the clocks.
	useAnimation({interval: 1000, isActive: !isFinished(run.state.status)});
	const {columns, rows} = useWindowSize();
	const {state} = run;
	const now = Date.now();

	const [view, setView] = useState<View>({name: 'briefing'});
	const [typing, setTyping] = useState(false);
	const [typingKey, setTypingKey] = useState(0);
	const [initialText, setInitialText] = useState('');
	const [palette, setPalette] = useState(false);
	const [panel, setPanel] = useState<Panel>();
	const [selectedEvent, setSelectedEvent] = useState<number>();
	const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
	const [offset, setOffset] = useState(0);
	const [details, setDetails] = useState(false);
	const [sidebar, setSidebar] = useState(26);
	const [notice, setNotice] = useState<string>();
	const [draft, setDraft] = useState('');

	// Where things are on screen, for the mouse.
	const lanesRef = useRef<DOMElement>(null);
	const feedRef = useRef<DOMElement>(null);
	const promptRef = useRef<DOMElement>(null);
	const sidebarRef = useRef<DOMElement>(null);
	const dividerRef = useRef<DOMElement>(null);
	const tabsRef = useRef<DOMElement>(null);
	const feedHit = useRef<(row: number) => number | undefined>(() => undefined);
	const dragging = useRef(false);

	// "While you were away": since the last time anyone looked at this run.
	const [awaySince, setAwaySince] = useState<number | undefined>(() => {
		const seen = run.lastViewedAt;
		return seen && !isFinished(run.state.status) && Date.now() - seen >= AWAY_MS ? seen : undefined;
	});
	const attachedAt = useRef(Date.now());
	const lastKey = useRef(Date.now());
	useEffect(
		() => () => {
			run.lastViewedAt = Date.now();
		},
		[run],
	);

	const tellUser = (text: string) => {
		setNotice(text);
	};

	useEffect(() => {
		if (!notice) return;
		const timer = setTimeout(() => setNotice(undefined), 6000);
		return () => clearTimeout(timer);
	}, [notice]);

	const who = useMemo(() => makeWho(run.employees), [run.employees, state.tasks.length]);
	const lanes = lanesFor(run);
	const finished = isFinished(state.status);
	const interrupted = run.interrupted;
	const awaiting = state.status === 'awaiting-approval';
	const needsYou = (id: string) => pending.some(r => r.agent === id);

	const width = columns - 4;
	const agentAt = (index: number) => lanes[index]?.agent;
	const openAgent = (agent: string, tab: Tab = 'stream') => {
		setOffset(0);
		setView({name: 'focus', agent, tab});
	};

	const showAway = awaySince !== undefined && now - attachedAt.current < AWAY_SHOWN_MS;
	const layout = useMemo(
		() => buildFeed({events: state.events, who, width, selected: selectedEvent, expanded, awaySince: showAway ? awaySince : undefined, now}),
		// `now` only matters for the "away" label; minute resolution is plenty.
		[state.events.length, who, width, selectedEvent, expanded, awaySince, showAway, Math.floor(now / 60_000)],
	);

	const focusEmployee = view.name === 'focus' ? run.employees.find(e => e.id === view.agent) : undefined;

	const moveEvent = (delta: number) => {
		const order = layout.order;
		if (order.length === 0) return;
		const at = selectedEvent === undefined ? -1 : order.findIndex(e => e.id === selectedEvent);
		const next = Math.max(0, Math.min(order.length - 1, (at === -1 ? (delta > 0 ? -1 : 0) : at) + delta));
		setSelectedEvent(order[next]!.id);
	};

	const toggleExpanded = (id: number) =>
		setExpanded(current => {
			const next = new Set(current);
			if (!next.delete(id)) next.add(id);
			return next;
		});

	const startTyping = (initial = '') => {
		setInitialText(initial);
		setDraft(initial);
		setTypingKey(k => k + 1);
		setTyping(true);
	};

	const runCommand = (name: string, employee?: Employee) => {
		switch (name) {
			case 'hire':
				return onHire ? onHire() : tellUser('Hire people from the dashboard.');
			case 'fire':
				if (!employee) return;
				if (run.state.tasks.some(t => t.assignee === employee.id && ['blocked', 'ready', 'running'].includes(t.status))) return tellUser(`${employee.name} still has work in this run. Try again when it's done.`);
				return onFire ? onFire(employee) : tellUser('Let people go from the dashboard.');
			case 'merge':
				return setPanel('merge');
			case 'cost':
				return setPanel('cost');
			case 'tasks':
				return setView({name: 'tasks', row: 0});
			case 'pause':
				return finished || interrupted ? undefined : run.pause();
			case 'resume':
				return run.resume();
			case 'stop':
				return finished ? undefined : run.cancel();
		}
	};

	const submit = (text: string) => {
		const parsed = parseInput(text, run.employees, focusEmployee);
		switch (parsed.kind) {
			case 'error':
				return tellUser(parsed.message);
			case 'tell':
				return run.tell(parsed.text);
			case 'employee': {
				const busy = run.isBusy(parsed.employee.id);
				run.tellEmployee(parsed.employee.id, parsed.text);
				return tellUser(busy ? `${parsed.employee.name} is mid-task; they'll get it with their next one.` : `Sent to ${parsed.employee.name}. The orchestrator knows too.`);
			}

			case 'command':
				setTyping(false);
				return runCommand(parsed.name, parsed.employee);
		}
	};

	const paletteItems = (): PaletteItem[] => {
		const items: PaletteItem[] = [];
		for (const lane of lanes) {
			const w = who(lane.agent);
			items.push({id: `open-${lane.agent}`, group: 'Employees', label: `Open ${w.name}`, hint: lane.employee?.role ?? 'orchestrator', lead: <Text color={w.color}>{w.glyph}</Text>, run: () => openAgent(lane.agent)});
		}

		state.tasks.forEach((t, row) => items.push({id: `task-${t.id}`, group: 'Tasks', label: `${t.id}: ${t.title}`, hint: `${who(t.assignee).name} · ${t.status}`, run: () => setView({name: 'tasks', row})}));
		for (const e of [...state.events].reverse().slice(0, 40)) {
			items.push({
				id: `event-${e.id}`,
				group: 'Events',
				label: `${who(e.agent).name} ${e.text}`,
				run: () => {
					setView({name: 'briefing'});
					setSelectedEvent(e.id);
					setExpanded(c => new Set(c).add(e.id));
				},
			});
		}

		for (const c of COMMANDS) {
			if (c.name === 'fire') {
				for (const e of run.employees) items.push({id: `fire-${e.id}`, group: 'Commands', label: `/fire ${e.id}`, hint: c.help, run: () => runCommand('fire', e)});
			} else items.push({id: `cmd-${c.name}`, group: 'Commands', label: `/${c.name}`, hint: c.help, run: () => runCommand(c.name)});
		}

		items.push({id: 'back', group: 'Commands', label: 'Back to the dashboard', hint: finished ? '' : 'the run keeps going', run: onBack});
		return items;
	};

	useKeys((input, key) => {
		const at = Date.now();
		if (at - lastKey.current > IDLE_MS && !finished) setAwaySince(lastKey.current);
		lastKey.current = at;

		if (key.ctrl && input === 'k') return setPalette(p => !p);
		if (palette) return;
		if (key.ctrl && input === 't') return setView(v => (v.name === 'tasks' ? {name: 'briefing'} : {name: 'tasks', row: 0}));
		if (key.ctrl && input === 'r' && interrupted) return onContinue();
		if (key.ctrl && input === 'p' && !finished && !interrupted) return state.paused ? run.resume() : run.pause();
		if (key.ctrl && input === 'o') return setDetails(d => !d);
		if (typing) return;

		if (panel) {
			if (key.escape || input === 'q') setPanel(undefined);
			return;
		}

		const printable = input.length === 1 && !key.ctrl && !key.meta && input >= ' ';

		if (view.name === 'tasks') {
			if (key.escape || input === 'q') return setView({name: 'briefing'});
			if (key.upArrow || input === 'k') setView({name: 'tasks', row: Math.max(0, view.row - 1)});
			else if (key.downArrow || input === 'j') setView({name: 'tasks', row: Math.min(state.tasks.length - 1, view.row + 1)});
			return;
		}

		if (view.name === 'focus') {
			const tabs = tabsFor(view.agent);
			const index = lanes.findIndex(l => l.agent === view.agent);
			const go = (next: number) => {
				const agent = agentAt((next + lanes.length) % lanes.length)!;
				setOffset(0);
				setView({name: 'focus', agent, tab: tabsFor(agent).includes(view.tab) ? view.tab : 'stream'});
			};
			const page = Math.max(1, rows - 12);
			const fromTop = view.tab === 'diff';
			const up = fromTop ? -1 : 1;
			if (key.escape) return setView({name: 'briefing'});
			if (input === 'q') return onBack();
			if (input === 'j') return go(index + 1);
			if (input === 'k') return go(index - 1);
			if (/^[0-9]$/.test(input)) {
				const agent = agentAt(Number(input));
				return agent ? openAgent(agent, tabs.includes(view.tab) ? view.tab : 'stream') : undefined;
			}

			if (key.tab) {
				const next = tabs[(tabs.indexOf(view.tab) + (key.shift ? -1 : 1) + tabs.length) % tabs.length]!;
				setOffset(0);
				return setView({...view, tab: next});
			}

			if (key.upArrow) return setOffset(o => Math.max(0, o + up));
			if (key.downArrow) return setOffset(o => Math.max(0, o - up));
			if (key.pageUp) return setOffset(o => Math.max(0, o + up * page));
			if (key.pageDown) return setOffset(o => Math.max(0, o - up * page));
			if (input === 'g') return setOffset(0);
			if (key.return || input === 'i') return startTyping();
			if (input === '/' || input === '@') return startTyping(input);
			if (printable) return startTyping(input);
			return;
		}

		// Briefing, normal mode.
		if (key.escape || input === 'q') return onBack();
		if (/^[0-9]$/.test(input)) {
			const agent = agentAt(Number(input));
			return agent ? openAgent(agent) : undefined;
		}

		if (input === 'j' || key.downArrow) return moveEvent(1);
		if (input === 'k' || key.upArrow) return moveEvent(-1);
		if (input === 'g') return setSelectedEvent(undefined);
		if (input === 'G') return setSelectedEvent(layout.order.at(-1)?.id);
		if (key.return) {
			if (awaiting) return run.approve();
			const target = selectedEvent ?? layout.order[0]?.id;
			if (target !== undefined) {
				setSelectedEvent(target);
				toggleExpanded(target);
			}

			return;
		}

		if (input === 'i') return startTyping();
		if (input === '/' || input === '@') return startTyping(input);
		if (printable) return startTyping(input);
	});

	// Mouse -------------------------------------------------------------------
	const rect = (ref: RefObject<DOMElement | null>) => (ref.current ? measureElement(ref.current) : undefined);
	const inside = (r: ReturnType<typeof rect>, e: {x: number; y: number}) => r !== undefined && e.x >= r.x && e.x < r.x + r.width && e.y >= r.y && e.y < r.y + r.height;
	useMouse(e => {
		lastKey.current = Date.now();
		if (palette) return;
		const wheel = e.kind === 'wheel-up' ? -1 : e.kind === 'wheel-down' ? 1 : 0;
		if (panel) return;

		if (wheel) {
			if (view.name === 'briefing') return moveEvent(wheel * 2);
			if (view.name === 'tasks') return setView({name: 'tasks', row: Math.max(0, Math.min(state.tasks.length - 1, view.row + wheel))});
			// Streams stick to the bottom (up = older); a diff reads from the top (down = further in).
			const towardsMore = view.tab === 'diff' ? wheel : -wheel;
			return setOffset(o => Math.max(0, o + towardsMore * 3));
		}

		if (e.kind === 'up') {
			dragging.current = false;
			return;
		}

		if (e.kind === 'drag') {
			const side = rect(sidebarRef);
			if (dragging.current && side) setSidebar(Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, e.x - side.x)));
			return;
		}

		if (e.kind !== 'down' || e.button !== 0) return;

		// Clicking the prompt starts typing; clicking anywhere else while typing just leaves the prompt alone.
		if (inside(rect(promptRef), e)) return typing ? undefined : startTyping();
		if (typing) return;

		if (view.name === 'briefing') {
			const lanesRect = rect(lanesRef);
			if (lanesRect && inside(lanesRect, e)) {
				const agent = agentAt(e.y - lanesRect.y);
				return agent ? openAgent(agent) : undefined;
			}

			const feedRect = rect(feedRef);
			if (feedRect && inside(feedRect, e)) {
				const id = feedHit.current(e.y - feedRect.y);
				if (id === undefined) return;
				if (id === selectedEvent) toggleExpanded(id);
				else setSelectedEvent(id);
			}

			return;
		}

		if (view.name === 'focus') {
			const side = rect(sidebarRef);
			const divider = rect(dividerRef);
			if (divider && e.y >= divider.y && e.y < divider.y + divider.height && Math.abs(e.x - divider.x) <= 1) {
				dragging.current = true;
				return;
			}

			if (side && inside(side, e)) {
				// "EMPLOYEES" heading, then two rows per agent.
				const agent = agentAt(Math.floor((e.y - side.y - 1) / 2));
				if (agent) {
					setOffset(0);
					setView({name: 'focus', agent, tab: tabsFor(agent).includes(view.tab) ? view.tab : 'stream'});
				}

				return;
			}

			const bar = rect(tabsRef);
			if (bar && e.y === bar.y && e.x >= bar.x) {
				const hit = tabOffsets(view.agent).find(t => e.x - bar.x >= t.start && e.x - bar.x < t.end);
				if (hit) {
					setOffset(0);
					setView({...view, tab: hit.tab});
				}
			}
		}
	});

	// Layout ------------------------------------------------------------------
	const progress = runProgress(state);
	const eta = !finished && !state.paused && !interrupted ? estimateEta(state, now) : undefined;
	const elapsed = formatClock((state.endedAt ?? now) - state.createdAt);
	const target = focusEmployee ? who(focusEmployee.id) : who(ORCHESTRATOR);
	const detach: KeyHint = ['q', finished ? 'back' : 'detach · keeps running'];
	const pause: KeyHint[] = finished || interrupted ? [] : [['^p', state.paused ? 'resume' : 'pause']];

	let hints: KeyHint[];
	let rightHints: KeyHint[] = [detach];
	if (palette) {
		hints = [['↑↓', 'choose'], ['⏎', 'run'], ['esc', 'close']];
		rightHints = [];
	} else if (typing) {
		hints = [['⏎', 'send'], ['tab', 'complete'], ['esc', 'normal mode']];
		rightHints = [];
	} else if (panel) {
		hints = [['esc', 'close']];
	} else if (view.name === 'tasks') {
		hints = [['j/k', 'select'], ['^t', 'close'], ['esc', 'back']];
	} else if (view.name === 'focus') {
		hints = [['j/k', 'employee'], ['tab', 'stream·diff·tests·chat'], ['↑↓', 'scroll'], ['⏎', 'message'], ['esc', 'back'], ['^k', 'palette']];
	} else if (interrupted) {
		hints = [['^r', 'continue this run'], ['j/k', 'scroll feed'], ['1–9', 'open employee'], ['^k', 'palette']];
	} else if (awaiting) {
		hints = [['⏎', 'start the plan'], ['i', 'ask for changes'], ['1–9', 'open employee'], ['^k', 'palette']];
	} else {
		hints = [['j/k', 'scroll feed'], ['1–9', 'open employee'], ['⏎', 'expand event'], ['/', 'command'], ['@', 'mention'], ...pause, ['^k', 'palette']];
	}

	const notices: ReactNode[] = [];
	if (notice) notices.push(<Text key="n" color={theme.strong} wrap="truncate">{notice}</Text>);
	if (awaiting) notices.push(<Text key="a" color={theme.warn} wrap="truncate">Review the plan in the feed. ⏎ starts it; type to ask the orchestrator for changes.</Text>);
	if (state.paused && !finished) {
		notices.push(
			<Text key="p" color={theme.warn} wrap="truncate">
				{state.paused.reason === 'budget' ? `Paused at $${state.costUsd.toFixed(2)}: the run reached its budget. ^p resumes and allows another budget's worth.` : 'Paused: running tasks finish, nothing new starts. ^p resumes.'}
			</Text>,
		);
	}

	if (interrupted) notices.push(<Text key="i" color={theme.warn} wrap="truncate">This run was interrupted when polyagent quit. Press ^r to continue it.</Text>);
	if (state.unapplied.length) {
		notices.push(
			<Text key="u" color={theme.warn} wrap="truncate">
				⚠ You changed {state.unapplied.join(', ')} during the run; the team's versions were kept aside. /merge has the details.
			</Text>,
		);
	}

	const bodyRows = rows - 2 - notices.length; // top padding + hint line
	// The box, plus the suggestions that appear above it while typing @ or /.
	const promptRows = 3 + (typing ? suggest(draft, run.employees).slice(0, 5).length : 0);

	const prompt = (
		<Box ref={promptRef} flexDirection="column" flexShrink={0}>
			<Prompt
				key={typingKey}
				typing={typing}
				employees={run.employees}
				target={target}
				width={width}
				initial={initialText}
				placeholder={focusEmployee ? `message ${focusEmployee.name}, or @ someone else…` : 'tell the orchestrator what to change, @ an employee, or / for commands'}
				onSubmit={submit}
				onDraft={setDraft}
				onExit={() => {
					setTyping(false);
					setDraft('');
				}}
				disabled={finished ? 'This run has ended.' : interrupted ? 'This run was interrupted. Press ^r to continue it.' : undefined}
			/>
		</Box>
	);

	let body: ReactNode;
	if (palette) {
		body = <Palette items={paletteItems()} width={width} height={bodyRows} onClose={() => setPalette(false)} />;
	} else if (panel) {
		body = (
			<Box flexDirection="column" height={bodyRows} overflow="hidden">
				{panel === 'cost' ? <CostPanel run={run} who={who} width={width} /> : <MergePanel run={run} who={who} width={width} />}
			</Box>
		);
	} else if (view.name === 'tasks') {
		body = (
			<>
				<TasksView run={run} who={who} row={view.row} width={width} height={bodyRows - promptRows} now={now} />
				{prompt}
			</>
		);
	} else if (view.name === 'focus') {
		const side = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, sidebar));
		const useSide = width >= 76;
		const mainWidth = useSide ? width - side - 1 : width;
		const height = bodyRows - promptRows - (typing ? 0 : 0);
		body = (
			<>
				<Box height={height}>
					{useSide ? (
						<>
							<Box ref={sidebarRef} flexShrink={0}>
								<Sidebar run={run} who={who} selected={view.agent} width={side} height={height} now={now} />
							</Box>
							<Box ref={dividerRef} width={1} flexShrink={0}>
								<Text color={theme.rule}>{Array.from({length: height}, () => '│').join('\n')}</Text>
							</Box>
						</>
					) : null}
					<FocusMain run={run} who={who} agent={view.agent} tab={view.tab} offset={offset} details={details} width={mainWidth - (useSide ? 1 : 0)} height={height} now={now} tabsRef={tabsRef} />
				</Box>
				{prompt}
			</>
		);
	} else {
		const shownLanes = Math.max(2, Math.min(lanes.length, bodyRows - 12));
		const headerRows = 2 + (finished && state.summary ? Math.min(5, state.summary.split('\n').length + 1) : 0);
		const feedHeight = Math.max(3, bodyRows - headerRows - 1 - shownLanes - (lanes.length > shownLanes ? 1 : 0) - 1 - promptRows);
		const status = finished ? state.status : interrupted ? 'interrupted' : state.paused ? 'paused' : undefined;
		body = (
			<>
				<Box flexDirection="column" flexShrink={0}>
					<Text wrap="truncate">
						<Text color={theme.accent} bold>
							◆
						</Text>{' '}
						<Text color={theme.strong} bold>
							{state.request.replace(/\s+/g, ' ')}
						</Text>
					</Text>
					<Box paddingLeft={2}>
						<Bar width={Math.min(40, Math.max(12, Math.floor(width / 3)))} fraction={finished && state.status === 'done' ? 1 : progress.fraction} color={theme.accent} />
						<Text wrap="truncate">
							{' '}
							<Text color={theme.text}>
								{progress.done}/{progress.total || '–'}
							</Text>
							<Text color={theme.dim}>
								{status ? ` · ${status}` : ''}
								{eta !== undefined ? ` · eta ~${formatSpan(eta)}` : ''}
								{state.costUsd > 0 ? ` · $${state.costUsd.toFixed(2)}` : ''}
								{state.tokens > 0 ? ` · ${formatTokens(state.tokens)} tok` : ''} · {elapsed}
							</Text>
						</Text>
					</Box>
					{finished && state.summary ? (
						<Box paddingLeft={2} marginTop={0}>
							<Paragraph color={theme.soft}>{excerpt(state.summary, 360)}</Paragraph>
						</Box>
					) : null}
				</Box>
				<Box ref={lanesRef} flexDirection="column" marginTop={1} flexShrink={0}>
					{lanes.slice(0, shownLanes).map((lane, i) => (
						<LaneRow key={lane.agent} index={i} lane={lane} run={run} who={who} width={width} selected={false} needsYou={needsYou(lane.agent)} now={now} />
					))}
					{lanes.length > shownLanes ? <Text color={theme.dim}>{`  +${lanes.length - shownLanes} more: ^k to open one`}</Text> : null}
				</Box>
				<Box ref={feedRef} marginTop={1} flexDirection="column" flexShrink={0}>
					<FeedView layout={layout} selected={selectedEvent} height={feedHeight} hit={feedHit} />
				</Box>
				<Box flexGrow={1} />
				{prompt}
			</>
		);
	}

	return (
		<Canvas hints={hints} rightHints={rightHints} notice={notices.length ? notices : undefined}>
			{body}
		</Canvas>
	);
}
