import {Text, useApp, useInput} from 'ink';
import {useCallback, useEffect, useMemo, useState} from 'react';
import {ChatHub, type EmployeeChat} from '../core/chat.js';
import {saveGlobalConfig, type GlobalConfig} from '../core/config.js';
import {loadContext, type AppContext} from '../core/context.js';
import {applyDetections, detectAll, type Detection} from '../core/detect.js';
import {deleteEmployee, loadEmployees, type BrokenEmployee, type Employee} from '../core/employees.js';
import {PROVIDER_IDS, type ProviderId} from '../core/providers.js';
import {listWorkspaceItems} from '../core/workspace.js';
import {openInEditor} from './editor.js';
import {Chat} from './screens/Chat.js';
import {Dashboard} from './screens/Dashboard.js';
import {EmployeeForm} from './screens/EmployeeForm.js';
import {Help} from './screens/Help.js';
import {InitWorkspace} from './screens/InitWorkspace.js';
import {Settings} from './screens/Settings.js';
import {Setup} from './screens/Setup.js';
import {icons, theme} from './theme.js';

type Screen =
	| {name: 'setup' | 'init' | 'dashboard' | 'settings' | 'help'}
	| {name: 'chat'; employee: Employee; chat: EmployeeChat}
	| {name: 'employee-form'; employee?: Employee};
type Detections = Partial<Record<ProviderId, Detection>>;

function firstScreen(ctx: AppContext): Screen {
	if (Object.keys(ctx.global.providers).length === 0) return {name: 'setup'};
	return {name: ctx.workspace.exists ? 'dashboard' : 'init'};
}

export function App({initial}: {initial: AppContext}) {
	const {exit, suspendTerminal} = useApp();
	const [ctx, setCtx] = useState(initial);
	const [screen, setScreen] = useState<Screen>(() => firstScreen(initial));
	const [detections, setDetections] = useState<Detections>({});
	const [team, setTeam] = useState<{employees: Employee[]; broken: BrokenEmployee[]}>({employees: [], broken: []});
	const [presets, setPresets] = useState<string[]>([]);
	const [selectedId, setSelectedId] = useState<string>();
	const [notice, setNotice] = useState<string>();
	const hub = useMemo(() => new ChatHub(ctx.workspace.dir), [ctx.workspace.dir]);

	const reload = useCallback(async () => {
		setCtx(await loadContext(initial.cwd));
	}, [initial.cwd]);

	const reloadTeam = useCallback(async () => {
		if (!ctx.workspace.exists) return;
		const [loaded, items] = await Promise.all([loadEmployees(ctx.workspace.dir), listWorkspaceItems(ctx.workspace.dir)]);
		setTeam(loaded);
		setPresets(items.presets);
	}, [ctx.workspace.exists, ctx.workspace.dir]);

	// Saved providers are re-checked in the background so launch stays instant.
	useEffect(() => {
		if (screen.name === 'setup') return;
		void detectAll(initial.global).then(async results => {
			setDetections(Object.fromEntries(results.map(d => [d.provider, d])));
			const next = applyDetections(initial.global, results);
			if (JSON.stringify(next) !== JSON.stringify(initial.global)) {
				await saveGlobalConfig(next);
				setCtx(c => ({...c, global: next}));
			}
		});
		// Only on launch: later checks happen in Setup or Settings.
	}, []);

	useEffect(() => void reloadTeam(), [reloadTeam]);

	// ctrl+c stops running employees first; with nothing running it quits.
	useInput((input, key) => {
		if (!(key.ctrl && input === 'c')) return;
		const working = hub.workingCount();
		if (working > 0) {
			hub.cancelAll();
			setNotice(`Stopped ${working} employee${working === 1 ? '' : 's'}. Press ctrl+c again to quit.`);
		} else exit();
	});

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
		case 'chat':
			return (
				<Chat
					employee={screen.employee}
					chat={screen.chat}
					binary={binaryFor(screen.employee.provider)}
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
					presets={presets}
					hub={hub}
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
