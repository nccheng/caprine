const assert = require('node:assert/strict');
const test = require('node:test');
const {
	createFailedReviewedImage,
	createProcessedReviewedImage,
	defaultReviewedImageSelectionCount,
	finalizeReviewedImageSelection,
	maximumReviewedImageAggregateBytes,
	maximumReviewedImageCount,
	releaseReviewedImageHandles,
	reviewedImageSelectionSummary,
	selectDefaultReviewedImages,
	updateReviewedImageSelection,
} = require('../dist-js/reviewed-images.js');

const snapshot = {
	captureGeneration: 1,
	conversationId: 'messenger-thread:123',
	messengerWebContentsId: 2,
	sessionId: 'ai-session-1',
};

function processed(index, byteLength = 12) {
	const bytes = Uint8Array.from({length: byteLength}, (_, byteIndex) => (index + byteIndex) % 256);
	return createProcessedReviewedImage({
		bytes,
		description: {
			byteLength,
			handleId: `processed-image-${index}`,
			height: 20 + index,
			messageId: `message-${index}`,
			mimeType: 'image/png',
			snapshot,
			status: 'processed',
			width: 30 + index,
		},
		id: `review-image-${index}`,
		messageContext: `Message ${index}`,
		messageId: `message-${index}`,
		senderLabel: index % 2 === 0 ? 'Sent by you' : 'Received from Alex',
	});
}

test('review items preserve exact processed bytes and reject mismatched descriptions', () => {
	const item = processed(1, 4);
	assert.equal(item.thumbnailDataUrl, 'data:image/png;base64,AQIDBA==');
	assert.equal(item.processedHandleId, 'processed-image-1');
	assert.equal(item.byteLength, 4);
	assert.equal(Object.isFrozen(item), true);
	assert.throws(() => createProcessedReviewedImage({
		bytes: Uint8Array.of(1),
		description: {
			byteLength: 2,
			handleId: 'processed-image-9',
			height: 1,
			messageId: 'message-9',
			mimeType: 'image/png',
			snapshot,
			status: 'processed',
			width: 1,
		},
		id: 'review-image-9',
		messageContext: 'Mismatch',
		messageId: 'message-9',
		senderLabel: 'Received',
	}), /mismatched processed Messenger image/);
});

test('anchor selects exactly its successful image and non-anchor review selects only newest bounded images', () => {
	const failure = createFailedReviewedImage({
		failureReason: 'target hidden',
		id: 'review-image-failed',
		messageContext: 'Failed message',
		messageId: 'message-failed',
		senderLabel: 'Received from Alex',
		stage: 'capture',
	});
	const items = [processed(1), processed(2), failure, processed(3), processed(4), processed(5)];
	const anchored = selectDefaultReviewedImages(items, 'message-2');
	assert.deepEqual(anchored.filter(item => item.status === 'selected').map(item => item.messageId), ['message-2']);
	const latest = selectDefaultReviewedImages(items);
	assert.equal(defaultReviewedImageSelectionCount, 3);
	assert.deepEqual(latest.filter(item => item.status === 'selected').map(item => item.messageId), [
		'message-3',
		'message-4',
		'message-5',
	]);
	assert.equal(latest.find(item => item.id === failure.id).status, 'capture-failed');
});

test('immutable item and handle identity reject stale duplicate and reordered actions', () => {
	const initial = selectDefaultReviewedImages([processed(1), processed(2)], 'message-1');
	const include = updateReviewedImageSelection(initial, {
		itemId: 'review-image-2',
		processedHandleId: 'processed-image-2',
		type: 'include',
	});
	assert.equal(include.accepted, true);
	assert.equal(include.items.find(item => item.id === 'review-image-2').status, 'selected');
	const duplicate = updateReviewedImageSelection(include.items, {
		itemId: 'review-image-2',
		processedHandleId: 'processed-image-2',
		type: 'include',
	});
	assert.equal(duplicate.accepted, false);
	assert.match(duplicate.notice, /already included/);
	const staleHandle = updateReviewedImageSelection([...include.items].reverse(), {
		itemId: 'review-image-2',
		processedHandleId: 'processed-image-99',
		type: 'remove',
	});
	assert.equal(staleHandle.accepted, false);
	assert.match(staleHandle.notice, /older review/);
	const removed = updateReviewedImageSelection(include.items, {
		itemId: 'review-image-1',
		processedHandleId: 'processed-image-1',
		type: 'remove',
	});
	assert.equal(removed.accepted, true);
	assert.equal(removed.releasedHandleId, 'processed-image-1');
	assert.equal(removed.items.find(item => item.id === 'review-image-1').status, 'removed');
	assert.equal(updateReviewedImageSelection(removed.items, {
		itemId: 'review-image-1',
		processedHandleId: 'processed-image-1',
		type: 'remove',
	}).accepted, false);
});

test('count and aggregate byte limits fail closed with clear local notices', () => {
	let items = Array.from({length: maximumReviewedImageCount + 1}, (_, index) => processed(index + 1));
	for (let index = 0; index < maximumReviewedImageCount; index += 1) {
		items = [...updateReviewedImageSelection(items, {
			itemId: `review-image-${index + 1}`,
			processedHandleId: `processed-image-${index + 1}`,
			type: 'include',
		}).items];
	}

	const overCount = updateReviewedImageSelection(items, {
		itemId: `review-image-${maximumReviewedImageCount + 1}`,
		processedHandleId: `processed-image-${maximumReviewedImageCount + 1}`,
		type: 'include',
	});
	assert.equal(overCount.accepted, false);
	assert.match(overCount.notice, new RegExp(`no more than ${maximumReviewedImageCount}`));

	const oversized = processed(20, maximumReviewedImageAggregateBytes);
	const byteLimitedItems = selectDefaultReviewedImages([processed(19), oversized], 'message-19');
	const overBytes = updateReviewedImageSelection(byteLimitedItems, {
		itemId: oversized.id,
		processedHandleId: oversized.processedHandleId,
		type: 'include',
	});
	assert.equal(overBytes.accepted, false);
	assert.match(overBytes.notice, /20 MB selection limit/);
	assert.deepEqual(reviewedImageSelectionSummary(overBytes.items), {
		aggregateBytes: 12,
		selectedCount: 1,
	});
});

test('finalizing and refreshing release the correct temporary handles once', () => {
	const selected = selectDefaultReviewedImages([processed(1), processed(2), processed(3), processed(4)], 'message-1');
	const finalized = finalizeReviewedImageSelection(selected);
	assert.deepEqual(finalized.releasedHandleIds, [
		'processed-image-2',
		'processed-image-3',
		'processed-image-4',
	]);
	assert.deepEqual(finalized.items.map(item => item.status), ['selected', 'removed', 'removed', 'removed']);
	const released = [];
	assert.deepEqual(releaseReviewedImageHandles(finalized.items, handleId => released.push(handleId), 'all'), [
		'processed-image-1',
	]);
	assert.deepEqual(released, ['processed-image-1']);
});
