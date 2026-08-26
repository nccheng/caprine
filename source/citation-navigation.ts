import {citationExternalUrl} from './ipc-validation';

export type CitationExternalOpener = (url: string) => Promise<void>;

export async function openCitationExternal(value: unknown, opener: CitationExternalOpener): Promise<void> {
	const url = citationExternalUrl(value);
	if (!url) {
		throw new TypeError('Rejected unsafe AI Assist citation URL');
	}

	await opener(url);
}
