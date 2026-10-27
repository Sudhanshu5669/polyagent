import fs from 'node:fs/promises';
import path from 'node:path';

export async function exists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}

export async function readJson(p: string): Promise<unknown | undefined> {
	let raw: string;
	try {
		raw = await fs.readFile(p, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
		throw error;
	}

	try {
		return JSON.parse(raw);
	} catch (error) {
		throw new Error(`${p} is not valid JSON: ${(error as Error).message}`);
	}
}

/** Write via temp file + rename so a crash never leaves a half-written file behind. */
export async function writeFileAtomic(p: string, content: string): Promise<void> {
	await fs.mkdir(path.dirname(p), {recursive: true});
	const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
	await fs.writeFile(tmp, content, 'utf8');
	await fs.rename(tmp, p);
}

export async function writeJson(p: string, value: unknown): Promise<void> {
	await writeFileAtomic(p, JSON.stringify(value, null, 2) + '\n');
}
