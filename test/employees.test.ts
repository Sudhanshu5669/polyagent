import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {employeeSystemPrompt} from '../src/core/chat.js';
import {deleteEmployee, loadEmployees, parseEmployee, saveEmployee, serializeEmployee, slugify, uniqueId} from '../src/core/employees.js';
import {tmpDir} from './helpers.js';

const maya = {
	name: 'Maya',
	role: 'backend',
	provider: 'codex' as const,
	permissions: 'auto-edit' as const,
	owns: ['src/api/**', 'prisma/**'],
	summary: 'Builds REST endpoints and DB schema. Never touches UI.',
	briefing: 'Precise spec: file paths, acceptance criteria. No prose.',
	systemPrompt: 'You are a backend engineer.\n\nKeep handlers small.',
};

describe('employee files', () => {
	it('round-trips through Markdown with YAML frontmatter', () => {
		const text = serializeEmployee(maya);
		expect(text).toMatch(/^---\nname: Maya\nrole: backend\nprovider: codex\n/);
		expect(text).toContain('\n---\n\nYou are a backend engineer.');
		expect(parseEmployee('maya', '/x/maya.md', text)).toEqual({...maya, model: undefined, id: 'maya', file: '/x/maya.md'});
	});

	it('fills defaults for optional fields', () => {
		const e = parseEmployee('a', 'a.md', '---\nname: A\nrole: docs\nprovider: claude\n---\n');
		expect(e).toMatchObject({permissions: 'read-only', owns: [], summary: '', briefing: '', systemPrompt: ''});
	});

	it('explains what is wrong with a broken file', () => {
		expect(() => parseEmployee('a', 'a.md', 'no frontmatter')).toThrow(/frontmatter/);
		expect(() => parseEmployee('a', 'a.md', '---\nname: A\nrole: x\nprovider: gpt\n---\n')).toThrow(/provider/);
		expect(() => parseEmployee('a', 'a.md', '---\nname: [unclosed\n---\n')).toThrow(/YAML/);
	});

	it('loads valid employees and reports broken ones without failing', async () => {
		const ws = tmpDir();
		await saveEmployee(ws, 'maya', maya);
		fs.writeFileSync(path.join(ws, 'employees', 'oops.md'), 'not an employee');
		const {employees, broken} = await loadEmployees(ws);
		expect(employees.map(e => e.id)).toEqual(['maya']);
		expect(broken).toMatchObject([{id: 'oops', error: expect.stringMatching(/frontmatter/)}]);
	});

	it('deletes the file and the chat history', async () => {
		const ws = tmpDir();
		await saveEmployee(ws, 'maya', maya);
		fs.mkdirSync(path.join(ws, 'chats', 'maya'), {recursive: true});
		await deleteEmployee(ws, 'maya');
		expect(fs.existsSync(path.join(ws, 'employees', 'maya.md'))).toBe(false);
		expect(fs.existsSync(path.join(ws, 'chats', 'maya'))).toBe(false);
	});
});

describe('ids', () => {
	it('slugifies names and avoids collisions', () => {
		expect(slugify('Maya Lopez!')).toBe('maya-lopez');
		expect(slugify('Zoë')).toBe('zoe');
		expect(slugify('***')).toBe('employee');
		expect(uniqueId('Maya', ['maya', 'maya-2'])).toBe('maya-3');
	});
});

describe('employeeSystemPrompt', () => {
	it('introduces the employee to the team before their own prompt', () => {
		const prompt = employeeSystemPrompt({...maya, id: 'maya', file: ''});
		expect(prompt).toMatch(/^You are Maya, the backend on a team of AI agents/);
		expect(prompt).toContain('You work in: src/api/**, prisma/**.');
		expect(prompt.endsWith('Keep handlers small.')).toBe(true);
	});
});
