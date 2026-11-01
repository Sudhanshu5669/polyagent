import {describe, expect, it} from 'vitest';
import type {Employee} from '../src/core/employees.js';
import {findEmployee, fuzzyScore, parseInput, suggest} from '../src/core/run/input.js';

const employee = (id: string, name = id[0]!.toUpperCase() + id.slice(1)): Employee => ({
	id,
	file: '',
	name,
	role: 'backend',
	provider: 'claude',
	permissions: 'auto-edit',
	owns: [],
	summary: '',
	briefing: '',
	systemPrompt: '',
});

const team = [employee('maya'), employee('maya-2', 'Maya 2'), employee('leo'), employee('pixel')];

describe('findEmployee', () => {
	it('matches ids, names and unambiguous prefixes', () => {
		expect(findEmployee('leo', team)).toBe(team[2]);
		expect(findEmployee('LEO', team)).toBe(team[2]);
		expect(findEmployee('pi', team)).toBe(team[3]);
		expect(findEmployee('maya-2', team)).toBe(team[1]);
		expect(findEmployee('maya', team)).toBe(team[0]);
		expect(findEmployee('ma', team)).toBe('ambiguous');
		expect(findEmployee('zed', team)).toBeUndefined();
		expect(findEmployee('', team)).toBeUndefined();
	});
});

describe('parseInput', () => {
	it('sends plain text to the orchestrator, or to the employee being watched', () => {
		expect(parseInput('  add a test ', team)).toEqual({kind: 'tell', text: 'add a test'});
		expect(parseInput('add a test', team, team[2])).toEqual({kind: 'employee', employee: team[2], text: 'add a test'});
	});

	it('routes @mentions to one employee, even while watching another', () => {
		expect(parseInput('@pixel start on layout', team, team[2])).toEqual({kind: 'employee', employee: team[3], text: 'start on layout'});
		expect(parseInput('@zed hi', team)).toMatchObject({kind: 'error'});
		expect(parseInput('@ma hi', team)).toMatchObject({kind: 'error'});
		expect(parseInput('@pixel', team)).toMatchObject({kind: 'error'});
	});

	it('parses commands', () => {
		expect(parseInput('/cost', team)).toEqual({kind: 'command', name: 'cost', arg: ''});
		expect(parseInput('/fire leo', team)).toEqual({kind: 'command', name: 'fire', arg: 'leo', employee: team[2]});
		expect(parseInput('/fire', team)).toMatchObject({kind: 'error'});
		expect(parseInput('/fire zed', team)).toMatchObject({kind: 'error'});
		expect(parseInput('/nope', team)).toMatchObject({kind: 'error'});
		expect(parseInput('', team)).toMatchObject({kind: 'error'});
	});
});

describe('suggest', () => {
	it('offers employees after @ and commands after /', () => {
		expect(suggest('@p', team).map(s => s.value)).toEqual(['@pixel ']);
		expect(suggest('@', team)).toHaveLength(4);
		expect(suggest('/c', team).map(s => s.label)).toEqual(['/cost']);
		expect(suggest('/fire l', team).map(s => s.value)).toEqual(['/fire leo']);
		expect(suggest('hello', team)).toEqual([]);
		expect(suggest('@pixel hi', team)).toEqual([]);
	});
});

describe('fuzzyScore', () => {
	it('matches subsequences and prefers tight, early matches', () => {
		expect(fuzzyScore('fg', 'forge')).toBeDefined();
		expect(fuzzyScore('xyz', 'forge')).toBeUndefined();
		expect(fuzzyScore('', 'anything')).toBe(0);
		expect(fuzzyScore('for', 'forge')!).toBeGreaterThan(fuzzyScore('for', 'a far off room')!);
	});
});
