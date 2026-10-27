import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {createInterface} from 'node:readline';
import {afterEach, describe, expect, it} from 'vitest';
import {APPROVAL_SERVER_SOURCE, ApprovalBroker, describeRequest, ruleFor} from '../src/core/approvals.js';
import {waitFor} from './helpers.js';

/** Drive the MCP stub the way Claude Code does: JSON-RPC lines on stdin/stdout. */
function mcp(broker: ApprovalBroker, agent: string) {
	const child = spawn(process.execPath, ['--input-type=module', '-e', APPROVAL_SERVER_SOURCE], {
		env: {...process.env, POLYAGENT_SOCKET: broker.socketPath, POLYAGENT_AGENT: agent},
	}) as ChildProcessWithoutNullStreams;
	const replies = new Map<number, (value: any) => void>();
	createInterface({input: child.stdout}).on('line', line => {
		const message = JSON.parse(line);
		replies.get(message.id)?.(message);
	});
	let id = 0;
	const call = (method: string, params: unknown = {}) =>
		new Promise<any>(resolve => {
			const n = ++id;
			replies.set(n, resolve);
			child.stdin.write(JSON.stringify({jsonrpc: '2.0', id: n, method, params}) + '\n');
		});
	const approve = (tool_name: string, input: object) =>
		call('tools/call', {name: 'approve', arguments: {tool_name, input}}).then(r => JSON.parse(r.result.content[0].text));
	return {child, call, approve};
}

const brokers: ApprovalBroker[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
afterEach(() => {
	for (const c of children.splice(0)) c.kill();
	for (const b of brokers.splice(0)) b.close();
});

async function setup(agent = 'maya') {
	const broker = new ApprovalBroker();
	await broker.start();
	brokers.push(broker);
	const client = mcp(broker, agent);
	children.push(client.child);
	return {broker, ...client};
}

describe('approval MCP server', () => {
	it('speaks enough MCP for Claude Code to find the tool', async () => {
		const {call} = await setup();
		const init = await call('initialize', {protocolVersion: '2025-06-18'});
		expect(init.result).toMatchObject({protocolVersion: '2025-06-18', capabilities: {tools: {}}});
		const list = await call('tools/list');
		expect(list.result.tools.map((t: {name: string}) => t.name)).toEqual(['approve']);
		expect((await call('resources/list')).error.code).toBe(-32601);
	});

	it('holds a request until the user allows it, and passes the input back unchanged', async () => {
		const {broker, approve} = await setup();
		const answer = approve('Bash', {command: 'npm test'});
		await waitFor(() => broker.pending.length === 1);
		expect(broker.pending[0]).toMatchObject({agent: 'maya', toolName: 'Bash', input: {command: 'npm test'}});
		broker.decide(broker.pending[0]!.id, 'allow');
		expect(await answer).toEqual({behavior: 'allow', updatedInput: {command: 'npm test'}});
		expect(broker.pending).toEqual([]);
	});

	it('sends a reason with a denial', async () => {
		const {broker, approve} = await setup();
		const answer = approve('Bash', {command: 'rm -rf build'});
		await waitFor(() => broker.pending.length === 1);
		broker.decide(broker.pending[0]!.id, 'deny', 'Not today');
		expect(await answer).toEqual({behavior: 'deny', message: 'Not today'});
	});

	it('remembers "always" per employee and settles matching requests already waiting', async () => {
		const {broker, approve} = await setup('maya');
		const first = approve('Bash', {command: 'npm test -- a'});
		const second = approve('Bash', {command: 'npm test -- b'});
		await waitFor(() => broker.pending.length === 2);
		broker.decide(broker.pending[0]!.id, 'always');
		expect((await first).behavior).toBe('allow');
		expect((await second).behavior).toBe('allow');

		// Later matching requests from Maya don't ask at all…
		expect((await approve('Bash', {command: 'npm test --watch'})).behavior).toBe('allow');
		// …but other commands, and other employees, still do.
		void approve('Bash', {command: 'npm publish'});
		const leo = mcp(broker, 'leo');
		children.push(leo.child);
		void leo.approve('Bash', {command: 'npm test'});
		await waitFor(() => broker.pending.length === 2);
	});

	it('drops a request when the agent goes away', async () => {
		const {broker, child, approve} = await setup();
		void approve('Bash', {command: 'sleep 1'});
		await waitFor(() => broker.pending.length === 1);
		child.kill();
		await waitFor(() => broker.pending.length === 0);
	});
});

describe('describing requests', () => {
	it('reads naturally', () => {
		expect(describeRequest({toolName: 'Bash', input: {command: 'npm test'}})).toBe('run `npm test`');
		expect(describeRequest({toolName: 'Write', input: {file_path: 'a.ts'}})).toBe('write a.ts');
		expect(describeRequest({toolName: 'WebFetch', input: {url: 'https://x.dev'}})).toBe('fetch https://x.dev');
		expect(describeRequest({toolName: 'mcp__github__create_issue', input: {}})).toBe('use github.create_issue');
	});

	it('scopes shell rules to the first two words', () => {
		expect(ruleFor('Bash', {command: '  git   diff --stat'})).toBe('Bash(git diff)');
		expect(ruleFor('WebFetch', {url: 'x'})).toBe('WebFetch');
	});
});
