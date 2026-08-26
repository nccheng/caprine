import {ConversationContextItem} from './messenger-context';
import {ConversationSnapshot} from './ai-assist-state';
import {ReviewedImageItem} from './reviewed-images';
import {ReviewedTranscriptItem, reviewedTranscriptExcerpt} from './reviewed-transcripts';

export const contextWindowSizes = [10, 20, 50] as const;
export type ContextWindowSize = typeof contextWindowSizes[number];

export type ReviewedContextItem = {
	editedExcerpt?: string;
	id: string;
	item: ConversationContextItem;
};

export type ContextReviewSnapshot = {
	actualCount: number;
	contextVersion: string;
	images: ReviewedImageItem[];
	items: ReviewedContextItem[];
	newMessagesAvailable: boolean;
	question: string;
	requestedCount: ContextWindowSize;
	snapshot: Readonly<ConversationSnapshot>;
	transcripts: ReviewedTranscriptItem[];
};

export type ContextBackfillStopReason = 'cancelled' | 'complete' | 'conversation-changed' | 'no-more-history' | 'timeout';

type ContextBackfillOptions = {
	backfillOnce: (signal?: AbortSignal) => Promise<'attempted' | 'no-more-history'>;
	isComplete?: (items: readonly ConversationContextItem[]) => boolean;
	isConversationCurrent: () => boolean;
	maximumAttempts?: number;
	now?: () => number;
	readPage: () => readonly ConversationContextItem[];
	requestedCount: ContextWindowSize;
	restore: () => Promise<void> | void;
	signal?: AbortSignal;
	timeoutMilliseconds?: number;
};

type ContextCaptureRequest = {
	requestId: string;
	run: (signal: AbortSignal) => Promise<void>;
};

export function contextReviewSubmissionDecision(locked: boolean):
| {allowed: true}
| {allowed: false; notice: string} {
	return locked
		? {
			allowed: false,
			notice: 'This reviewed context has already been submitted. Refresh context before asking again.',
		}
		: {allowed: true};
}

function freezePlainValue(value: unknown): void {
	if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
		return;
	}

	for (const child of Object.values(value)) {
		freezePlainValue(child);
	}

	Object.freeze(value);
}

export function mergeContextPages(
	olderPage: readonly ConversationContextItem[],
	newerItems: readonly ConversationContextItem[],
): ConversationContextItem[] {
	const structuralSignature = (item: Readonly<ConversationContextItem>): string => JSON.stringify({
		attachments: item.attachments,
		confidence: item.confidence,
		linkPreview: item.linkPreview,
		reactions: item.reactions,
		reply: item.reply,
		sender: item.sender,
		text: item.text,
		timestamp: item.timestamp,
	});
	const sameBoundaryItem = (
		older: Readonly<ConversationContextItem>,
		newer: Readonly<ConversationContextItem>,
	): boolean => {
		if (older.messageId !== undefined || newer.messageId !== undefined) {
			return Boolean(older.messageId && older.messageId === newer.messageId);
		}

		return older.omittedReason === undefined
			&& newer.omittedReason === undefined
			&& structuralSignature(older) === structuralSignature(newer);
	};

	let overlap = 0;
	for (let size = Math.min(olderPage.length, newerItems.length); size > 0; size -= 1) {
		if (olderPage.slice(-size).every((item, index) => sameBoundaryItem(item, newerItems[index]))) {
			overlap = size;
			break;
		}
	}

	const combined = [...olderPage.slice(0, olderPage.length - overlap), ...newerItems];
	const merged: ConversationContextItem[] = [];
	const messageIdIndexes = new Map<string, number>();
	for (const item of combined) {
		if (!item.messageId) {
			merged.push(item);
			continue;
		}

		const previousIndex = messageIdIndexes.get(item.messageId);
		if (previousIndex === undefined) {
			messageIdIndexes.set(item.messageId, merged.length);
			merged.push(item);
		} else {
			merged[previousIndex] = item;
		}
	}

	return merged;
}

export class ContextCaptureCoordinator {
	private active?: {abortController: AbortController; requestId: string};
	private drainPromise?: Promise<void>;
	private queued?: ContextCaptureRequest;

	enqueue(requestId: string, run: (signal: AbortSignal) => Promise<void>): void {
		this.queued = {requestId, run};
		this.active?.abortController.abort();
		this.startDrain();
	}

	cancel(requestId: string): void {
		if (this.queued?.requestId === requestId) {
			this.queued = undefined;
		}

		if (this.active?.requestId === requestId) {
			this.active.abortController.abort();
		}
	}

