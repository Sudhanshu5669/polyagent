import fs from 'node:fs';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {loadEmployees} from '../src/core/employees.js';
import {hireTeam, MAX_PROPOSED, parseTeamProposal, proposeTeam, type ProposedEmployee, type Roster} from '../src/core/run/staffing.js';
import {tmpDir} from './helpers.js';

const FAKE = path.join(import.meta.dirname, 'fixtures', 'fake-agent.mjs');

const roster: Roster = {claude: [{id: 'opus'}, {id: 'haiku'}], codex: undefined};

const raw = (overrides: Record<string, unknown> = {}) => ({
	name: 'Maya',
	role: 'backend',
	provider: 'claude',
	model: null,
	permissions: 'auto-edit',
	owns: ['src/api/**'],
	summary: 'APIs',
	briefing: 'Precise specs',
	system_prompt: 'You are a backend engineer.',
	...overrides,
});

describe('parseTeamProposal', () => {
	it('reads a team from structured output', () => {
		const proposal = parseTeamProposal({note: 'One backend dev is enough.', employees: [raw({model: 'opus'})]}, undefined, roster, 'claude');
		expect(proposal).toEqual({
			note: 'One backend dev is enough.',
			employees: [
				{
					name: 'Maya',
					role: 'backend',
					provider: 'claude',
					model: 'opus',
					permissions: 'auto-edit',
					owns: ['src/api/**'],
					summary: 'APIs',
					briefing: 'Precise specs',
					systemPrompt: 'You are a backend engineer.',
				},
			],
		});
	});

	it('falls back to JSON in the final text', () => {
		const text = 'Here is the team:\n```json\n' + JSON.stringify({note: '', employees: [raw()]}) + '\n```';
		expect(parseTeamProposal(undefined, text, roster, 'claude')?.employees).toHaveLength(1);
	});

	it('keeps proposals within what is installed and allowed', () => {
		const proposal = parseTeamProposal(
			{
				note: '',
				employees: [
					raw({provider: 'antigravity', model: 'gemini-pro'}),
					raw({name: 'maya', model: 'gpt-x', provider: 'codex'}),
					raw({name: 'Rex', role: 'Code Reviewer', permissions: 'full-auto', model: 'sonnet'}),
					raw({name: '  '}),
				],
			},
			undefined,
			roster,
			'claude',
		)!;
		expect(proposal.employees.map(e => [e.name, e.role, e.provider, e.model, e.permissions])).toEqual([
			// Antigravity isn't installed, so the orchestrator's CLI takes over and its model goes.
			['Maya', 'backend', 'claude', undefined, 'auto-edit'],
			// Codex couldn't list its models, so none is trusted; the clashing name gets a number.
			['maya 2', 'backend', 'codex', undefined, 'auto-edit'],
			// A proposal can't ask for full-auto, and "sonnet" isn't in the list it was given.
			['Rex', 'code', 'claude', undefined, 'read-only'],
		]);
	});

	it(`hires at most ${MAX_PROPOSED}`, () => {
		const employees = Array.from({length: MAX_PROPOSED + 3}, (_, i) => raw({name: `E${i}`}));
		expect(parseTeamProposal({note: '', employees}, undefined, roster, 'claude')?.employees).toHaveLength(MAX_PROPOSED);
	});

	it('rejects replies that are not a team', () => {
		expect(parseTeamProposal({tasks: []}, 'no team here', roster, 'claude')).toBeUndefined();
	});
});

describe('proposeTeam', () => {
	let dir: string;
	let savedEnv: NodeJS.ProcessEnv;

	beforeEach(() => {
		savedEnv = {...process.env};
		dir = tmpDir();
		process.env.FAKE_DIR = dir;
		// Claude Code's model list reads the user's config file; keep the real one out of it.
		process.env.HOME = dir;
		delete process.env.CLAUDE_CONFIG_DIR;
		fs.chmodSync(FAKE, 0o755);
	});

	afterEach(() => {
		process.env = savedEnv;
	});

	const calls = () =>
		fs
			.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8')
			.trim()
			.split('\n')
			.map(l => JSON.parse(l) as {prompt: string; resume?: string});

	it('asks the orchestrator for a team, then asks again with feedback in the same session', async () => {
		fs.writeFileSync(
			path.join(dir, 'decisions.json'),
			JSON.stringify([
				{note: 'Two people.', employees: [raw(), raw({name: 'Leo', role: 'frontend', model: 'haiku', provider: 'codex'})]},
				{note: 'Just one.', employees: [raw()]},
			]),
		);
		const options = {cwd: dir, request: 'Add a health endpoint', orchestrator: 'claude' as const, binaryFor: (p: string) => (p === 'claude' ? FAKE : undefined)};

		const first = await proposeTeam(options).done;
		expect(first.proposal.note).toBe('Two people.');
		// Codex isn't installed, so Leo moves to Claude Code; haiku is one of its aliases.
		expect(first.proposal.employees.map(e => [e.name, e.provider, e.model])).toEqual([
			['Maya', 'claude', undefined],
			['Leo', 'claude', 'haiku'],
		]);
		expect(calls()[0]!.prompt).toContain('Add a health endpoint');

		const second = await proposeTeam({...options, retry: {sessionId: first.sessionId, feedback: 'Drop Leo'}}).done;
		expect(second.proposal.employees.map(e => e.name)).toEqual(['Maya']);
		expect(calls()[1]).toMatchObject({resume: first.sessionId, prompt: expect.stringContaining('Drop Leo')});
	});

	it('reports a reply that is not a team', async () => {
		fs.writeFileSync(path.join(dir, 'decisions.json'), JSON.stringify(['bad']));
		await expect(proposeTeam({cwd: dir, request: 'x', orchestrator: 'claude', binaryFor: () => FAKE}).done).rejects.toThrow("wasn't a team");
	});
});

describe('hireTeam', () => {
	it('saves each employee under an id that does not clash', async () => {
		const workspace = tmpDir();
		const maya: ProposedEmployee = {
			name: 'Maya',
			role: 'backend',
			provider: 'claude',
			permissions: 'auto-edit',
			owns: [],
			summary: 'APIs',
			briefing: '',
			systemPrompt: 'Be careful.',
		};
		expect(await hireTeam(workspace, [maya, {...maya, name: 'Leo'}], ['maya'])).toEqual(['maya-2', 'leo']);
		const {employees} = await loadEmployees(workspace);
		expect(employees.map(e => [e.id, e.name, e.systemPrompt])).toEqual([
			['leo', 'Leo', 'Be careful.'],
			['maya-2', 'Maya', 'Be careful.'],
		]);
	});
});
