import type {Employee} from '../employees.js';

export interface CommandSpec {
	name: string;
	/** Shown after the name, e.g. "<employee>". */
	args?: string;
	help: string;
}

export const COMMANDS: CommandSpec[] = [
	{name: 'hire', help: 'add someone to the team'},
	{name: 'fire', args: '<employee>', help: 'let an employee go (once their work is done)'},
	{name: 'merge', help: 'worktrees: what each employee changed and where it went'},
	{name: 'cost', help: 'spend per employee and task'},
	{name: 'tasks', help: 'the task list with briefs and reports'},
	{name: 'pause', help: 'let running tasks finish, start nothing new'},
	{name: 'resume', help: 'continue a paused run'},
	{name: 'stop', help: 'stop the run'},
];

export type Parsed =
	| {kind: 'tell'; text: string}
	| {kind: 'employee'; employee: Employee; text: string}
	| {kind: 'command'; name: string; arg: string; employee?: Employee}
	| {kind: 'error'; message: string};

/** How a name is typed after @ or /fire: lowercase, no spaces. */
export function handle(employee: Employee): string {
	return employee.id;
}

/** Find an employee by id or name, or by an unambiguous start of either. */
export function findEmployee(query: string, employees: Employee[]): Employee | undefined | 'ambiguous' {
	const q = query.trim().toLowerCase().replace(/\s+/g, '-');
	if (!q) return undefined;
	const keys = (e: Employee) => [e.id.toLowerCase(), e.name.toLowerCase().replace(/\s+/g, '-')];
	const exact = employees.filter(e => keys(e).includes(q));
	if (exact.length === 1) return exact[0];
	const starts = employees.filter(e => keys(e).some(k => k.startsWith(q)));
	if (starts.length === 1) return starts[0];
	return starts.length > 1 ? 'ambiguous' : undefined;
}

/**
 * Turn what was typed into an action.
 * Plain text goes to `target` (an employee being watched) or the orchestrator; `@name text` goes to one
 * employee; `/command args` runs a command.
 */
export function parseInput(raw: string, employees: Employee[], target?: Employee): Parsed {
	const text = raw.trim();
	if (!text) return {kind: 'error', message: 'Nothing to send.'};

	if (text.startsWith('/')) {
		const [word = '', ...rest] = text.slice(1).split(/\s+/);
		const name = word.toLowerCase();
		const spec = COMMANDS.find(c => c.name === name);
		if (!spec) return {kind: 'error', message: `Unknown command /${word}. Commands: ${COMMANDS.map(c => `/${c.name}`).join(' ')}`};
		const arg = rest.join(' ').trim();
		if (name === 'fire') {
			if (!arg) return {kind: 'error', message: 'Say who: /fire <employee>'};
			const found = findEmployee(arg, employees);
			if (found === 'ambiguous') return {kind: 'error', message: `More than one employee matches "${arg}".`};
			if (!found) return {kind: 'error', message: `Nobody on the team matches "${arg}".`};
			return {kind: 'command', name, arg, employee: found};
		}

		return {kind: 'command', name, arg};
	}

	const mention = /^@(\S+)\s*([\s\S]*)$/.exec(text);
	if (mention) {
		const found = findEmployee(mention[1]!, employees);
		if (found === 'ambiguous') return {kind: 'error', message: `More than one employee matches @${mention[1]}.`};
		if (!found) return {kind: 'error', message: `Nobody on the team matches @${mention[1]}.`};
		if (!mention[2]!.trim()) return {kind: 'error', message: `Say what to tell ${found.name}: @${handle(found)} <message>`};
		return {kind: 'employee', employee: found, text: mention[2]!.trim()};
	}

	return target ? {kind: 'employee', employee: target, text} : {kind: 'tell', text};
}

export interface Suggestion {
	/** What replaces the word being typed. */
	value: string;
	label: string;
	hint: string;
}

/** Suggestions for the word being typed: @employees, or /commands while the command is still the first word. */
export function suggest(input: string, employees: Employee[]): Suggestion[] {
	const mention = /^@(\S*)$/.exec(input);
	if (mention) {
		const q = mention[1]!.toLowerCase();
		return employees
			.filter(e => e.id.toLowerCase().startsWith(q) || e.name.toLowerCase().startsWith(q))
			.map(e => ({value: `@${handle(e)} `, label: `@${handle(e)}`, hint: e.role}));
	}

	const command = /^\/(\S*)$/.exec(input);
	if (command) {
		const q = command[1]!.toLowerCase();
		return COMMANDS.filter(c => c.name.startsWith(q)).map(c => ({value: `/${c.name}${c.args ? ' ' : ''}`, label: `/${c.name}${c.args ? ` ${c.args}` : ''}`, hint: c.help}));
	}

	const fire = /^\/fire\s+(\S*)$/i.exec(input);
	if (fire) {
		const q = fire[1]!.toLowerCase();
		return employees.filter(e => e.id.toLowerCase().startsWith(q)).map(e => ({value: `/fire ${handle(e)}`, label: handle(e), hint: e.role}));
	}

	return [];
}

/** Subsequence match with a score: consecutive and early matches rank higher. Undefined when it doesn't match. */
export function fuzzyScore(query: string, text: string): number | undefined {
	const q = query.toLowerCase().replace(/\s+/g, '');
	if (!q) return 0;
	const t = text.toLowerCase();
	let score = 0;
	let at = -1;
	let streak = 0;
	for (const ch of q) {
		const next = t.indexOf(ch, at + 1);
		if (next === -1) return undefined;
		streak = next === at + 1 ? streak + 1 : 0;
		score += 10 + streak * 5 - Math.min(next, 20) / 4;
		at = next;
	}

	return score - t.length / 50;
}
