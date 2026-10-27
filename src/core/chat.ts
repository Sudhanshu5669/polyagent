import fs from 'node:fs/promises';
import path from 'node:path';
import {runTurn, type RunningTurn} from './agents/runner.js';
import type {ToolStatus} from './agents/types.js';
import type {Employee} from './employees.js';
import {readJson, writeJson} from './fs.js';
import type {ProviderId} from './providers.js';

export type ChatEntry =
	| {kind: 'user'; text: string; at: number}
	| {kind: 'text'; text: string}
	| {kind: 'thinking'; text: string}
	| {kind: 'tool'; id: string; name: string; summary: string; status: ToolStatus; output?: string}
	| {kind: 'error'; message: string}
	| {kind: 'note'; text: string}
	| {kind: 'turn'; ok: boolean; cancelled: boolean; durationMs: number; costUsd?: number; inputTokens?: number; outputTokens?: number};

interface SessionFile {
	provider: ProviderId;
	sessionId: string;
}

/** The system prompt every employee gets: who they are on the team, then their own prompt. */
export function employeeSystemPrompt(employee: Employee): string {
	const lines = [`You are ${employee.name}, the ${employee.role} on a team of AI agents coordinated by polyagent.`];
	if (employee.summary) lines.push(`Your responsibilities: ${employee.summary}`);
	if (employee.owns.length > 0) lines.push(`You work in: ${employee.owns.join(', ')}. Avoid changing files outside these areas unless asked.`);
	return [lines.join('\n'), employee.systemPrompt].filter(Boolean).join('\n\n');
}

/**
 * One employee's direct conversation: transcript, provider session and the running turn.
 * Lives outside React so a turn keeps running when you leave the chat screen.
 */
export class EmployeeChat {
	entries: ChatEntry[] = [];
	working = false;
	startedAt?: number;
	private session?: SessionFile;
	private turn?: RunningTurn;
	private sessionWrite?: Promise<void>;
	private persistedCount = 0;
	private listeners = new Set<() => void>();
	/** Bumped on every change, for useSyncExternalStore. */
	version = 0;

	private constructor(private readonly dir: string) {}

	static async open(workspaceDir: string, employeeId: string): Promise<EmployeeChat> {
		const chat = new EmployeeChat(path.join(workspaceDir, 'chats', employeeId));
		const raw = await fs.readFile(chat.transcriptFile, 'utf8').catch(() => '');
		for (const line of raw.split('\n')) {
			if (!line.trim()) continue;
			try {
				chat.entries.push(JSON.parse(line) as ChatEntry);
			} catch {}
		}

		chat.persistedCount = chat.entries.length;
		chat.session = (await readJson(chat.sessionFile).catch(() => undefined)) as SessionFile | undefined;
		return chat;
	}

	private get transcriptFile() {
		return path.join(this.dir, 'transcript.jsonl');
	}

	private get sessionFile() {
		return path.join(this.dir, 'session.json');
	}

