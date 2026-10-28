import {Box, Text, useApp, useInput} from 'ink';
import {useCallback, useEffect, useMemo, useState} from 'react';
import {ApprovalBroker} from '../core/approvals.js';
import {ChatHub, type EmployeeChat} from '../core/chat.js';
import {saveGlobalConfig, type GlobalConfig} from '../core/config.js';
import {loadContext, type AppContext} from '../core/context.js';
import {applyDetections, detectProvider, type Detection} from '../core/detect.js';
import {deleteEmployee, loadEmployees, type BrokenEmployee, type Employee} from '../core/employees.js';
import {PROVIDER_IDS, type ProviderId} from '../core/providers.js';
import {listRuns, loadRun, RunEngine, type EngineOptions, type RunSummary} from '../core/run/engine.js';
import {isFinished} from '../core/run/types.js';

import {AgentNamesContext, ApprovalsContext} from './approvalsContext.js';
import {openInEditor} from './editor.js';
import {InputGate} from './input.js';
import {ApprovalPrompt} from './screens/ApprovalPrompt.js';
import {Chat} from './screens/Chat.js';
import {Dashboard} from './screens/Dashboard.js';
import {EmployeeForm} from './screens/EmployeeForm.js';
import {Help} from './screens/Help.js';
import {InitWorkspace} from './screens/InitWorkspace.js';
import {NewRun} from './screens/NewRun.js';
import {Presets} from './screens/Presets.js';
import {RunView} from './screens/RunView.js';
import {Settings} from './screens/Settings.js';
import {Setup} from './screens/Setup.js';
import {icons, theme} from './theme.js';

type Screen =
	| {name: 'setup' | 'init' | 'dashboard' | 'settings' | 'help' | 'new-run' | 'presets'}
	| {name: 'run'; engine: RunEngine}
	| {name: 'chat'; employee: Employee; chat: EmployeeChat}
	| {name: 'employee-form'; employee?: Employee};
type Detections = Partial<Record<ProviderId, Detection>>;

function firstScreen(ctx: AppContext): Screen {
	if (Object.keys(ctx.global.providers).length === 0) return {name: 'setup'};
	return {name: ctx.workspace.exists ? 'dashboard' : 'init'};
}

interface AppProps {
	initial: AppContext;
	/** Loaded before the first render so the dashboard never flashes an empty team. */
	initialTeam?: {employees: Employee[]; broken: BrokenEmployee[]};
	initialRuns?: RunSummary[];
	/** Injected in tests; normally the app makes its own. */
	broker?: ApprovalBroker;
}

