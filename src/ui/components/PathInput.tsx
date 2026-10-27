import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {expandHome} from '../../core/paths.js';
import {TextInput, type Completion} from './TextInput.js';

interface Props {
	initialValue?: string;
	placeholder?: string;
	onSubmit: (value: string) => void;
	onCancel: () => void;
	isActive?: boolean;
}

/** Shell-style tab completion: complete a unique match, or the longest common prefix of several. */
export async function completePath(input: string, home = os.homedir()): Promise<Completion> {
	const expanded = expandHome(input, home);
	const endsWithSep = input.endsWith('/') || input.endsWith(path.sep);
	const dir = endsWithSep ? expanded : path.dirname(expanded);
	const base = endsWithSep ? '' : path.basename(expanded);

	let entries: {name: string; isDir: boolean}[];
	try {
		const dirents = await fs.readdir(dir || '.', {withFileTypes: true});
		entries = dirents.map(d => ({name: d.name, isDir: d.isDirectory()}));
	} catch {
		return {value: input, candidates: []};
	}

	const showHidden = base.startsWith('.');
	const matches = entries.filter(e => e.name.startsWith(base) && (showHidden || !e.name.startsWith('.')));
	if (matches.length === 0) return {value: input, candidates: []};

	// Rebuild from the user's own spelling of the directory so "~/" stays "~/".
	const typedDir = endsWithSep ? input : input.slice(0, input.length - base.length);
	if (matches.length === 1) {
		const [only] = matches;
		return {value: typedDir + only!.name + (only!.isDir ? '/' : ''), candidates: []};
	}

	const names = matches.map(m => m.name).sort();
	let prefix = names[0]!;
	for (const name of names) while (!name.startsWith(prefix)) prefix = prefix.slice(0, -1);
	return {value: typedDir + prefix, candidates: names};
}

export function PathInput(props: Props) {
	return <TextInput {...props} complete={value => completePath(value)} />;
}
