import {ConversationContextItem} from './messenger-context';
import {MediaKind} from './media-contract';
import type {TranscriptSegment, TranscriptionErrorCode} from './media-transcription';

export const transcriptDisclosure = 'This media will be sent to OpenAI for transcription';
export const maximumReviewedTranscriptCharacters = 100_000;

export type ReviewedTranscriptStatus =
	| 'available'
	| 'preparing'
	| 'ready'
	| 'extracting'
	| 'transcribing'
	| 'completed'
	| 'no-audio'
	| 'canceled'
	| 'oversized'
	| 'unsupported'
	| 'timed-out'
	| 'failed'
	| 'removed';

export type ReviewedTranscriptItem = {
	byteLength?: number;
	contextItemId: string;
	durationSeconds?: number;
	editedSegments?: TranscriptSegment[];
	id: string;
	kind: MediaKind;
	messageId: string;
	mimeType?: string;
	notice?: string;
	originalSegments?: TranscriptSegment[];
	senderLabel: string;
	status: ReviewedTranscriptStatus;
};

function senderLabel(item: Readonly<ConversationContextItem>, kind: MediaKind): string {
	const mediaLabel = kind === 'video' ? 'Video' : 'Voice message';
	if (item.sender.role === 'outgoing') {
		return `${mediaLabel} sent by you`;
	}

	return item.sender.displayName
		? `${mediaLabel} received from ${item.sender.displayName}`
		: `${mediaLabel} received from Messenger participant`;
}

export function createReviewedTranscriptItems(
	items: ReadonlyArray<{id: string; item: Readonly<ConversationContextItem>}>,
	durationForMessage: (messageId: string) => number | undefined = () => undefined,
): ReviewedTranscriptItem[] {
	return items.flatMap(reviewed => {
		const {item} = reviewed;
		let kind: MediaKind | undefined;
		if (item.attachments?.some(attachment => attachment.kind === 'audio')) {
			kind = 'audio';
		} else if (item.attachments?.some(attachment => attachment.kind === 'video')) {
			kind = 'video';
		}

		if (!item.messageId || !kind) {
			return [];
		}

		const durationSeconds = durationForMessage(item.messageId);
		return [{
			contextItemId: reviewed.id,
			...(durationSeconds === undefined ? {} : {durationSeconds}),
			id: `transcript:${reviewed.id}`,
			kind,
			messageId: item.messageId,
			senderLabel: senderLabel(item, kind),
			status: 'available' as const,
		}];
	});
}

export function updateReviewedTranscript(
	items: readonly ReviewedTranscriptItem[],
	id: string,
	update: (item: Readonly<ReviewedTranscriptItem>) => ReviewedTranscriptItem,
): ReviewedTranscriptItem[] | undefined {
	if (!items.some(item => item.id === id)) {
		return undefined;
	}

	return items.map(item => item.id === id ? update(item) : item);
}

export function completeReviewedTranscript(
	item: Readonly<ReviewedTranscriptItem>,
	input: Readonly<{
		byteLength: number;
		durationSeconds: number;
		mimeType: string;
		segments: readonly TranscriptSegment[];
	}>,
): ReviewedTranscriptItem {
	return {
		...item,
		byteLength: input.byteLength,
		durationSeconds: input.durationSeconds,
		mimeType: input.mimeType,
		notice: undefined,
		originalSegments: input.segments.map(segment => ({...segment})),
		status: 'completed',
	};
}

export function editReviewedTranscript(
	item: Readonly<ReviewedTranscriptItem>,
	texts: readonly string[],
): ReviewedTranscriptItem | undefined {
	if (item.status !== 'completed' || !item.originalSegments || texts.length !== item.originalSegments.length) {
		return undefined;
	}

	const normalized = texts.map(text => text.replaceAll(/\r\n?/g, '\n').trim());
	if (normalized.some(text => !text || text.length > 20_000)
		|| normalized.reduce((total, text) => total + text.length, 0) > maximumReviewedTranscriptCharacters) {
		return undefined;
	}

	return {
		...item,
		editedSegments: item.originalSegments.map((segment, index) => ({...segment, text: normalized[index]})),
	};
}

export function removeReviewedTranscript(item: Readonly<ReviewedTranscriptItem>): ReviewedTranscriptItem {
	const {
		byteLength: _byteLength,
		editedSegments: _editedSegments,
		mimeType: _mimeType,
		notice: _notice,
		originalSegments: _originalSegments,
		...retained
	} = item;
	return {...retained, status: 'removed'};
}

export function transcriptFailure(
	item: Readonly<ReviewedTranscriptItem>,
	error: unknown,
): ReviewedTranscriptItem {
	const candidate = error && typeof error === 'object' ? error as {code?: unknown; message?: unknown} : undefined;
	const code: TranscriptionErrorCode = typeof candidate?.code === 'string'
		? candidate.code as TranscriptionErrorCode
		: 'provider-unavailable';
	let status: ReviewedTranscriptStatus = 'failed';
	switch (code) {
		case 'cancelled': {
			status = 'canceled';
			break;
		}

		case 'duration-exceeded':
		case 'oversized': {
			status = 'oversized';
			break;
		}

		case 'unsupported-media': {
			status = 'unsupported';
			break;
		}

		case 'timeout': {
			status = 'timed-out';
			break;
		}

		default:
	}

	return {
		...item,
		notice: typeof candidate?.message === 'string'
			? candidate.message
			: 'OpenAI transcription failed. Text-only context remains available.',
		status,
	};
}

function formattedSeconds(seconds: number): string {
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds - (minutes * 60);
	return `${String(minutes).padStart(2, '0')}:${remainder.toFixed(3).padStart(6, '0')}`;
}

export function reviewedTranscriptExcerpt(item: Readonly<ReviewedTranscriptItem>): string | undefined {
	if (item.status !== 'completed') {
		return undefined;
	}

	const segments = item.editedSegments ?? item.originalSegments;
	if (!segments) {
		return undefined;
	}

	const marker = item.editedSegments ? 'Edited transcript' : 'Original transcript';
	return `${marker}:\n${segments.map(segment => `[${formattedSeconds(segment.startSeconds)}–${formattedSeconds(segment.endSeconds)}] ${segment.text}`).join('\n')}`;
}
