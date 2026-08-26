import {ProcessedMessengerImageDescription} from './messenger-image-normalization';

export const defaultReviewedImageSelectionCount = 3;
export const maximumReviewedImageCount = 4;
export const maximumReviewedImageAggregateBytes = 20 * 1024 * 1024;

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
	const candidates = new Set(candidateIndexes);
	return freezeItems(items.map((item, index) => {
		if (!candidates.has(index) || !isProcessed(item)) {
			return {...item};
		}

		if (
			selectedCount >= maximumReviewedImageCount
			|| aggregateBytes + item.byteLength > maximumReviewedImageAggregateBytes
		) {
			return {...item};
		}

		selectedCount += 1;
		aggregateBytes += item.byteLength;
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
