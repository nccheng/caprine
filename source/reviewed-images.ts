import {ConversationSnapshot} from './ai-assist-state';
import {
	MessengerImageCaptureResult,
} from './messenger-image-capture';
import {
	maximumProcessedMessengerImageBytes,
	MessengerImageNormalizationResult,
	ProcessedMessengerImageDescription,
} from './messenger-image-normalization';
import {
	OpenAiImageInput,
	openAiImageAggregateByteLimit,
	openAiImageCountLimit,
	OpenAiRequestError,
} from './openai-client';
import {ConversationContextItem} from './messenger-context';

export const defaultReviewedImageSelectionCount = 3;
export const maximumReviewedImageCount = openAiImageCountLimit;
export const maximumReviewedImageAggregateBytes = openAiImageAggregateByteLimit;
export const maximumReviewedImageCandidates = 10;

export type ReviewedImageFailureStage = 'capture' | 'normalization';
export type ReviewedImageStatus =
	| 'available'
	| 'capture-failed'
	| 'normalization-failed'
	| 'removed'
	| 'selected';

type ReviewedImageSource = {
	id: string;
	messageContext: string;
	messageId: string;
	senderLabel: string;
};

export type ReviewedImageItem = ReviewedImageSource & ({
	byteLength: number;
	height: number;
	mimeType: 'image/png';
	processedHandleId: string;
	status: 'available' | 'removed' | 'selected';
	thumbnailDataUrl: string;
	width: number;
} | {
	failureReason: string;
	status: 'capture-failed' | 'normalization-failed';
});

type ProcessedReviewedImage = ReviewedImageSource & {
	byteLength: number;
	height: number;
	mimeType: 'image/png';
	processedHandleId: string;
	status: 'available' | 'removed' | 'selected';
	thumbnailDataUrl: string;
	width: number;
};

export type ReviewedImageSelectionSummary = {
	aggregateBytes: number;
	blockingNotice?: string;
	selectedCount: number;
};

export type ReviewedImageSelectionUpdate = {
	accepted: boolean;
	items: ReadonlyArray<Readonly<ReviewedImageItem>>;
	notice?: string;
	releasedHandleId?: string;
};

type ProcessedImageInput = ReviewedImageSource & {
	bytes: Uint8Array;
	description: Readonly<ProcessedMessengerImageDescription>;
};

export type ReviewedImagePipeline = {
	capture: (
		messageId: string,
		snapshot: Readonly<ConversationSnapshot>,
		signal: AbortSignal,
	) => Promise<MessengerImageCaptureResult>;
	normalize: (
		captureHandleId: string,
		messageId: string,
		snapshot: Readonly<ConversationSnapshot>,
		signal: AbortSignal,
	) => Promise<MessengerImageNormalizationResult>;
	releaseProcessed: (handleId: string) => void;
	withPreview: <T>(
		handleId: string,
		messageId: string,
		snapshot: Readonly<ConversationSnapshot>,
		callback: (bytes: Uint8Array, description: ProcessedMessengerImageDescription) => Promise<T> | T,
	) => Promise<T>;
};

type ReviewedImageHandleStore = {
	describeHandle: (
		handleId: string,
		messageId: string,
		snapshot: Readonly<ConversationSnapshot>,
	) => ProcessedMessengerImageDescription | undefined;
	releaseHandle: (handleId: string) => boolean;
	withProcessedImage: <T>(
		handleId: string,
		messageId: string,
		snapshot: Readonly<ConversationSnapshot>,
		callback: (bytes: Uint8Array, description: ProcessedMessengerImageDescription) => Promise<T>,
	) => Promise<T>;
};

function isMatchingProcessedImage(
	item: Readonly<ProcessedReviewedImage>,
	description: Readonly<ProcessedMessengerImageDescription> | undefined,
): description is Readonly<ProcessedMessengerImageDescription> {
	return description !== undefined
		&& description.status === 'processed'
		&& description.handleId === item.processedHandleId
		&& description.messageId === item.messageId
		&& description.mimeType === item.mimeType
		&& description.byteLength === item.byteLength
		&& description.width === item.width
		&& description.height === item.height;
}

