import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tmpDir(prefix = 'polyagent-test-'): string {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** Create an executable shell script that prints `output` (or fails with `exitCode`). */
export function fakeBin(dir: string, name: string, output: string, exitCode = 0): string {
	fs.mkdirSync(dir, {recursive: true});
	const file = path.join(dir, name);
	fs.writeFileSync(file, `#!/bin/sh\necho "${output}"\nexit ${exitCode}\n`, {mode: 0o755});
	return file;
}

export function gitInit(dir: string): void {
	execFileSync('git', ['init', '-q'], {cwd: dir});
}

export function gitStatus(dir: string): string[] {
	return execFileSync('git', ['status', '--porcelain', '-uall'], {cwd: dir, encoding: 'utf8'}).split('\n').filter(Boolean);
}

/** Poll until check() passes. `context` is included in the timeout error, e.g. the last rendered frame. */
export async function waitFor(check: () => boolean, context?: () => string | undefined, timeout = 10_000): Promise<void> {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > timeout) throw new Error(`waitFor timed out${context ? `\n${context()}` : ''}`);
		await new Promise(r => setTimeout(r, 20));
	}
}

/** Send keys after a short pause: Ink attaches input handlers in an effect after the frame is painted. */
export async function press(stdin: {write: (data: string) => void}, ...keys: string[]): Promise<void> {
	for (const key of keys) {
		await new Promise(r => setTimeout(r, 100));
		stdin.write(key);
	}
}
