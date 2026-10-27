import type {Employee} from '../employees.js';
import {PROVIDERS} from '../providers.js';
import type {RunState, Task} from './types.js';

/**
 * Every orchestrator turn ends with one decision in this shape. All fields are required and nullable
 * instead of optional, because strict structured-output modes (Codex) reject optional properties.
 */
export const DECISION_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['note', 'tasks', 'revisions', 'cancel', 'finish'],
	properties: {
		note: {type: 'string', description: 'One short sentence for the user about what you are doing now.'},
		tasks: {
			type: 'array',
			description: 'New tasks to hand out.',
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['id', 'title', 'assignee', 'brief', 'depends_on'],
				properties: {
					id: {type: 'string', description: 'Short unique kebab-case id, e.g. "api-endpoint".'},
					title: {type: 'string', description: 'A few words, shown in the task list.'},
					assignee: {type: 'string', description: 'Employee id from the team list.'},
					brief: {type: 'string', description: "Everything the employee needs, in the style they asked for."},
					depends_on: {type: 'array', items: {type: 'string'}, description: 'Ids of tasks that must finish first.'},
				},
			},
		},
		revisions: {
			type: 'array',
			description: 'Finished or failed tasks to send back to the same employee with feedback.',
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['task', 'feedback'],
				properties: {task: {type: 'string'}, feedback: {type: 'string'}},
			},
		},
		cancel: {type: 'array', items: {type: 'string'}, description: 'Ids of tasks that are no longer needed.'},
		finish: {type: ['string', 'null'], description: 'Set when the request is complete (or cannot be completed): the summary for the user.'},
	},
} as const;

export interface NewTask {
	id: string;
	title: string;
	assignee: string;
	brief: string;
	depends_on: string[];
}

export interface Decision {
	note: string;
	tasks: NewTask[];
	revisions: {task: string; feedback: string}[];
	cancel: string[];
	finish: string | null;
}

export function orchestratorSystemPrompt(employees: Employee[], cwd: string, branch?: string): string {
	const team = employees
		.map(e =>
			[
				`- id: ${e.id}`,
				`  name: ${e.name} · role: ${e.role} · runs on: ${PROVIDERS[e.provider].label} · permissions: ${e.permissions}${e.permissions === 'read-only' ? ' (cannot edit files)' : ''}`,
				`  works in: ${e.owns.length ? e.owns.join(', ') : 'anywhere'}`,
				`  handles: ${e.summary || '(no summary given)'}`,
				`  wants briefs like: ${e.briefing || 'clear, complete instructions'}`,
			].join('\n'),
		)
		.join('\n');

	return `You are the orchestrator of a team of AI coding agents ("employees") working in the repository at ${cwd}${branch ? `, on branch ${branch}` : ''}.
You never edit files yourself. You plan, delegate, review reports, and decide when the work is done.

Your team:
${team}

How to work:
1. Look at the repository just enough to plan well (you have read-only tools). Be quick.
2. Split the user's request into tasks. Give each task to the one employee whose "handles" fits best. Prefer a few substantial tasks over many tiny ones. Never give file edits to a read-only employee.
3. Write each brief in the style that employee asked for. Employees cannot see this conversation, the user's request, or each other's work: put everything they need in the brief. Reports from tasks a task depends on are attached to its brief automatically.
4. Use depends_on only when a task truly needs another task's result. Tasks without dependencies between them may run at the same time, so make sure they don't edit the same files.
5. When reports arrive, check them critically. Ask for a revision with specific feedback, add follow-up tasks (for example a review or tests), or cancel tasks that are no longer needed.
6. Finish when everything the user asked for is done and checked, or when it can't be done. The finish text is the summary the user reads: what changed, where, and anything left to do.

Your own shell commands may be blocked. polyagent attaches the current uncommitted changes (git status and diff) to each update, so use those to check the work.

Reply only with the JSON decision. Leave arrays empty and finish null when they don't apply.`;
}