	async waitForIdle(): Promise<void> {
		while (this.drainPromise) {
			// eslint-disable-next-line no-await-in-loop
			await this.drainPromise;
		}
	}

	private startDrain(): void {
		if (this.drainPromise) {
			return;
		}

		this.drainPromise = this.drain().finally(() => {
			this.drainPromise = undefined;
			if (this.queued) {
				this.startDrain();
			}
		});
	}

	private async drain(): Promise<void> {
		while (this.queued) {
			const request = this.queued;
			this.queued = undefined;
			const abortController = new AbortController();
			this.active = {abortController, requestId: request.requestId};
			try {
				// eslint-disable-next-line no-await-in-loop
				await request.run(abortController.signal);
			} catch {} finally {
				if (this.active?.abortController === abortController) {
					this.active = undefined;
				}
			}
		}
	}
}

export function selectContextWindow(
	items: readonly ConversationContextItem[],
	requestedCount: ContextWindowSize,
	anchorMessageId?: string,
): ConversationContextItem[] {
	if (!contextWindowSizes.includes(requestedCount)) {
		return [];
	}

	if (!anchorMessageId) {
		return items.slice(-requestedCount);
	}

	const anchorIndex = items.findIndex(item => item.messageId === anchorMessageId);
	if (anchorIndex < 0) {
		return [];
	}

	let start = Math.max(0, anchorIndex - Math.floor((requestedCount - 1) / 2));
	let end = Math.min(items.length, start + requestedCount);
	start = Math.max(0, end - requestedCount);
	end = Math.min(items.length, start + requestedCount);
	return items.slice(start, end);
}

export function isContextWindowComplete(
	items: readonly ConversationContextItem[],
	requestedCount: ContextWindowSize,
	anchorMessageId?: string,
): boolean {
	if (selectContextWindow(items, requestedCount, anchorMessageId).length !== requestedCount) {
		return false;
	}

	if (!anchorMessageId) {
		return true;
	}

	const anchorIndex = items.findIndex(item => item.messageId === anchorMessageId);
	return anchorIndex >= Math.floor((requestedCount - 1) / 2);
}

export async function captureBoundedContext(
	options: ContextBackfillOptions,
): Promise<{items: ConversationContextItem[]; stopReason: ContextBackfillStopReason}> {
	const now = options.now ?? Date.now;
	const startedAt = now();
	const timeoutMilliseconds = options.timeoutMilliseconds ?? 2000;
	const maximumAttempts = options.maximumAttempts ?? 8;
	const isComplete = options.isComplete ?? (items => items.length >= options.requestedCount);
	let items = [...options.readPage()];
	let attempts = 0;
	let stopReason: ContextBackfillStopReason = isComplete(items)
		? 'complete'
		: 'timeout';

	try {
		for (; !isComplete(items) && attempts < maximumAttempts;) {
			if (options.signal?.aborted) {
				stopReason = 'cancelled';
				break;
			}

			if (!options.isConversationCurrent()) {
				stopReason = 'conversation-changed';
				break;
			}

			if (now() - startedAt >= timeoutMilliseconds) {
				stopReason = 'timeout';
				break;
			}

			// eslint-disable-next-line no-await-in-loop
			const result = await options.backfillOnce(options.signal);
			attempts += 1;
			if (options.signal?.aborted) {
				stopReason = 'cancelled';
				break;
			}

			if (!options.isConversationCurrent()) {
				stopReason = 'conversation-changed';
				break;
			}

			items = mergeContextPages(options.readPage(), items);
			if (isComplete(items)) {
				stopReason = 'complete';
				break;
			}

			if (result === 'no-more-history') {
				stopReason = 'no-more-history';
				break;
			}
		}
	} finally {
		await options.restore();
	}

	return {items, stopReason};
}

export function contextVersion(
	items: readonly ConversationContextItem[] | Readonly<ConversationContextItem> | undefined,
): string {
	const last = Array.isArray(items) ? items.at(-1) : items;
	if (!last) {
		return 'empty';
	}

	if (last.messageId) {
		return `message:${last.messageId}`;
	}

	let hash = 2_166_136_261;
	for (const character of JSON.stringify(last)) {
		hash = (Math.imul(hash, 16_777_619) + character.codePointAt(0)! + 4_294_967_296) % 4_294_967_296;
	}

	return `fallback:${hash.toString(16)}`;
}

export function restoredConversationScrollTop(
	originalScrollTop: number,
	originalScrollHeight: number,
	currentScrollHeight: number,
): number {
	return Math.max(0, originalScrollTop + Math.max(0, currentScrollHeight - originalScrollHeight));
}

