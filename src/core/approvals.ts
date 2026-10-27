import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/**
 * A minimal MCP server (stdio, newline-delimited JSON-RPC) that Claude Code launches and calls as its
 * --permission-prompt-tool. It relays each request to polyagent over a local socket and returns the answer.
 * Kept as source text and run with `node -e`, so it needs no file on disk and no dependencies.
 */
export const APPROVAL_SERVER_SOURCE = `
import net from 'node:net';
import readline from 'node:readline';
const socketPath = process.env.POLYAGENT_SOCKET;
const agent = process.env.POLYAGENT_AGENT;
const send = message => process.stdout.write(JSON.stringify({jsonrpc: '2.0', ...message}) + '\\n');
const ask = args => new Promise(resolve => {
	const connection = net.connect(socketPath);
	let buffer = '';
	connection.on('data', chunk => {
		buffer += chunk;
		const end = buffer.indexOf('\\n');
		if (end >= 0) { resolve(JSON.parse(buffer.slice(0, end))); connection.end(); }
	});
	connection.on('error', () => resolve({behavior: 'deny', message: 'polyagent could not be reached, so this was not approved.'}));
	connection.write(JSON.stringify({agent, ...args}) + '\\n');
});
readline.createInterface({input: process.stdin}).on('line', async line => {
	let message;
	try { message = JSON.parse(line); } catch { return; }
	if (message.method === 'initialize') {
		return send({id: message.id, result: {protocolVersion: message.params?.protocolVersion ?? '2024-11-05', capabilities: {tools: {}}, serverInfo: {name: 'polyagent', version: '1'}}});
	}
	if (message.method === 'tools/list') {
		return send({id: message.id, result: {tools: [{name: 'approve', description: 'Ask the polyagent user whether a tool call may run.', inputSchema: {type: 'object', properties: {tool_name: {type: 'string'}, input: {type: 'object'}, tool_use_id: {type: 'string'}}, required: ['tool_name', 'input']}}]}});
	}
	if (message.method === 'tools/call') {
		const decision = await ask(message.params?.arguments ?? {});
		return send({id: message.id, result: {content: [{type: 'text', text: JSON.stringify(decision)}]}});
	}
	if (message.id !== undefined) send({id: message.id, error: {code: -32601, message: 'Method not found'}});
});
`;

export const APPROVAL_TOOL = 'mcp__polyagent__approve';

export interface ApprovalRequest {
	id: number;
	/** Who is asking: an employee id. */
	agent: string;
	toolName: string;
	input: Record<string, unknown>;
	createdAt: number;
}

export type Decision = 'allow' | 'always' | 'deny';

/** What "always allow" remembers: the tool, and for shell commands the first two words (e.g. "npm test"). */
export function ruleFor(toolName: string, input: Record<string, unknown>): string {
	if (toolName === 'Bash' && typeof input.command === 'string') {
		return `Bash(${input.command.trim().split(/\s+/).slice(0, 2).join(' ')})`;
	}

	return toolName;
}

/** One line describing what is being asked, for the approval prompt. */
export function describeRequest(request: Pick<ApprovalRequest, 'toolName' | 'input'>): string {
	const {toolName, input} = request;
	const first = (...keys: string[]) => keys.map(k => input[k]).find(v => typeof v === 'string') as string | undefined;
	switch (toolName) {
		case 'Bash':
			return `run \`${first('command') ?? ''}\``;
		case 'Write':
		case 'Edit':
		case 'MultiEdit':
			return `${toolName === 'Write' ? 'write' : 'edit'} ${first('file_path') ?? 'a file'}`;
		case 'WebFetch':
			return `fetch ${first('url') ?? 'a web page'}`;
		case 'WebSearch':
			return `search the web for "${first('query') ?? ''}"`;
		default: {
			const detail = first('command', 'path', 'file_path', 'url', 'query');
			return `use ${toolName.replace(/^mcp__/, '').replace(/__/g, '.')}${detail ? ` (${detail})` : ''}`;
		}
	}
}

/**
 * Receives approval requests from agents over a local socket and holds them until the user decides.
 * "Always" answers are remembered per employee for the life of this polyagent session.
 */
