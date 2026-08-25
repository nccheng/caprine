import {ConversationContextItem} from './messenger-context';
import {ConversationSnapshot} from './ai-assist-state';

export const contextWindowSizes = [10, 20, 50] as const;
export type ContextWindowSize = typeof contextWindowSizes[number];

export type ReviewedContextItem = {
	editedExcerpt?: string;
	item: ConversationContextItem;
};

export type ContextReviewSnapshot = {
	actualCount: number;
	contextVersion: string;
	items: ReviewedContextItem[];
	newMessagesAvailable: boolean;
	question: string;
	requestedCount: ContextWindowSize;
	snapshot: Readonly<ConversationSnapshot>;
};

export type ContextBackfillStopReason = 'complete' | 'conversation-changed' | 'no-more-history' | 'timeout';

type ContextBackfillOptions = {
	backfillOnce: () => Promise<'moved' | 'no-more-history'>;
	isComplete?: (items: readonly ConversationContextItem[]) => boolean;
	isConversationCurrent: () => boolean;
	maximumAttempts?: number;
	now?: () => number;
	readPage: () => readonly ConversationContextItem[];
	requestedCount: ContextWindowSize;
	restore: () => void;
	timeoutMilliseconds?: number;
};

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
	const olderMessageIds = new Set(olderPage.flatMap(item => item.messageId ? [item.messageId] : []));
	const latestByMessageId = new Map(newerItems.flatMap(item => item.messageId ? [[item.messageId, item] as const] : []));
	return [
		...olderPage.map(item => item.messageId ? (latestByMessageId.get(item.messageId) ?? item) : item),
		...newerItems.filter(item => !item.messageId || !olderMessageIds.has(item.messageId)),
	];
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
		: 'no-more-history';

	try {
		for (; !isComplete(items) && attempts < maximumAttempts; attempts += 1) {
			if (!options.isConversationCurrent()) {
				stopReason = 'conversation-changed';
				break;
			}

			if (now() - startedAt >= timeoutMilliseconds) {
				stopReason = 'timeout';
				break;
			}

			// eslint-disable-next-line no-await-in-loop
			const result = await options.backfillOnce();
			if (result === 'no-more-history') {
				stopReason = 'no-more-history';
				break;
			}

			items = mergeContextPages(options.readPage(), items);
			stopReason = isComplete(items) ? 'complete' : 'no-more-history';
		}

		if (!isComplete(items) && attempts >= maximumAttempts && stopReason === 'no-more-history') {
			stopReason = 'timeout';
		}
	} finally {
		options.restore();
	}

	return {items, stopReason};
}

export function contextVersion(items: readonly ConversationContextItem[]): string {
	const last = items.at(-1);
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
	data: Omit<ContextReviewSnapshot, 'actualCount' | 'newMessagesAvailable'>,
): Readonly<ContextReviewSnapshot> {
	const captured = structuredClone({
		...data,
		actualCount: data.items.length,
		newMessagesAvailable: false,
	});
	freezePlainValue(captured);
	return captured;
}

export function updateContextReview(
	review: Readonly<ContextReviewSnapshot>,
	updates: Partial<Pick<ContextReviewSnapshot, 'items' | 'newMessagesAvailable' | 'question'>>,
): Readonly<ContextReviewSnapshot> {
	const captured = structuredClone({
		...review,
		...updates,
	});
	freezePlainValue(captured);
	return captured;
}

export function buildReviewedPrompt(review: Readonly<ContextReviewSnapshot>): string {
	const context = review.items
		.filter(({item}) => item.omittedReason === undefined)
		.map(({editedExcerpt, item}, index) => {
			const sender = item.sender.role === 'outgoing'
				? 'Derek'
				: (item.sender.displayName ?? 'Messenger participant');
			const excerpt = editedExcerpt ?? contextItemExcerpt(item);
			return `[${index + 1}] ${sender}${item.timestamp ? ` at ${item.timestamp}` : ''}\n${excerpt}`;
		})
		.join('\n\n');
	return `Question:\n${review.question}\n\nReviewed Messenger context:\n${context || '(No supported context items selected.)'}`;
}
