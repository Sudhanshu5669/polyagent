#!/usr/bin/env node
// A stand-in agent CLI that speaks Claude Code's stream-json format.
//
// Orchestrator turns (called with --json-schema) replay decisions from $FAKE_DIR/decisions.json, one per turn
// ("bad" replays invalid output). Employee turns report back; set $FAKE_FAIL to a task id to make that
// task's first attempt fail, and $FAKE_SLEEP_MS to slow employees down. Every call is logged to $FAKE_DIR/calls.jsonl.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
if (args[0] === '--version') {
	console.log('9.9.9 (Claude Code)');
	process.exit(0);
}

const dir = process.env.FAKE_DIR;
const arg = name => {
	const i = args.indexOf(name);
	return i === -1 ? undefined : args[i + 1];
};

const prompt = arg('-p') ?? '';
const resume = arg('--resume');
const orchestrator = args.includes('--json-schema');
const taskId = /\(id: ([^)]+)\)/.exec(prompt)?.[1];
const started = Date.now();
const emit = event => console.log(JSON.stringify(event));
const session = resume ?? `session-${orchestrator ? 'orchestrator' : taskId}-${process.pid}`;

emit({type: 'system', subtype: 'init', session_id: session});

if (orchestrator) {
	const counterFile = path.join(dir, 'turn');
	const turn = fs.existsSync(counterFile) ? Number(fs.readFileSync(counterFile, 'utf8')) : 0;
	fs.writeFileSync(counterFile, String(turn + 1));
	const decisions = JSON.parse(fs.readFileSync(path.join(dir, 'decisions.json'), 'utf8'));
	const decision = decisions[Math.min(turn, decisions.length - 1)];
	log({role: 'orchestrator', turn});
	if (decision === 'bad') {
		emit({type: 'result', subtype: 'success', is_error: false, result: 'I think we should do some work.', session_id: session});
	} else {
		const full = {note: '', tasks: [], revisions: [], cancel: [], finish: null, ...decision};
		emit({type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(full), structured_output: full, session_id: session, total_cost_usd: 0.01});
	}

	process.exit(0);
}

const attemptFile = path.join(dir, `attempts-${taskId}`);
const attempt = fs.existsSync(attemptFile) ? Number(fs.readFileSync(attemptFile, 'utf8')) + 1 : 1;
fs.writeFileSync(attemptFile, String(attempt));
const sleep = Number(process.env[`FAKE_SLEEP_MS_${taskId}`] ?? process.env.FAKE_SLEEP_MS ?? 0);
if (sleep) await new Promise(r => setTimeout(r, sleep));
log({role: 'employee', task: taskId, attempt});

if (process.env.FAKE_WRITE) fs.writeFileSync(path.join(process.cwd(), process.env.FAKE_WRITE === '1' ? `${taskId}.txt` : process.env.FAKE_WRITE), `written by ${taskId} (attempt ${attempt})\n`);

if (process.env.FAKE_FAIL === taskId && attempt === 1) {
	console.error(`Error: ${taskId} exploded`);
	process.exit(1);
}

emit({type: 'assistant', message: {content: [{type: 'text', text: `Report for ${taskId}: done (attempt ${attempt}).`}]}, session_id: session});
emit({type: 'result', subtype: 'success', is_error: false, result: `Report for ${taskId}: done (attempt ${attempt}).`, session_id: session, total_cost_usd: 0.002});

function log(extra) {
	fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({...extra, prompt, resume, started, ended: Date.now()}) + '\n');
}