export async function withSelectedReviewedImageInputs<T>(input: Readonly<{
	items: ReadonlyArray<Readonly<ReviewedImageItem>>;
	run: (images: ReadonlyArray<Readonly<OpenAiImageInput>>) => Promise<T>;
	snapshot: Readonly<ConversationSnapshot>;
	store: ReviewedImageHandleStore;
}>): Promise<T> {
	const selected = selectedItems(input.items);
	const handles = new Set(selected.map(item => item.processedHandleId));
	try {
		const summary = reviewedImageSelectionSummary(input.items);
		if (summary.blockingNotice) {
			throw new OpenAiRequestError('input-too-large', summary.blockingNotice);
		}

		if (handles.size !== selected.length) {
			throw new OpenAiRequestError(
				'provider-unavailable',
				'A selected image is no longer available for this conversation. Refresh context before asking again.',
			);
		}

		for (const item of selected) {
			if (
				item.byteLength > maximumProcessedMessengerImageBytes
				|| !isMatchingProcessedImage(
					item,
					input.store.describeHandle(item.processedHandleId, item.messageId, input.snapshot),
				)
			) {
				throw new OpenAiRequestError(
					'provider-unavailable',
					'A selected image is no longer available for this conversation. Refresh context before asking again.',
				);
			}
		}

		const providerImages: OpenAiImageInput[] = [];
		const consume = async (index: number): Promise<T> => {
			if (index === selected.length) {
				return input.run(Object.freeze([...providerImages]));
			}

			const item = selected[index];
			return input.store.withProcessedImage(
				item.processedHandleId,
				item.messageId,
				input.snapshot,
				async (bytes, description) => {
					if (
						!isMatchingProcessedImage(item, description)
						|| bytes.byteLength !== item.byteLength
						|| bytes.byteLength > maximumProcessedMessengerImageBytes
					) {
						throw new OpenAiRequestError(
							'provider-unavailable',
							'A selected image is no longer available for this conversation. Refresh context before asking again.',
						);
					}

					providerImages.push({
						bytes,
						label: item.senderLabel,
						mimeType: item.mimeType,
					});
					try {
						return await consume(index + 1);
					} finally {
						providerImages.pop();
					}
				},
			);
		};

		return await consume(0);
	} finally {
		for (const handleId of handles) {
			input.store.releaseHandle(handleId);
		}
	}
}

function reviewedImageSource(item: Readonly<ConversationContextItem>, id: string): ReviewedImageSource {
	const senderLabel = item.sender.role === 'outgoing'
		? 'Sent by you'
		: (item.sender.displayName ? `Received from ${item.sender.displayName}` : 'Sender unknown');
	return {
		id,
		messageContext: item.text ?? item.reply?.text ?? 'Image attachment',
		messageId: item.messageId ?? `unidentified-image-${id}`,
		senderLabel,
	};
}

export async function createReviewedImageItems(input: Readonly<{
	anchorMessageId?: string;
	contextItems: ReadonlyArray<Readonly<ConversationContextItem>>;
	idPrefix: string;
	pipeline: ReviewedImagePipeline;
	signal: AbortSignal;
	snapshot: Readonly<ConversationSnapshot>;
}>): Promise<ReadonlyArray<Readonly<ReviewedImageItem>>> {
	const imageIndexes = input.contextItems
		.map((item, index) => item.attachments?.some(attachment => attachment.kind === 'image') ? index : -1)
		.filter(index => index >= 0);
	const candidateIndexes = new Set(imageIndexes.slice(-maximumReviewedImageCandidates));
	if (input.anchorMessageId) {
		const anchorIndex = input.contextItems.findIndex(item => item.messageId === input.anchorMessageId
			&& item.attachments?.some(attachment => attachment.kind === 'image'));
		if (anchorIndex >= 0) {
			candidateIndexes.add(anchorIndex);
			if (candidateIndexes.size > maximumReviewedImageCandidates) {
				const oldestNonAnchor = [...candidateIndexes].find(index => index !== anchorIndex);
				if (oldestNonAnchor !== undefined) {
					candidateIndexes.delete(oldestNonAnchor);
				}
			}
		}
	}

	const reviewed: Array<Readonly<ReviewedImageItem>> = [];
	for (const index of [...candidateIndexes].sort((left, right) => left - right)) {
		if (input.signal.aborted) {
			break;
		}

		const contextItem = input.contextItems[index];
		const source = reviewedImageSource(contextItem, `${input.idPrefix}:image:${index}`);
		if (!contextItem.messageId) {
			reviewed.push(createFailedReviewedImage({
				...source,
				failureReason: 'Stable Messenger message identity is unavailable.',
				stage: 'capture',
			}));
			continue;
		}

		// Sequential capture bounds native image memory and preserves deterministic review order.
		// eslint-disable-next-line no-await-in-loop
		const captured = await input.pipeline.capture(contextItem.messageId, input.snapshot, input.signal);
		if (captured.status === 'unavailable') {
			reviewed.push(createFailedReviewedImage({
				...source,
				failureReason: `Image capture unavailable: ${captured.reason}.`,
				stage: 'capture',
			}));
			continue;
		}

		// eslint-disable-next-line no-await-in-loop
		const normalized = await input.pipeline.normalize(
			captured.handleId,
			contextItem.messageId,
			input.snapshot,
			input.signal,
		);
		if (normalized.status === 'unavailable') {
			reviewed.push(createFailedReviewedImage({
				...source,
				failureReason: `Image normalization unavailable: ${normalized.reason}.`,
				stage: 'normalization',
			}));
			continue;
		}

		try {
			// eslint-disable-next-line no-await-in-loop
			const item = await input.pipeline.withPreview(
				normalized.handleId,
				contextItem.messageId,
				input.snapshot,
				async (bytes, description) => createProcessedReviewedImage({
					...source,
					bytes,
					description,
				}),
			);
			reviewed.push(item);
		} catch {
			input.pipeline.releaseProcessed(normalized.handleId);
			reviewed.push(createFailedReviewedImage({
				...source,
				failureReason: 'Processed image preview is unavailable.',
				stage: 'normalization',
			}));
		}
	}

	return selectDefaultReviewedImages(reviewed, input.anchorMessageId);
}