export class ApprovalBroker {
	readonly socketPath: string;
	pending: ApprovalRequest[] = [];
	version = 0;
	private nextId = 1;
	private readonly server: net.Server;
	private readonly waiting = new Map<number, net.Socket>();
	private readonly rules = new Map<string, Set<string>>();
	private readonly listeners = new Set<() => void>();

	constructor() {
		this.socketPath =
			process.platform === 'win32'
				? `\\\\.\\pipe\\polyagent-${process.pid}-${Date.now()}`
				: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'polyagent-')), 'approvals.sock');
		this.server = net.createServer(socket => this.accept(socket));
	}

	start(): Promise<void> {
		return new Promise((resolve, reject) => {
			this.server.once('error', reject);
			this.server.listen(this.socketPath, () => resolve());
		});
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	private changed(): void {
		this.version++;
		for (const listener of this.listeners) listener();
	}

	private accept(socket: net.Socket): void {
		let buffer = '';
		let id: number | undefined;
		socket.setEncoding('utf8');
		socket.on('data', chunk => {
			buffer += chunk;
			const end = buffer.indexOf('\n');
			if (end < 0 || id !== undefined) return;
			let message: {agent?: string; tool_name?: string; input?: Record<string, unknown>};
			try {
				message = JSON.parse(buffer.slice(0, end));
			} catch {
				socket.end();
				return;
			}

			const request: ApprovalRequest = {
				id: this.nextId++,
				agent: message.agent ?? 'unknown',
				toolName: message.tool_name ?? 'unknown',
				input: message.input ?? {},
				createdAt: Date.now(),
			};
			if (this.rules.get(request.agent)?.has(ruleFor(request.toolName, request.input))) {
				this.reply(socket, request, 'allow');
				return;
			}

			id = request.id;
			this.waiting.set(id, socket);
			this.pending.push(request);
			this.changed();
		});
		// The agent was stopped while waiting: drop its request.
		socket.on('close', () => {
			if (id === undefined || !this.waiting.has(id)) return;
			this.waiting.delete(id);
			this.pending = this.pending.filter(r => r.id !== id);
			this.changed();
		});
		socket.on('error', () => {});
	}

	private reply(socket: net.Socket, request: ApprovalRequest, decision: Decision, message?: string): void {
		const answer =
			decision === 'deny'
				? {behavior: 'deny', message: message ?? 'The user declined this. Do not retry it; continue without it or explain what you needed.'}
				: {behavior: 'allow', updatedInput: request.input};
		socket.end(JSON.stringify(answer) + '\n');
	}

	decide(id: number, decision: Decision, message?: string): void {
		const request = this.pending.find(r => r.id === id);
		const socket = this.waiting.get(id);
		if (!request || !socket) return;
		if (decision === 'always') {
			const rules = this.rules.get(request.agent) ?? new Set<string>();
			rules.add(ruleFor(request.toolName, request.input));
			this.rules.set(request.agent, rules);
		}

		this.waiting.delete(id);
		this.pending = this.pending.filter(r => r.id !== id);
		this.reply(socket, request, decision, message);
		// An "always" answer may settle other requests that are already waiting.
		if (decision === 'always') {
			for (const other of [...this.pending]) {
				if (other.agent === request.agent && ruleFor(other.toolName, other.input) === ruleFor(request.toolName, request.input)) this.decide(other.id, 'allow');
			}
		}

		this.changed();
	}

	/** The MCP config and flags that make a Claude Code agent ask polyagent instead of auto-denying. */
	claudeArgs(agent: string): string[] {
		const config = {
			mcpServers: {
				polyagent: {
					command: process.execPath,
					args: ['--input-type=module', '-e', APPROVAL_SERVER_SOURCE],
					env: {POLYAGENT_SOCKET: this.socketPath, POLYAGENT_AGENT: agent},
				},
			},
		};
		return ['--mcp-config', JSON.stringify(config), '--permission-prompt-tool', APPROVAL_TOOL];
	}

	close(): void {
		for (const socket of this.waiting.values()) socket.destroy();
		this.server.close();
		if (process.platform !== 'win32') fs.rmSync(path.dirname(this.socketPath), {recursive: true, force: true});
	}
}
