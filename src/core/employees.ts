import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import {z} from 'zod';
import {ProviderIdSchema} from './config.js';
import {writeFileAtomic} from './fs.js';

export const PERMISSION_MODES = ['read-only', 'auto-edit', 'full-auto'] as const;
export const PermissionModeSchema = z.enum(PERMISSION_MODES);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

/** Frontmatter of .polyagent/employees/<id>.md. The Markdown body is the employee's system prompt. */
export const EmployeeMetaSchema = z.object({
	name: z.string().trim().min(1, 'name is required'),
	role: z.string().trim().min(1, 'role is required'),
	provider: ProviderIdSchema,
	/** Omitted = the CLI's own default model. */
	model: z.string().trim().min(1).optional(),
	permissions: PermissionModeSchema.default('read-only'),
	/** Areas of the repo this employee works in. The orchestrator uses them to spot overlapping work. */
	owns: z.array(z.string()).default([]),
	/** What this employee handles. The orchestrator routes work on this. */
	summary: z.string().default(''),
	/** How this employee likes to receive work. The orchestrator writes briefs in this style. */
	briefing: z.string().default(''),
});
export type EmployeeMeta = z.infer<typeof EmployeeMetaSchema>;

export interface Employee extends EmployeeMeta {
	/** File name without .md; stable identifier used for chats and runs. */
	id: string;
	systemPrompt: string;
	file: string;
}

export interface BrokenEmployee {
	id: string;
	file: string;
	error: string;
}

export function employeesDir(workspaceDir: string): string {
	return path.join(workspaceDir, 'employees');
}

export function slugify(name: string): string {
	return (
		name
			.toLowerCase()
			.normalize('NFKD')
			.replace(/[^\w\s-]/g, '')
			.trim()
			.replace(/[\s_]+/g, '-')
			.replace(/-+/g, '-')
			.replace(/^-|-$/g, '') || 'employee'
	);
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseEmployee(id: string, file: string, source: string): Employee {
	const match = FRONTMATTER.exec(source);
	if (!match) throw new Error('missing the --- frontmatter block at the top');
	let raw: unknown;
	try {
		raw = YAML.parse(match[1]!) ?? {};
	} catch (error) {
		throw new Error(`frontmatter is not valid YAML: ${(error as Error).message}`);
	}

	const result = EmployeeMetaSchema.safeParse(raw);
	if (!result.success) {
		throw new Error(result.error.issues.map(i => `${i.path.join('.') || 'frontmatter'}: ${i.message}`).join('; '));
	}

	return {...result.data, id, file, systemPrompt: match[2]!.trim()};
}

export function serializeEmployee(employee: EmployeeMeta & {systemPrompt: string}): string {
	const meta: Record<string, unknown> = {
		name: employee.name,
		role: employee.role,
		provider: employee.provider,
		...(employee.model ? {model: employee.model} : {}),
		permissions: employee.permissions,
		owns: employee.owns,
		summary: employee.summary,
		briefing: employee.briefing,
	};
	return `---\n${YAML.stringify(meta, {lineWidth: 0}).trimEnd()}\n---\n\n${employee.systemPrompt.trim()}\n`;
}

export async function loadEmployees(workspaceDir: string): Promise<{employees: Employee[]; broken: BrokenEmployee[]}> {
	const dir = employeesDir(workspaceDir);
	let files: string[];
	try {
		files = (await fs.readdir(dir)).filter(f => f.endsWith('.md')).sort();
	} catch {
		return {employees: [], broken: []};
	}

	const employees: Employee[] = [];
	const broken: BrokenEmployee[] = [];
	for (const name of files) {
		const id = name.slice(0, -3);
		const file = path.join(dir, name);
		try {
			employees.push(parseEmployee(id, file, await fs.readFile(file, 'utf8')));
		} catch (error) {
			broken.push({id, file, error: (error as Error).message});
		}
	}

	return {employees, broken};
}

/** Pick a file id for a new employee that doesn't collide with existing ones. */
export function uniqueId(name: string, taken: Iterable<string>): string {
	const used = new Set(taken);
	const base = slugify(name);
	if (!used.has(base)) return base;
	for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}

export async function saveEmployee(workspaceDir: string, id: string, employee: EmployeeMeta & {systemPrompt: string}): Promise<string> {
	const file = path.join(employeesDir(workspaceDir), `${id}.md`);
	const meta = EmployeeMetaSchema.parse(employee);
	await writeFileAtomic(file, serializeEmployee({...meta, systemPrompt: employee.systemPrompt}));
	return file;
}

export async function deleteEmployee(workspaceDir: string, id: string): Promise<void> {
	await fs.rm(path.join(employeesDir(workspaceDir), `${id}.md`), {force: true});
	await fs.rm(path.join(workspaceDir, 'chats', id), {recursive: true, force: true});
}