function freezeItems(items: readonly ReviewedImageItem[]): ReadonlyArray<Readonly<ReviewedImageItem>> {
	return Object.freeze(items.map(item => Object.freeze({...item})));
}

function isProcessed(item: Readonly<ReviewedImageItem>): item is Readonly<ProcessedReviewedImage> {
	return ['available', 'removed', 'selected'].includes(item.status);
}

function selectedItems(items: ReadonlyArray<Readonly<ReviewedImageItem>>): Array<Readonly<ProcessedReviewedImage>> {
	return items.filter((item): item is Readonly<ProcessedReviewedImage> => isProcessed(item) && item.status === 'selected');
}

export function createProcessedReviewedImage(input: Readonly<ProcessedImageInput>): Readonly<ReviewedImageItem> {
	const {bytes, description} = input;
	if (
		description.status !== 'processed'
		|| description.mimeType !== 'image/png'
		|| description.messageId !== input.messageId
		|| description.byteLength !== bytes.byteLength
		|| bytes.byteLength === 0
		|| description.width <= 0
		|| description.height <= 0
	) {
		throw new TypeError('Rejected mismatched processed Messenger image');
	}

	return Object.freeze({
		byteLength: description.byteLength,
		height: description.height,
		id: input.id,
		messageContext: input.messageContext,
		messageId: input.messageId,
		mimeType: description.mimeType,
		processedHandleId: description.handleId,
		senderLabel: input.senderLabel,
		status: 'available',
		thumbnailDataUrl: `data:${description.mimeType};base64,${Buffer.from(bytes).toString('base64')}`,
		width: description.width,
	});
}

export function createFailedReviewedImage(input: ReviewedImageSource & {
	failureReason: string;
	stage: ReviewedImageFailureStage;
}): Readonly<ReviewedImageItem> {
	return Object.freeze({
		failureReason: input.failureReason,
		id: input.id,
		messageContext: input.messageContext,
		messageId: input.messageId,
		senderLabel: input.senderLabel,
		status: input.stage === 'capture' ? 'capture-failed' : 'normalization-failed',
	});
}

export function reviewedImageSelectionSummary(
	items: ReadonlyArray<Readonly<ReviewedImageItem>>,
): ReviewedImageSelectionSummary {
	const selected = selectedItems(items);
	const aggregateBytes = selected.reduce((total, item) => total + item.byteLength, 0);
	let blockingNotice: string | undefined;
	if (selected.length > maximumReviewedImageCount) {
		blockingNotice = `Select no more than ${maximumReviewedImageCount} images before Ask.`;
	} else if (aggregateBytes > maximumReviewedImageAggregateBytes) {
		blockingNotice = `Selected images exceed the ${maximumReviewedImageAggregateBytes / (1024 * 1024)} MB limit. Remove an image before Ask.`;
	}

	return {
		aggregateBytes,
		...(blockingNotice ? {blockingNotice} : {}),
		selectedCount: selected.length,
	};
}