export function App({initial, initialTeam, initialRuns, broker: injectedBroker}: AppProps) {
	const {exit, suspendTerminal} = useApp();
	const [ctx, setCtx] = useState(initial);
	const [screen, setScreen] = useState<Screen>(() => firstScreen(initial));
	const [detections, setDetections] = useState<Detections>({});
	const [team, setTeam] = useState<{employees: Employee[]; broken: BrokenEmployee[]}>(initialTeam ?? {employees: [], broken: []});

	const [selectedId, setSelectedId] = useState<string>();
	const [notice, setNotice] = useState<string>();
	const [run, setRun] = useState<RunEngine>();
	const [runs, setRuns] = useState<RunSummary[]>(initialRuns ?? []);
	const hub = useMemo(() => new ChatHub(ctx.workspace.dir), [ctx.workspace.dir]);
	const broker = useMemo(() => injectedBroker ?? new ApprovalBroker(), [injectedBroker]);
	const [approvalOpen, setApprovalOpen] = useState(false);

	useEffect(() => {
		void broker.start().catch((error: Error) => setNotice(`Approvals are unavailable: ${error.message}`));
		return () => broker.close();
	}, [broker]);

	// A bell when someone starts waiting, in case you're looking at another window.
	useEffect(() => {
		let count = 0;
		return broker.subscribe(() => {
			if (broker.pending.length > count) process.stdout.write('\u0007');
			count = broker.pending.length;
			if (count === 0) setApprovalOpen(false);
		});
	}, [broker]);

	const reload = useCallback(async () => {
		setCtx(await loadContext(initial.cwd));
	}, [initial.cwd]);

	const reloadTeam = useCallback(async () => {
		if (!ctx.workspace.exists) return;
		setTeam(await loadEmployees(ctx.workspace.dir));
		setRuns(await listRuns(ctx.workspace.dir, 5));
	}, [ctx.workspace.exists, ctx.workspace.dir]);

	// Saved providers are re-checked in the background so launch stays instant.
	// Each one shows up as soon as it answers, so one slow CLI doesn't hold up the others.
	useEffect(() => {
		if (screen.name === 'setup') return;
		const checks = PROVIDER_IDS.map(id =>
			detectProvider(id, initial.global.providers[id]).then(d => {
				setDetections(prev => ({...prev, [id]: d}));
				return d;
			}),
		);
		void Promise.all(checks).then(async results => {
			const next = applyDetections(initial.global, results);
			if (JSON.stringify(next) !== JSON.stringify(initial.global)) {
				await saveGlobalConfig(next);
				setCtx(c => ({...c, global: next}));
			}
		});
		// Only on launch: later checks happen in Setup or Settings.
	}, []);

	useEffect(() => void reloadTeam(), [reloadTeam]);

	const runActive = run !== undefined && !isFinished(run.state.status);

	// Global keys, read even while a screen's input is gated.
	// ctrl+a answers approvals. ctrl+c stops whatever is running first (a run, direct chats); with nothing running it quits.
	useInput((input, key) => {
		if (key.ctrl && input === 'a' && broker.pending.length > 0) return setApprovalOpen(true);
		if (!(key.ctrl && input === 'c')) return;
		const working = hub.workingCount();
		if (runActive) {
			run.cancel();
			hub.cancelAll();
			setNotice('Stopped the run. Press ctrl+c again to quit.');
		} else if (working > 0) {
			hub.cancelAll();
			setNotice(`Stopped ${working} employee${working === 1 ? '' : 's'}. Press ctrl+c again to quit.`);
		} else exit();
	});

	/** Claude Code employees ask you about actions that need approval, unless that's turned off or they run full-auto. */
	const approvalArgsFor = (employee: Employee): string[] | undefined =>
		ctx.settings.values.approvals === 'ask' && employee.provider === 'claude' && employee.permissions !== 'full-auto'
			? broker.claudeArgs(employee.id)
			: undefined;

	const engineOptions = (): EngineOptions => ({
		workspaceDir: ctx.workspace.dir,
		cwd: ctx.workspace.root,
		branch: ctx.workspace.git?.branch,
		employees: team.employees,
		orchestrator: ctx.settings.values.orchestrator,
		orchestratorModel: ctx.settings.values.orchestratorModel ?? undefined,
		binaryFor,
		autoRun: ctx.settings.values.autoRun,
		maxParallel: ctx.settings.values.maxParallel,
		runBudget: ctx.settings.values.runBudget,
		taskTimeoutMinutes: ctx.settings.values.taskTimeout,
		approvalArgs: approvalArgsFor,
	});

	const startRun = (request: string) => {
		const engine = new RunEngine(engineOptions(), request);
		engine.start();
		void engine.done.then(reloadTeam);
		setRun(engine);
		setScreen({name: 'run', engine});
	};

	const openRun = async (id: string) => {
		if (run?.state.id === id) return setScreen({name: 'run', engine: run});
		const file = await loadRun(ctx.workspace.dir, id);
		if (!file) return setNotice("That run's file couldn't be read.");
		setScreen({name: 'run', engine: RunEngine.restore(engineOptions(), file)});
	};

	const continueRun = (engine: RunEngine) => {
		if (runActive && run !== engine) return setNotice('Another run is in progress. Stop it before continuing this one.');
		setRun(engine);
		void engine.continueRun();
		void engine.done.then(reloadTeam);
	};

	const binaryFor = (provider: ProviderId): string | undefined => {
		const d = detections[provider];
		if (d?.status === 'found') return d.path;
		return d === undefined ? ctx.global.providers[provider]?.path : undefined;
	};

	const defaultProvider = (): ProviderId => {
		const preferred = ctx.settings.values.orchestrator;
		if (detections[preferred]?.status === 'found') return preferred;
		return PROVIDER_IDS.find(id => detections[id]?.status === 'found') ?? preferred;
	};

	const openFile = async (file: string) => {
		try {
			await suspendTerminal(() => openInEditor(file));
		} catch (error) {
			setNotice(`Couldn't open your editor: ${(error as Error).message}`);
		}

		await reloadTeam();
	};

	const finishSetup = async (global: GlobalConfig, found: Detections) => {
		await saveGlobalConfig(global);
		setDetections(found);
		setCtx(c => ({...c, global}));
		setScreen({name: ctx.workspace.exists ? 'dashboard' : 'init'});
	};

	const toDashboard = () => setScreen({name: 'dashboard'});
	const nameOf = (agent: string) => team.employees.find(e => e.id === agent)?.name ?? agent;

	return (
		<ApprovalsContext.Provider value={broker}>
			<AgentNamesContext.Provider value={nameOf}>
				{/* The screen stays mounted (keeping its state) but hidden and deaf while an approval is answered. */}
				<InputGate.Provider value={!approvalOpen}>
					<Box display={approvalOpen ? 'none' : 'flex'} flexDirection="column">
						{renderScreen()}
					</Box>
				</InputGate.Provider>
				{approvalOpen ? <ApprovalPrompt employees={team.employees} onClose={() => setApprovalOpen(false)} /> : null}
			</AgentNamesContext.Provider>
		</ApprovalsContext.Provider>
	);

	function renderScreen() {
	switch (screen.name) {
		case 'setup':
			return <Setup config={ctx.global} onDone={(global, found) => void finishSetup(global, found)} />;
		case 'init':
			return <InitWorkspace workspace={ctx.workspace} gitTracking={ctx.settings.values.gitTracking} onDone={() => void reload().then(toDashboard)} />;
		case 'settings':
			return (
				<Settings
					ctx={ctx}
					detections={detections}
					onSaved={reload}
					onDetections={(found, global) => {
						setDetections(found);
						setCtx(c => ({...c, global}));
					}}
					onBack={toDashboard}
				/>
			);
		case 'help':
			return <Help onBack={toDashboard} />;
		case 'presets':
			return (
				<Presets
					workspaceDir={ctx.workspace.dir}
					team={team.employees}
					detections={detections}
					defaultProvider={defaultProvider()}
					onApplied={(preset, result) => {
						const parts = [`Added ${result.added.length ? result.added.join(', ') : 'nobody new'} from ${preset.name}`];
						if (result.renamed.length) parts.push(`renamed ${result.renamed.map(([from, to]) => `${from} → ${to}`).join(', ')}`);
						if (result.switched.length) parts.push(`moved ${result.switched.join(', ')} to an installed CLI`);
						setNotice(parts.join('; '));
						setSelectedId(result.added[0]);
						void reloadTeam().then(toDashboard);
					}}
					onBack={toDashboard}
				/>
			);
		case 'new-run':
			return (
				<NewRun
					employees={team.employees}
					orchestrator={ctx.settings.values.orchestrator}
					detections={detections}
					autoRun={ctx.settings.values.autoRun}
					root={ctx.workspace.root}
					branch={ctx.workspace.git?.branch}
					parallel={ctx.workspace.git !== undefined}
					onStart={startRun}
					onBack={toDashboard}
				/>
			);
		case 'run':
			return <RunView run={screen.engine} onBack={toDashboard} onContinue={() => continueRun(screen.engine)} />;
		case 'chat':
			return (
				<Chat
					employee={screen.employee}
					chat={screen.chat}
					binary={binaryFor(screen.employee.provider)}
					approvalArgs={approvalArgsFor(screen.employee)}
					cwd={ctx.workspace.root}
					onBack={toDashboard}
				/>
			);
		case 'employee-form':
			return (
				<EmployeeForm
					workspaceDir={ctx.workspace.dir}
					employee={screen.employee}
					takenIds={[...team.employees, ...team.broken].map(e => e.id)}
					detections={detections}
					defaultProvider={defaultProvider()}
					onSaved={id => {
						setSelectedId(id);
						void reloadTeam().then(toDashboard);
					}}
					onBack={toDashboard}
				/>
			);
		case 'dashboard':
			return (
				<Dashboard
					ctx={ctx}
					detections={detections}
					employees={team.employees}
					broken={team.broken}

					hub={hub}
					run={run}
					runs={runs}
					onRun={() => {
						setNotice(undefined);
						setScreen(runActive ? {name: 'run', engine: run} : {name: 'new-run'});
					}}
					onOpenRun={id => void openRun(id)}
					selectedId={selectedId}
					onSelect={id => {
						setSelectedId(id);
						setNotice(undefined);
					}}
					onChat={employee => void hub.get(employee.id).then(chat => setScreen({name: 'chat', employee, chat}))}
					onHire={() => setScreen({name: 'employee-form'})}
					onEdit={employee => setScreen({name: 'employee-form', employee})}
					onOpenFile={file => void openFile(file)}
					onDelete={id => {
						hub.forget(id);
						void deleteEmployee(ctx.workspace.dir, id).then(reloadTeam);
					}}
					onOpenSettings={() => setScreen({name: 'settings'})}
					onOpenHelp={() => setScreen({name: 'help'})}
					onOpenPresets={() => setScreen({name: 'presets'})}
					notice={
						notice ? (
							<Text color={theme.warn}>
								{icons.warn} {notice}
							</Text>
						) : undefined
					}
				/>
			);
	}
}
}
