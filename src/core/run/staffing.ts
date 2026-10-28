import {runTurn, type RunningTurn} from '../agents/runner.js';
import {saveEmployee, uniqueId, type EmployeeMeta, type PermissionMode} from '../employees.js';
import {cachedModels, type ModelOption} from '../models.js';
import {PROVIDERS, PROVIDER_IDS, type ProviderId} from '../providers.js';
import {TurnRecorder, type ChatEntry} from '../transcript.js';
import {parseReply} from './orchestrator.js';

/** Most employees a proposal may hire. */
export const MAX_PROPOSED = 6;

/** A proposal can only ask for these. Anything riskier is the user's call, made in the review. */
const PROPOSABLE: PermissionMode[] = ['read-only', 'auto-edit'];

export interface ProposedEmployee extends EmployeeMeta {
	systemPrompt: string;
}

export interface TeamProposal {
	/** Why this team, for the user. */
	note: string;
	employees: ProposedEmployee[];
}

/** Installed CLIs and what each one reported as its models (undefined when it couldn't say). */
export type Roster = Partial<Record<ProviderId, ModelOption[] | undefined>>;

/** All fields required and nullable instead of optional, because strict structured-output modes (Codex) reject optional properties. */
export function teamSchema(providers: ProviderId[]) {
	return {
		type: 'object',
		additionalProperties: false,
		required: ['note', 'employees'],
		properties: {
			note: {type: 'string', description: 'One or two sentences for the user: why this team fits the request.'},
			employees: {
				type: 'array',
				items: {
					type: 'object',
					additionalProperties: false,
					required: ['name', 'role', 'provider', 'model', 'permissions', 'owns', 'summary', 'briefing', 'system_prompt'],
					properties: {
						name: {type: 'string', description: 'A short first name, e.g. "Maya".'},
						role: {type: 'string', description: 'One lowercase word, e.g. frontend, backend, reviewer, tests, docs.'},
						provider: {type: 'string', enum: providers, description: 'Which agent CLI does the work.'},
						model: {type: ['string', 'null'], description: "A model id from that CLI's list, or null for the CLI's default."},
						permissions: {type: 'string', enum: PROPOSABLE},
						owns: {type: 'array', items: {type: 'string'}, description: 'Paths or globs in this project the employee works in.'},
						summary: {type: 'string', description: 'What this employee handles. Work is assigned from this.'},
						briefing: {type: 'string', description: 'How this employee wants tasks written.'},
						system_prompt: {type: 'string', description: 'Standing instructions, in the second person.'},
					},
				},
			},
		},
	};
}

function describeRoster(roster: Roster): string {
	return (Object.keys(roster) as ProviderId[])
		.map(id => {
			const models = roster[id];
			const list = models?.length
				? models.map(m => `    - ${m.id}${m.label && m.label !== m.id ? ` (${m.label})` : ''}${m.hint ? `: ${m.hint}` : ''}`).join('\n')
				: '    (no list available: use null)';
			return `- ${id} (${PROVIDERS[id].label}), models:\n${list}`;
		})
		.join('\n');
}

export function staffingSystemPrompt(roster: Roster, orchestrator: ProviderId, cwd: string): string {
	return `You are putting together a team of AI coding agents ("employees") for a request in the project at ${cwd}.
You don't plan or do the work. Once the user approves your team, you will plan the request and hand tasks to these employees, so pick people for the work, not tasks.

Agent CLIs installed on this machine:
${describeRoster(roster)}

How to choose:
1. Look at the project just enough to know its stack and layout (you have read-only tools). Be quick.
2. Propose the smallest team that covers the request well: usually 1 to 3 employees, never more than ${MAX_PROPOSED}. Split people by area of the codebase so they can work at the same time without editing the same files. Add a reviewer only when the change is big or risky.
3. permissions: "read-only" for anyone who only reads or reviews, "auto-edit" for anyone who changes files.
4. provider: prefer ${orchestrator} unless another installed CLI clearly suits a role better.
5. model: null uses the CLI's default, which is usually right. Pick a listed model only when a role calls for a faster or a stronger one, and use its id exactly as listed.
6. owns: real paths or globs from this project. summary: what they handle. briefing: how they want tasks written. system_prompt: a few sentences of standing instructions that fit this project's conventions.
7. Employees can't talk to each other or see each other's work: you pass along what each one needs in their task briefs. So never tell them to coordinate with a teammate; tell them to work from what their brief gives them.

Reply only with the JSON object.`;
}