export function selectDefaultReviewedImages(
	items: ReadonlyArray<Readonly<ReviewedImageItem>>,
	anchorMessageId?: string,
): ReadonlyArray<Readonly<ReviewedImageItem>> {
	const candidateIndexes: number[] = [];
	if (anchorMessageId) {
		const anchorIndex = items.findIndex(item => isProcessed(item)
			&& item.status === 'available'
			&& item.messageId === anchorMessageId);
		if (anchorIndex >= 0) {
			candidateIndexes.push(anchorIndex);
		}
	} else {
		for (let index = items.length - 1; index >= 0 && candidateIndexes.length < defaultReviewedImageSelectionCount; index -= 1) {
			const item = items[index];
			if (isProcessed(item) && item.status === 'available') {
				candidateIndexes.push(index);
			}
		}
	}

	let selectedCount = 0;
	let aggregateBytes = 0;
	const selectedIndexes = new Set<number>();
	for (const index of candidateIndexes) {
		const item = items[index];
		if (
			!isProcessed(item)
			|| selectedCount >= maximumReviewedImageCount
			|| aggregateBytes + item.byteLength > maximumReviewedImageAggregateBytes
		) {
			continue;
		}

		selectedIndexes.add(index);
		selectedCount += 1;
		aggregateBytes += item.byteLength;
	}

	return freezeItems(items.map((item, index) => {
		if (!selectedIndexes.has(index) || !isProcessed(item)) {
			return {...item};
		}

		return {...item, status: 'selected'};
	}));
}

export function updateReviewedImageSelection(
	items: ReadonlyArray<Readonly<ReviewedImageItem>>,
	action: Readonly<{
		itemId: string;
		processedHandleId: string;
		type: 'include' | 'remove';
	}>,
): ReviewedImageSelectionUpdate {
	const index = items.findIndex(item => isProcessed(item)
		&& item.id === action.itemId
		&& item.processedHandleId === action.processedHandleId);
	if (index < 0) {
		return {accepted: false, items, notice: 'That image belongs to an older review. Refresh context and try again.'};
	}

	const item = items[index];
	if (!isProcessed(item)) {
		return {accepted: false, items};
	}

	if (action.type === 'remove') {
		if (item.status !== 'selected' && item.status !== 'available') {
			return {accepted: false, items, notice: 'That image has already been removed.'};
		}

		const updated = items.map((candidate, candidateIndex) => candidateIndex === index
			? {...item, status: 'removed' as const}
			: {...candidate});
		return {
			accepted: true,
			items: freezeItems(updated),
			releasedHandleId: item.processedHandleId,
		};
	}

	if (item.status !== 'available') {
		return {
			accepted: false,
			items,
			notice: item.status === 'selected'
				? 'That image is already included.'
				: 'Removed images cannot be included. Refresh context to capture them again.',
		};
	}

	const summary = reviewedImageSelectionSummary(items);
	if (summary.selectedCount + 1 > maximumReviewedImageCount) {
		return {
			accepted: false,
			items,
			notice: `Select no more than ${maximumReviewedImageCount} images before Ask.`,
		};
	}

	if (summary.aggregateBytes + item.byteLength > maximumReviewedImageAggregateBytes) {
		return {
			accepted: false,
			items,
			notice: `This image would exceed the ${maximumReviewedImageAggregateBytes / (1024 * 1024)} MB selection limit.`,
		};
	}

	return {
		accepted: true,
		items: freezeItems(items.map((candidate, candidateIndex) => candidateIndex === index
			? {...item, status: 'selected' as const}
			: {...candidate})),
	};
}

export function releaseReviewedImageHandles(
	items: ReadonlyArray<Readonly<ReviewedImageItem>>,
	releaseHandle: (handleId: string) => void,
	mode: 'all' | 'unselected',
): string[] {
	const released: string[] = [];
	const seen = new Set<string>();
	for (const item of items) {
		if (
			!isProcessed(item)
			|| item.status === 'removed'
			|| (mode === 'unselected' && item.status === 'selected')
			|| seen.has(item.processedHandleId)
		) {
			continue;
		}

		seen.add(item.processedHandleId);
		releaseHandle(item.processedHandleId);
		released.push(item.processedHandleId);
	}

	return released;
}

export function finalizeReviewedImageSelection(
	items: ReadonlyArray<Readonly<ReviewedImageItem>>,
): {items: ReadonlyArray<Readonly<ReviewedImageItem>>; releasedHandleIds: string[]} {
	const releasedHandleIds: string[] = [];
	return {
		items: freezeItems(items.map(item => {
			if (isProcessed(item) && item.status === 'available') {
				releasedHandleIds.push(item.processedHandleId);
				return {...item, status: 'removed'};
			}

			return {...item};
		})),
		releasedHandleIds,
	};
}
