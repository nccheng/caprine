import {MessengerMediaCandidate} from './ai-assist-ipc';
import {normalizeFacebookReelUrl} from './facebook-reel';
import {MediaKind} from './media-contract';

export const messengerMediaSelectors = {
	identity: '[data-message-id], [data-messageid]',
	loadedMedia: '[role="main"] [role="grid"] audio, [role="main"] [role="grid"] video',
	reelLinks: '[role="main"] [role="grid"] a[href]',
} as const;

export type MessengerMediaDomResolution = {
	durationSeconds?: number;
	kind: MediaKind;
	messageId: string;
	sourceType?: 'blob' | 'https' | 'segmented';
	status: 'available' | 'unavailable' | 'unsupported';
	url?: string;
};

function mediaKind(element: Element): MediaKind | undefined {
	const tagName = element.localName.toLowerCase();
	if (tagName === 'audio' || tagName === 'video') {
		return tagName;
	}

	return reelUrl(element) ? 'video' : undefined;
}

function reelUrl(element: Element): string | undefined {
	if (element.localName.toLowerCase() !== 'a') {
		return;
	}

	const anchor = element as HTMLAnchorElement;
	const href = anchor.href.length > 0 ? anchor.href : element.getAttribute('href');
	return normalizeFacebookReelUrl(href ?? '');
}

function normalizedMediaDuration(element: Element): number | undefined {
	const {duration} = element as HTMLMediaElement;
	return Number.isFinite(duration) && duration >= 0
		? Math.min(duration, 7 * 24 * 60 * 60)
		: undefined;
}

function stableMessageId(element: Element): string | undefined {
	const identity = element.matches(messengerMediaSelectors.identity)
		? element
		: element.closest(messengerMediaSelectors.identity);
	const messageId = identity?.getAttribute('data-message-id')
		?? identity?.getAttribute('data-messageid');
	return messageId && /^[^\s\p{C}]{1,200}$/u.test(messageId)
		? messageId
		: undefined;
}

function sourceUrl(element: Element): string {
	const media = element as HTMLMediaElement;
	if (media.currentSrc) {
		return media.currentSrc;
	}

	if (media.src) {
		return media.src;
	}

	return element.getAttribute('src') ?? '';
}

function isSegmentedMediaSource(element: Element, url: string): boolean {
	if (url.startsWith('mediasource:')) {
		return true;
	}

	const sourceType = element.querySelector('source[type]')?.getAttribute('type')?.toLowerCase();
	if (sourceType && [
		'application/dash+xml',
		'application/vnd.apple.mpegurl',
		'application/x-mpegurl',
	].includes(sourceType)) {
		return true;
	}

	try {
		return /\.(?:m3u8|mpd)$/i.test(new URL(url).pathname);
	} catch {
		return false;
	}
}

export function extractLoadedMessengerMediaCandidates(root: ParentNode): MessengerMediaCandidate[] {
	const candidates: MessengerMediaCandidate[] = [];
	const seen = new Set<string>();
	const elements = [
		...root.querySelectorAll(messengerMediaSelectors.loadedMedia),
		...root.querySelectorAll(messengerMediaSelectors.reelLinks),
	];
	for (const media of elements) {
		const messageId = stableMessageId(media);
		const kind = mediaKind(media);
		if (!messageId || !kind) {
			continue;
		}

		const key = `${messageId}:${kind}`;
		if (seen.has(key)) {
			continue;
		}

		seen.add(key);
		const candidate: MessengerMediaCandidate = {kind, messageId};
		const durationSeconds = normalizedMediaDuration(media);
		if (durationSeconds !== undefined) {
			candidate.durationSeconds = durationSeconds;
		}

		candidates.push(candidate);
	}

	return candidates.slice(-100);
}

export function resolveMessengerMediaDomCandidate(
	root: ParentNode,
	messageId: string,
	kind: MediaKind,
): MessengerMediaDomResolution {
	let media: Element | undefined;
	for (const identity of root.querySelectorAll(messengerMediaSelectors.identity)) {
		const {dataset} = identity as HTMLElement;
		const candidateId = dataset.messageId ?? dataset.messageid;
		if (candidateId === messageId) {
			media = identity.matches(kind) ? identity : identity.querySelector(kind) ?? undefined;
			if (!media && kind === 'video') {
				media = [...identity.querySelectorAll('a[href]')].find(element => reelUrl(element));
			}

			break;
		}
	}

	const durationSeconds = media ? normalizedMediaDuration(media) : undefined;
	const base = {
		...(durationSeconds === undefined ? {} : {durationSeconds}),
		kind,
		messageId,
	};
	if (!media) {
		return {...base, status: 'unavailable'};
	}

	const url = sourceUrl(media);
	const normalizedReelUrl = reelUrl(media);
	if (normalizedReelUrl) {
		return {
			...base, sourceType: 'https', status: 'available', url: normalizedReelUrl,
		};
	}

	if (isSegmentedMediaSource(media, url)) {
		return {...base, sourceType: 'segmented', status: 'unsupported'};
	}

	if (/^https:\/\//i.test(url)) {
		return {
			...base, sourceType: 'https', status: 'available', url,
		};
	}

	if (url.startsWith('blob:')) {
		return {
			...base, sourceType: 'blob', status: 'available', url,
		};
	}

	return {...base, sourceType: 'segmented', status: 'unsupported'};
}