export function planPrompt(request: string, dirty?: string, parallel = false): string {
	const before = dirty ? `\n\nBefore this run started, the working tree already had uncommitted changes (not made by your team):\n${dirty}` : '';
	const mode = parallel
		? 'Employees each work in their own copy of the repository, so independent tasks run at the same time. Changes are merged when a task finishes; two tasks editing the same lines will conflict, so split work by file or area.'
		: 'Tasks run one at a time in the shared working tree.';
	return `The user's request:\n\n${request}${before}\n\n${mode}\n\nPlan the work and hand out the first tasks.`;
}

export type Update = {kind: 'task'; task: Task} | {kind: 'user'; text: string};

function trimReport(text: string, max = 4000): string {
	return text.length > max ? `${text.slice(0, max)}\n… (report truncated)` : text;
}

export function updatePrompt(updates: Update[], state: RunState, employees: Employee[], errors: string[], changes?: string): string {
	const name = (id: string) => employees.find(e => e.id === id)?.name ?? id;
	const parts: string[] = [];

	for (const update of updates) {
		if (update.kind === 'user') {
			parts.push(`Message from the user:\n${update.text}`);
			continue;
		}

		const {task} = update;
		if (task.status === 'done') parts.push(`Task "${task.id}" (${name(task.assignee)}) finished. Report:\n${trimReport(task.report ?? '(no report)')}`);
		else parts.push(`Task "${task.id}" (${name(task.assignee)}) FAILED: ${task.error ?? 'unknown error'}${task.report ? `\nLast output:\n${trimReport(task.report, 1500)}` : ''}`);
	}

	if (errors.length) parts.push(`Problems with your last decision (those parts were ignored):\n${errors.map(e => `- ${e}`).join('\n')}`);
	if (updates.some(u => u.kind === 'task') && changes !== undefined) {
		parts.push(changes ? `Uncommitted changes in the working tree now:\n${changes}` : 'The working tree has no uncommitted changes.');
	}

	const board = state.tasks.map(t => `- ${t.id} · ${name(t.assignee)} · ${t.status}${t.dependsOn.length ? ` · after ${t.dependsOn.join(', ')}` : ''}`).join('\n');
	parts.push(`All tasks:\n${board || '(none)'}`);
	parts.push('Decide the next steps.');
	return parts.join('\n\n');
}

/** Read a decision from structured output, or failing that from JSON in the final text. */
export function parseDecision(structured: unknown, text: string | undefined): Decision | undefined {
	const candidates: unknown[] = [structured];
	if (text) {
		candidates.push(text);
		const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
		if (fenced) candidates.push(fenced[1]);
		const first = text.indexOf('{');
		const last = text.lastIndexOf('}');
		if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
	}

	for (const candidate of candidates) {
		let value = candidate;
		if (typeof value === 'string') {
			try {
				value = JSON.parse(value);
			} catch {
				continue;
			}
		}

		const decision = normalize(value);
		if (decision) return decision;
	}

	return undefined;
}

function normalize(value: unknown): Decision | undefined {
	if (!value || typeof value !== 'object') return undefined;
	const v = value as Record<string, unknown>;
	const list = (x: unknown) => (Array.isArray(x) ? x : []);
	const str = (x: unknown) => (typeof x === 'string' ? x : '');
	if (!('tasks' in v) && !('finish' in v) && !('revisions' in v)) return undefined;
	return {
		note: str(v.note),
		tasks: list(v.tasks)
			.filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
			.map(t => ({id: str(t.id), title: str(t.title), assignee: str(t.assignee), brief: str(t.brief), depends_on: list(t.depends_on).map(String)})),
		revisions: list(v.revisions)
			.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
			.map(r => ({task: str(r.task), feedback: str(r.feedback)})),
		cancel: list(v.cancel).map(String),
		finish: typeof v.finish === 'string' && v.finish.trim() ? v.finish : null,
	};
}

/**
 * Check new tasks against the team and the existing task graph.
 * Returns the tasks that can be added and a readable error for each one that can't.
 */