function normalizeTeam(value: unknown, roster: Roster, fallback: ProviderId): TeamProposal | undefined {
	if (!value || typeof value !== 'object' || !Array.isArray((value as {employees?: unknown}).employees)) return undefined;
	const v = value as {note?: unknown; employees: unknown[]};
	const str = (x: unknown) => (typeof x === 'string' ? x.trim() : '');
	const names = new Set<string>();
	const employees: ProposedEmployee[] = [];

	for (const raw of v.employees) {
		if (!raw || typeof raw !== 'object') continue;
		const e = raw as Record<string, unknown>;
		let name = str(e.name);
		if (!name) continue;
		for (let n = 2; names.has(name.toLowerCase()); n++) name = `${str(e.name)} ${n}`;
		names.add(name.toLowerCase());

		// Only CLIs that are installed, and only models those CLIs listed.
		const provider = typeof e.provider === 'string' && e.provider in roster ? (e.provider as ProviderId) : fallback;
		const model = str(e.model);
		employees.push({
			name,
			role: str(e.role).toLowerCase().split(/\s+/)[0] || 'generalist',
			provider,
			model: model && roster[provider]?.some(m => m.id === model) ? model : undefined,
			permissions: PROPOSABLE.includes(e.permissions as PermissionMode) ? (e.permissions as PermissionMode) : 'read-only',
			owns: Array.isArray(e.owns) ? e.owns.map(str).filter(Boolean) : [],
			summary: str(e.summary),
			briefing: str(e.briefing),
			systemPrompt: str(e.system_prompt),
		});
		if (employees.length === MAX_PROPOSED) break;
	}

	return {note: str(v.note), employees};
}

/** Read a team from structured output, or failing that from JSON in the final text. Cleans up anything out of bounds. */
export function parseTeamProposal(structured: unknown, text: string | undefined, roster: Roster, fallback: ProviderId): TeamProposal | undefined {
	return parseReply(structured, text, value => normalizeTeam(value, roster, fallback));
}

export interface StaffingOptions {
	cwd: string;
	request: string;
	orchestrator: ProviderId;
	orchestratorModel?: string;
	binaryFor: (provider: ProviderId) => string | undefined;
	/** Ask again with the user's feedback on the last proposal, in the same session when there is one. */
	retry?: {sessionId?: string; feedback: string};
}

export interface StaffingResult {
	proposal: TeamProposal;
	sessionId?: string;
	costUsd?: number;
}

/** Ask the orchestrator to propose a team for a request. `onActivity` gets each step it takes, for a progress line. */
export function proposeTeam(options: StaffingOptions, onActivity: (entry: ChatEntry) => void = () => {}): {done: Promise<StaffingResult>; cancel: () => void} {
	let cancelled = false;
	let turn: RunningTurn | undefined;

	const done = (async (): Promise<StaffingResult> => {
		const {orchestrator, binaryFor} = options;
		const binary = binaryFor(orchestrator);
		if (!binary) throw new Error(`The orchestrator runs on ${PROVIDERS[orchestrator].label}, which isn't installed.`);

		const installed = PROVIDER_IDS.filter(id => binaryFor(id));
		const lists = await Promise.all(installed.map(id => cachedModels(id, binaryFor(id)!).catch(() => undefined)));
		const roster: Roster = Object.fromEntries(installed.map((id, i) => [id, lists[i]]));
		if (cancelled) throw new Error('Cancelled.');

		const entries: ChatEntry[] = [];
		const recorder = new TurnRecorder(entries, () => {
			const last = entries.at(-1);
			if (last) onActivity(last);
		});
		turn = runTurn(
			binary,
			orchestrator,
			{
				prompt: options.retry?.sessionId
					? `The user wants changes to your proposed team:\n\n${options.retry.feedback}\n\nPropose the whole team again.`
					: `The user's request:\n\n${options.request}${options.retry ? `\n\nWhat the user wants from the team:\n\n${options.retry.feedback}` : ''}\n\nPropose the team.`,
				cwd: options.cwd,
				systemPrompt: staffingSystemPrompt(roster, orchestrator, options.cwd),
				sessionId: options.retry?.sessionId,
				model: options.orchestratorModel,
				permissions: 'read-only',
				jsonSchema: teamSchema(installed),
			},
			event => recorder.apply(event),
		);

		const outcome = await turn.done;
		recorder.finish(outcome);
		if (cancelled || outcome.cancelled) throw new Error('Cancelled.');
		if (!outcome.ok) throw new Error(`The orchestrator stopped: ${outcome.error ?? 'unknown error'}`);
		const proposal = parseTeamProposal(recorder.structured, recorder.finalText, roster, orchestrator);
		if (!proposal) throw new Error("The orchestrator's reply wasn't a team.");
		if (proposal.employees.length === 0) throw new Error('The orchestrator proposed nobody.');
		return {proposal, sessionId: recorder.sessionId ?? options.retry?.sessionId, costUsd: recorder.usage.costUsd};
	})();

	return {
		done,
		cancel: () => {
			cancelled = true;
			turn?.cancel();
		},
	};
}

/** Save proposed employees to the team, with ids that don't clash. Returns their ids in order. */
export async function hireTeam(workspaceDir: string, employees: ProposedEmployee[], takenIds: string[]): Promise<string[]> {
	const used = [...takenIds];
	const ids: string[] = [];
	for (const employee of employees) {
		const id = uniqueId(employee.name, used);
		used.push(id);
		await saveEmployee(workspaceDir, id, employee);
		ids.push(id);
	}

	return ids;
}