	get sessionId(): string | undefined {
		return this.session?.sessionId;
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	private changed() {
		this.version++;
		for (const listener of this.listeners) listener();
	}

	private push(entry: ChatEntry) {
		this.entries.push(entry);
		this.changed();
	}

	async send(employee: Employee, binary: string, cwd: string, prompt: string): Promise<void> {
		if (this.working) throw new Error(`${employee.name} is still working`);

		// A session belongs to one provider; switching provider starts fresh.
		if (this.session && this.session.provider !== employee.provider) {
			this.session = undefined;
			await fs.rm(this.sessionFile, {force: true});
			this.push({kind: 'note', text: `Started a new session because ${employee.name} now uses a different CLI.`});
		}

		this.push({kind: 'user', text: prompt, at: Date.now()});
		// Tool ids are only unique within a turn (Codex numbers items item_1, item_2… every turn).
		const turnStart = this.entries.length;
		this.working = true;
		this.startedAt = Date.now();
		this.changed();

		let usage: Pick<Extract<ChatEntry, {kind: 'turn'}>, 'costUsd' | 'inputTokens' | 'outputTokens'> = {};
		const turn = runTurn(
			binary,
			employee.provider,
			{
				prompt,
				cwd,
				systemPrompt: employeeSystemPrompt(employee),
				sessionId: this.session?.sessionId,
				model: employee.model,
				permissions: employee.permissions,
			},
			event => {
				switch (event.type) {
					case 'session':
						this.session = {provider: employee.provider, sessionId: event.sessionId};
						this.sessionWrite = writeJson(this.sessionFile, this.session);
						break;
					case 'text': {
						const last = this.entries.at(-1);
						if (event.delta && last?.kind === 'text') {
							last.text += event.text;
							this.changed();
						} else this.push({kind: 'text', text: event.text});
						break;
					}

					case 'thinking':
						this.push({kind: 'thinking', text: event.text});
						break;
					case 'tool': {
						const existing = this.entries.slice(turnStart).find(e => e.kind === 'tool' && e.id === event.id);
						const {type: _, ...tool} = event;
						if (existing) {
							Object.assign(existing, tool);
							this.changed();
						} else this.push({kind: 'tool', ...tool});
						break;
					}

					case 'usage':
						usage = {costUsd: event.costUsd, inputTokens: event.inputTokens, outputTokens: event.outputTokens};
						break;
					case 'error':
						// Reported once at the end of the turn, with the exit status.
						break;
					case 'result':
						break;
				}
			},
		);
		this.turn = turn;

		const outcome = await turn.done;
		this.turn = undefined;
		await this.sessionWrite;
		for (const entry of this.entries.slice(turnStart)) if (entry.kind === 'tool' && entry.status === 'running') entry.status = outcome.ok ? 'done' : 'failed';
		if (outcome.error && !outcome.cancelled) this.push({kind: 'error', message: outcome.error});
		this.push({kind: 'turn', ok: outcome.ok, cancelled: outcome.cancelled, durationMs: Date.now() - this.startedAt, ...usage});
		this.working = false;
		this.startedAt = undefined;
		this.changed();
		await this.persist();
	}

	cancel(): void {
		this.turn?.cancel();
	}

	/** Forget the provider session and the transcript. */
	async reset(): Promise<void> {
		this.cancel();
		this.entries = [];
		this.session = undefined;
		this.persistedCount = 0;
		await fs.rm(this.dir, {recursive: true, force: true});
		this.changed();
	}

	private async persist(): Promise<void> {
		const fresh = this.entries.slice(this.persistedCount);
		if (fresh.length === 0) return;
		await fs.mkdir(this.dir, {recursive: true});
		await fs.appendFile(this.transcriptFile, fresh.map(e => JSON.stringify(e)).join('\n') + '\n');
		this.persistedCount = this.entries.length;
	}
}

/** All open chats, keyed by employee id, with one subscription for screens that show everyone's status. */
export class ChatHub {
	private chats = new Map<string, EmployeeChat>();
	private opening = new Map<string, Promise<EmployeeChat>>();
	private listeners = new Set<() => void>();
	version = 0;

	constructor(private readonly workspaceDir: string) {}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	get(employeeId: string): Promise<EmployeeChat> {
		const existing = this.chats.get(employeeId);
		if (existing) return Promise.resolve(existing);
		let pending = this.opening.get(employeeId);
		if (!pending) {
			pending = EmployeeChat.open(this.workspaceDir, employeeId).then(chat => {
				this.chats.set(employeeId, chat);
				chat.subscribe(() => {
					this.version++;
					for (const listener of this.listeners) listener();
				});
				return chat;
			});
			this.opening.set(employeeId, pending);
		}

		return pending;
	}

	isWorking(employeeId: string): boolean {
		return this.chats.get(employeeId)?.working ?? false;
	}

	workingCount(): number {
		return [...this.chats.values()].filter(c => c.working).length;
	}

	cancelAll(): void {
		for (const chat of this.chats.values()) chat.cancel();
	}

	/** Drop a chat after its employee is removed. */
	forget(employeeId: string): void {
		this.chats.get(employeeId)?.cancel();
		this.chats.delete(employeeId);
		this.opening.delete(employeeId);
	}
}
