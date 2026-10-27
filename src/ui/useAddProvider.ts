import path from 'node:path';
import {useState} from 'react';
import {probeVersion} from '../core/detect.js';
import {expandHome} from '../core/paths.js';
import {guessProvider, type ProviderId} from '../core/providers.js';

export type AddState =
	| {step: 'idle'}
	| {step: 'typing'; error?: string; initial?: string}
	| {step: 'probing'; path: string}
	| {step: 'confirm'; path: string; version: string; guess?: ProviderId};

/** Flow for adding a CLI by path: type path → run --version → confirm which provider it is. */
export function useAddProvider() {
	const [state, setState] = useState<AddState>({step: 'idle'});

	const start = (initial?: string) => setState({step: 'typing', initial});
	const cancel = () => setState({step: 'idle'});

	const submitPath = async (input: string) => {
		const file = path.resolve(expandHome(input));
		setState({step: 'probing', path: file});
		try {
			const version = await probeVersion(file);
			setState({step: 'confirm', path: file, version, guess: guessProvider(file, version)});
		} catch (error) {
			setState({step: 'typing', initial: input, error: `Couldn't run ${input} --version: ${(error as Error).message}`});
		}
	};

	return {state, start, cancel, submitPath};
}