export function contextItemExcerpt(item: Readonly<ConversationContextItem>): string {
	const parts: string[] = [];
	if (item.text) {
		parts.push(item.text);
	}

	if (item.reply) {
		parts.push(`Reply to${item.reply.quotedSender ? ` ${item.reply.quotedSender}` : ''}: ${item.reply.text}`);
	}

	if (item.reactions) {
		parts.push(`Reactions: ${item.reactions.map(reaction => `${reaction.emoji} ${reaction.count}`).join(', ')}`);
	}

	if (item.linkPreview) {
		parts.push(`Link preview: ${item.linkPreview.title ?? item.linkPreview.domain} (${item.linkPreview.url})`);
	}

	if (item.attachments) {
		parts.push(`Attachments: ${item.attachments.map(attachment => attachment.kind).join(', ')}`);
	}

	return parts.join('\n');
}

export function captureContextReviewSnapshot(
	data: Omit<ContextReviewSnapshot, 'actualCount' | 'images' | 'newMessagesAvailable' | 'transcripts'> & {
		images?: ReviewedImageItem[];
		transcripts?: ReviewedTranscriptItem[];
	},
): Readonly<ContextReviewSnapshot> {
	const captured = structuredClone({
		...data,
		actualCount: data.items.length,
		images: data.images ?? [],
		newMessagesAvailable: false,
		transcripts: data.transcripts ?? [],
	});
	freezePlainValue(captured);
	return captured;
}

export function restoreContextReviewSnapshot(
	data: Readonly<Omit<ContextReviewSnapshot, 'transcripts'> & {transcripts?: ReviewedTranscriptItem[]}>,
): Readonly<ContextReviewSnapshot> {
	const restored = structuredClone({...data, transcripts: data.transcripts ?? []});
	freezePlainValue(restored);
	return restored;
}

export function createUnlockedContextReview(
	data: Omit<ContextReviewSnapshot, 'actualCount' | 'images' | 'newMessagesAvailable' | 'transcripts'> & {
		images?: ReviewedImageItem[];
		transcripts?: ReviewedTranscriptItem[];
	},
): {locked: false; snapshot: Readonly<ContextReviewSnapshot>} {
	return {locked: false, snapshot: captureContextReviewSnapshot(data)};
}

export function updateContextReview(
	review: Readonly<ContextReviewSnapshot>,
	updates: Partial<Pick<ContextReviewSnapshot, 'images' | 'items' | 'newMessagesAvailable' | 'question' | 'transcripts'>>,
): Readonly<ContextReviewSnapshot> {
	const captured = structuredClone({
		...review,
		...updates,
	});
	freezePlainValue(captured);
	return captured;
}

export function removeContextReviewItem(
	review: Readonly<ContextReviewSnapshot>,
	itemId: string,
): Readonly<ContextReviewSnapshot> | undefined {
	if (!review.items.some(item => item.id === itemId)) {
		return undefined;
	}

	return updateContextReview(review, {
		items: review.items.filter(item => item.id !== itemId),
	});
}

export function editContextReviewItem(
	review: Readonly<ContextReviewSnapshot>,
	itemId: string,
	editedExcerpt: string,
): Readonly<ContextReviewSnapshot> | undefined {
	if (!review.items.some(item => item.id === itemId)) {
		return undefined;
	}

	return updateContextReview(review, {
		items: review.items.map(reviewed => reviewed.id === itemId
			? {editedExcerpt, id: reviewed.id, item: reviewed.item}
			: reviewed),
	});
}

export function buildReviewedPrompt(review: Readonly<ContextReviewSnapshot>): string {
	const transcriptsByContextItem = new Map(review.transcripts.map(transcript => [
		transcript.contextItemId,
		reviewedTranscriptExcerpt(transcript),
	]));
	const context = review.items
		.filter(({item}) => item.omittedReason === undefined)
		.map(({editedExcerpt, id, item}, index) => {
			const sender = item.sender.role === 'outgoing'
				? 'Derek'
				: (item.sender.displayName ?? 'Messenger participant');
			const transcript = transcriptsByContextItem.get(id);
			const excerpt = [editedExcerpt ?? contextItemExcerpt(item), transcript].filter(Boolean).join('\n');
			return `[${index + 1}] ${sender}${item.timestamp ? ` at ${item.timestamp}` : ''}\n${excerpt}`;
		})
		.join('\n\n');
	return `Question:\n${review.question}\n\nReviewed Messenger context:\n${context || '(No supported context items selected.)'}`;
}
