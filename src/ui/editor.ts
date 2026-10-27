import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function editorCommand(env = process.env): string {
	return env.VISUAL || env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'vi');
}

/** Open a file in the user's editor and wait for it to close. The caller must suspend the TUI first. */
export function openInEditor(file: string): Promise<void> {
	return new Promise((resolve, reject) => {
		// Through a shell so editors configured with flags (e.g. "code --wait") work.
		const child = spawn(`${editorCommand()} ${JSON.stringify(file)}`, {stdio: 'inherit', shell: true});
		child.once('error', reject);
		child.once('exit', code => (code === 0 ? resolve() : reject(new Error(`${editorCommand()} exited with code ${code}`))));
	});
}

/** Edit a piece of text in the user's editor via a temp file; returns the new text. */
export async function editText(text: string, name = 'polyagent.md'): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'polyagent-'));
	const file = path.join(dir, name);
	try {
		await fs.writeFile(file, text);
		await openInEditor(file);
		return await fs.readFile(file, 'utf8');
	} finally {
		await fs.rm(dir, {recursive: true, force: true});
	}
}
