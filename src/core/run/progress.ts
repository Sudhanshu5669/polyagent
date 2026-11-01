import type {ChatEntry} from '../transcript.js';
import type {RunEvent, RunState, Task} from './types.js';

type ToolEntry = Extract<ChatEntry, {kind: 'tool'}>;

/** How far along one employee is: finished tasks, with the running one counted as half done. */
export function laneProgress(tasks: Task[], employeeId: string): {done: number; total: number; fraction: number} {
	const mine = tasks.filter(t => t.assignee === employeeId && t.status !== 'cancelled');
	const done = mine.filter(t => t.status === 'done').length;
	const running = mine.filter(t => t.status === 'running').length;
	return {done, total: mine.length, fraction: mine.length ? Math.min(1, (done + running * 0.5) / mine.length) : 0};
}

/** The whole run: finished tasks out of all tasks the orchestrator has planned. */
export function runProgress(state: RunState): {done: number; total: number; fraction: number} {
	const tasks = state.tasks.filter(t => t.status !== 'cancelled');
	const done = tasks.filter(t => t.status === 'done').length;
	const running = tasks.filter(t => t.status === 'running').length;
	return {done, total: tasks.length, fraction: tasks.length ? Math.min(1, (done + running * 0.5) / tasks.length) : 0};
}

/**
 * A rough time left, from how long finished tasks took. Undefined until one has finished, since before that it
 * would be a guess. Tasks that run side by side are counted once, so it is a floor under heavy dependencies.
 */
export function estimateEta(state: RunState, now = Date.now()): number | undefined {
	const finished = state.tasks.filter(t => t.status === 'done' && t.startedAt && t.endedAt);
	if (finished.length === 0) return undefined;
	const average = finished.reduce((sum, t) => sum + (t.endedAt! - t.startedAt!), 0) / finished.length;
	const running = state.tasks.filter(t => t.status === 'running');
	const waiting = state.tasks.filter(t => t.status === 'ready' || t.status === 'blocked').length;
	if (running.length + waiting === 0) return 0;
	const inFlight = running.reduce((max, t) => Math.max(max, average - (now - (t.startedAt ?? now))), 0);
	const lanes = Math.max(1, new Set(state.tasks.filter(t => t.status !== 'done' && t.status !== 'cancelled').map(t => t.assignee)).size);
	return Math.max(0, inFlight) + (waiting * average) / lanes;
}

/** "1:02:03" or "02:03". */
export function formatClock(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const pad = (n: number) => String(n).padStart(2, '0');
	return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

/** "9m", "1h 05m", "40s": for how long something took. */
export function formatSpan(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m`;
	return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

export function formatTokens(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export interface Activity {
	/** What they are doing in one line: the tool they are in, or the last thing they said. */
	text: string;
	/** A tool is running right now (shown with a spinner). */
	running: boolean;
}

/** The latest thing an agent did, for the lane next to their name. */
export function laneActivity(log: ChatEntry[]): Activity | undefined {
	for (let i = log.length - 1; i >= 0; i--) {
		const entry = log[i]!;
		if (entry.kind === 'turn' || entry.kind === 'thinking') continue;
		if (entry.kind === 'tool') return {text: `${entry.name} ${entry.summary}`.trim(), running: entry.status === 'running'};
		if (entry.kind === 'text') return {text: firstLine(entry.text), running: false};
		if (entry.kind === 'error') return {text: entry.message, running: false};
		if (entry.kind === 'note' || entry.kind === 'brief') continue;
	}

	return undefined;
}

export function firstLine(text: string): string {
	return text.split('\n').find(l => l.trim())?.trim() ?? '';
}

/** A short excerpt of a longer text: the first paragraph, cut at a word. */
export function excerpt(text: string | undefined, max = 280): string {
	const body = (text ?? '').trim().split(/\n\s*\n/)[0]?.replace(/\s+/g, ' ') ?? '';
	if (body.length <= max) return body;
	const cut = body.slice(0, max);
	return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 20))}…`;
}

const TEST_COMMAND = /\b(vitest|jest|mocha|ava|tap|pytest|unittest|rspec|phpunit|playwright|cypress)\b|\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\bcargo\s+(test|nextest)\b|\bgo\s+test\b|\bdotnet\s+test\b|\bmvn\s+test\b|\bgradle\w*\s+test\b|\bmake\s+test\b/i;

/** Whether a tool call ran a test suite. */
export function isTestRun(entry: ChatEntry): entry is ToolEntry {
	return entry.kind === 'tool' && /^(run|bash|shell|exec|command|powershell)/i.test(entry.name) && TEST_COMMAND.test(entry.summary);
}

export interface TestCounts {
	passed: number;
	failed: number;
	total?: number;
}

/** Read pass/fail counts from the common test runners' summary lines. */
export function parseTestCounts(output: string | undefined): TestCounts | undefined {
	if (!output) return undefined;
	const num = (re: RegExp) => {
		const m = re.exec(output);
		return m ? Number(m[1]) : undefined;
	};

	// vitest / jest: "Tests  3 failed | 11 passed (14)" or "Tests: 1 failed, 4 passed, 5 total"
	const line = /^\s*Tests:?\s+(.*)$/m.exec(output)?.[1];
	if (line) {
		const passed = Number(/(\d+)\s+passed/.exec(line)?.[1] ?? 0);
		const failed = Number(/(\d+)\s+failed/.exec(line)?.[1] ?? 0);
		const total = Number(/\((\d+)\)/.exec(line)?.[1] ?? /(\d+)\s+total/.exec(line)?.[1] ?? passed + failed);
		return {passed, failed, total};
	}

	// cargo: "test result: ok. 4 passed; 0 failed"
	const cargo = /test result: \w+\. (\d+) passed; (\d+) failed/.exec(output);
	if (cargo) return {passed: Number(cargo[1]), failed: Number(cargo[2]), total: Number(cargo[1]) + Number(cargo[2])};

	// pytest: "3 passed, 1 failed in 0.4s" / "== 3 passed in 0.1s =="
	const passed = num(/(\d+) passed/);
	const failed = num(/(\d+) failed/);
	if (passed !== undefined || failed !== undefined) return {passed: passed ?? 0, failed: failed ?? 0, total: (passed ?? 0) + (failed ?? 0)};
	return undefined;
}

export interface DiffStat {
	file: string;
	added: number;
	removed: number;
}

/** Per-file +/− counts from a unified diff. */
export function diffStats(patch: string): DiffStat[] {
	const stats: DiffStat[] = [];
	let current: DiffStat | undefined;
	for (const line of patch.split('\n')) {
		const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
		if (header) {
			current = {file: header[2]!, added: 0, removed: 0};
			stats.push(current);
		} else if (current && line.startsWith('+') && !line.startsWith('+++')) current.added++;
		else if (current && line.startsWith('-') && !line.startsWith('---')) current.removed++;
	}

	return stats;
}

/** Events the person hasn't seen: everything after `since`. */
export function eventsSince(events: RunEvent[], since: number): RunEvent[] {
	return events.filter(e => e.at > since);
}

export function compactEvents(events: RunEvent[], max = 500): RunEvent[] {
	return events.length > max ? events.slice(events.length - max) : events;
}
