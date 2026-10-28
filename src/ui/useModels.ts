import {useEffect, useState} from 'react';
import {cachedModels, type ModelOption} from '../core/models.js';
import type {ProviderId} from '../core/providers.js';

export type ModelList =
	| {status: 'loading'}
	| {status: 'ready'; models: ModelOption[]}
	| {status: 'failed'; error: string}
	/** The CLI isn't installed, so there's nothing to ask. */
	| {status: 'unavailable'};

/** The models a provider's CLI offers, fetched once per session. */
export function useModels(provider: ProviderId, binary: string | undefined): ModelList {
	const [list, setList] = useState<ModelList>({status: binary ? 'loading' : 'unavailable'});

	useEffect(() => {
		if (!binary) return setList({status: 'unavailable'});
		let live = true;
		setList({status: 'loading'});
		cachedModels(provider, binary).then(
			models => live && setList({status: 'ready', models}),
			(error: Error) => live && setList({status: 'failed', error: error.message}),
		);
		return () => {
			live = false;
		};
	}, [provider, binary]);

	return list;
}