export function validateNewTasks(proposed: NewTask[], existing: Task[], employees: Employee[]): {accepted: Task[]; errors: string[]} {
	const errors: string[] = [];
	const accepted: Task[] = [];
	const ids = new Set(existing.map(t => t.id));
	const team = new Map(employees.map(e => [e.id, e]));

	for (const p of proposed) {
		const id = p.id.trim();
		if (!id) {
			errors.push(`A task had no id ("${p.title}").`);
			continue;
		}

		if (ids.has(id)) {
			errors.push(`Task id "${id}" is already used.`);
			continue;
		}

		if (!team.has(p.assignee)) {
			errors.push(`Task "${id}" is assigned to "${p.assignee}", who isn't on the team. Use one of: ${[...team.keys()].join(', ')}.`);
			continue;
		}

		if (!p.brief.trim()) {
			errors.push(`Task "${id}" has an empty brief.`);
			continue;
		}

		ids.add(id);
		accepted.push({
			id,
			title: p.title.trim() || id,
			assignee: p.assignee,
			brief: p.brief,
			dependsOn: [...new Set(p.depends_on.map(d => d.trim()).filter(Boolean))],
			status: 'blocked',
			revisions: 0,
		});
	}

	// Dependencies must not form a cycle, and must exist (now or in this batch).
	const all = new Map([...existing, ...accepted].map(t => [t.id, t]));
	const reject = (task: Task, reason: string) => {
		errors.push(reason);
		accepted.splice(accepted.indexOf(task), 1);
		all.delete(task.id);
	};

	// Find every task in a cycle before removing any, so removing one doesn't hide the others.
	for (const task of accepted.filter(t => reaches(t.id, t.id, all, new Set()))) reject(task, `Task "${task.id}" is part of a dependency cycle.`);

	// Repeat until stable: rejecting one task can orphan another that depends on it.
	for (let changed = true; changed; ) {
		changed = false;
		for (const task of [...accepted]) {
			const missing = task.dependsOn.filter(d => !all.has(d));
			if (missing.length) {
				reject(task, `Task "${task.id}" depends on unknown or rejected task${missing.length > 1 ? 's' : ''} ${missing.map(m => `"${m}"`).join(', ')}.`);
				changed = true;
			}
		}
	}

	return {accepted, errors};
}

function reaches(from: string, target: string, all: Map<string, Task>, seen: Set<string>): boolean {
	for (const dep of all.get(from)?.dependsOn ?? []) {
		if (dep === target) return true;
		if (seen.has(dep)) continue;
		seen.add(dep);
		if (reaches(dep, target, all, seen)) return true;
	}

	return false;
}

/** What an employee receives for a task: the brief, context from tasks it depends on, and any revision feedback. */
export function taskPrompt(
	task: Task,
	tasks: Task[],
	employees: Employee[],
	cwd: string,
	branch?: string,
	options: {isolated?: boolean; conflicts?: string[]} = {},
): string {
	const name = (id: string) => employees.find(e => e.id === id)?.name ?? id;
	const parts = [`Task "${task.title}" (id: ${task.id}) from the orchestrator.`, task.brief];

	const deps = task.dependsOn.map(id => tasks.find(t => t.id === id)).filter((t): t is Task => !!t?.report);
	if (deps.length) parts.push(`Context from earlier tasks:\n${deps.map(d => `- ${d.title} (${name(d.assignee)}):\n${trimReport(d.report!, 2500)}`).join('\n')}`);
	if (options.conflicts?.length) {
		parts.push(
			`Your previous attempt clashed with changes another employee made to ${options.conflicts.join(', ')}, so it was not applied. Your copy now has everyone's latest merged work: redo your change on top of it.`,
		);
	}

	if (task.feedback) parts.push(`The orchestrator reviewed your previous attempt and wants changes:\n${task.feedback}`);

	parts.push(
		options.isolated
			? `You're working in your own copy of the repository (a git worktree at ${cwd}), made for this run. Other employees work in their own copies at the same time. polyagent merges your changes into the user's working tree when you finish: don't commit, don't create or switch branches, and stay within your task.`
			: `You're working in ${cwd}${branch ? ` on branch ${branch}` : ''}. Other employees may be working on other parts of this repository: stay within your task.`,
		'When you are done, end with a short report: what you changed (files), how you checked it, and anything unfinished or blocked.',
	);
	return parts.join('\n\n');
}
