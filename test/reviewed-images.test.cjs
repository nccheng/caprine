const assert = require('node:assert/strict');
const test = require('node:test');
const {
	createReviewedImageItems,
	createFailedReviewedImage,
	createProcessedReviewedImage,
	defaultReviewedImageSelectionCount,
	finalizeReviewedImageSelection,
	maximumReviewedImageAggregateBytes,
	maximumReviewedImageCount,
	releaseReviewedImageHandles,
	retireReviewedImagesAfterUse,
	reviewedImageSelectionSummary,
	selectDefaultReviewedImages,
	updateReviewedImageSelection,
	withSelectedReviewedImageInputs,
} = require('../dist-js/reviewed-images.js');
const {OpenAiClient, OpenAiRequestError} = require('../dist-js/openai-client.js');

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

function selected(...items) {
	return items.map(item => ({...item, status: 'selected'}));
}

test('used reviewed images retire after a reusable video request', () => {
	const items = selected(processed(1), processed(2));
	const retired = retireReviewedImagesAfterUse(items);
	assert.deepEqual(retired.map(item => item.status), ['removed', 'removed']);
	assert.notEqual(retired[0], items[0]);
});

function handleStore(items, candidateSnapshot = snapshot) {
	const retained = new Map(items.map(item => [item.processedHandleId, {
		bytes: Uint8Array.from({length: item.byteLength}, (_, index) => (Number(item.processedHandleId.split('-').at(-1)) + index) % 256),
		description: {
			byteLength: item.byteLength,
			handleId: item.processedHandleId,
			height: item.height,
			messageId: item.messageId,
			mimeType: item.mimeType,
			snapshot: candidateSnapshot,
			status: 'processed',
			width: item.width,
		},
	}]));
	const released = [];
	return {
		describeHandle(handleId, messageId, requestedSnapshot) {
			const entry = retained.get(handleId);
			return entry
				&& entry.description.messageId === messageId
				&& entry.description.snapshot.conversationId === requestedSnapshot.conversationId
				&& entry.description.snapshot.captureGeneration === requestedSnapshot.captureGeneration
				? entry.description
				: undefined;
		},
		releaseHandle(handleId) {
			const entry = retained.get(handleId);
			if (!entry) {
				return false;
			}

			entry.bytes.fill(0);
			retained.delete(handleId);
			released.push(handleId);
			return true;
		},
		released,
		retained,
		async withProcessedImage(handleId, messageId, requestedSnapshot, callback) {
			const description = this.describeHandle(handleId, messageId, requestedSnapshot);
			const entry = retained.get(handleId);
			if (!description || !entry) {
				throw new TypeError('stale handle');
			}

			retained.delete(handleId);
			try {
				return await callback(entry.bytes, description);
			} finally {
				entry.bytes.fill(0);
				released.push(handleId);
			}
		},
	};
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

test('default aggregate budget is applied newest first', () => {
	const tenMegabytes = 10 * 1024 * 1024;
	const items = [processed(1), processed(2), processed(3)].map(item => ({
		...item,
		byteLength: tenMegabytes,
	}));
	const selected = selectDefaultReviewedImages(items);
	assert.deepEqual(selected.filter(item => item.status === 'selected').map(item => item.messageId), [
		'message-2',
		'message-3',
	]);
	assert.equal(selected[0].status, 'available');
});

test('production review pipeline captures normalizes and previews exact image bytes', async () => {
	const calls = [];
	const exactBytes = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
	const pipeline = {
		async capture(messageId, candidateSnapshot, signal) {
			calls.push(['capture', messageId, signal.aborted]);
			assert.deepEqual(candidateSnapshot, snapshot);
			return {
				byteLength: 16,
				handleId: `capture-${messageId}`,
				height: 2,
				messageId,
				snapshot,
				status: 'captured',
				width: 2,
			};
		},
		async normalize(captureHandleId, messageId) {
			calls.push(['normalize', captureHandleId, messageId]);
			return {
				byteLength: exactBytes.byteLength,
				handleId: `processed-${messageId}`,
				height: 2,
				messageId,
				mimeType: 'image/png',
				snapshot,
				status: 'processed',
				width: 2,
			};
		},
		releaseProcessed(handleId) {
			calls.push(['release', handleId]);
		},
		async withPreview(handleId, messageId, candidateSnapshot, callback) {
			calls.push(['preview', handleId, messageId]);
			return callback(exactBytes, {
				byteLength: exactBytes.byteLength,
				handleId,
				height: 2,
				messageId,
				mimeType: 'image/png',
				snapshot: candidateSnapshot,
				status: 'processed',
				width: 2,
			});
		},
	};
	const items = await createReviewedImageItems({
		anchorMessageId: 'message-2',
		contextItems: [
			{
				attachments: [{kind: 'image'}],
				confidence: 'high',
				messageId: 'message-1',
				sender: {role: 'outgoing'},
			},
			{
				attachments: [{kind: 'image'}],
				confidence: 'high',
				messageId: 'message-2',
				sender: {displayName: 'Alex', role: 'incoming'},
				text: 'Screenshot',
			},
		],
		idPrefix: 'context-capture-1',
		pipeline,
		signal: new AbortController().signal,
		snapshot,
	});
	assert.deepEqual(items.map(item => item.status), ['available', 'selected']);
	assert.equal(items[1].thumbnailDataUrl, 'data:image/png;base64,iVBORw0KGgo=');
	assert.equal(items[1].senderLabel, 'Received from Alex');
	assert.deepEqual(calls, [
		['capture', 'message-1', false],
		['normalize', 'capture-message-1', 'message-1'],
		['preview', 'processed-message-1', 'message-1'],
		['capture', 'message-2', false],
		['normalize', 'capture-message-2', 'message-2'],
		['preview', 'processed-message-2', 'message-2'],
	]);
});

test('production review pipeline reports capture and normalization failures without substitution', async () => {
	const items = await createReviewedImageItems({
		contextItems: [
			{
				attachments: [{kind: 'image'}],
				confidence: 'high',
				messageId: 'message-1',
				sender: {role: 'unknown'},
			},
			{
				attachments: [{kind: 'image'}],
				confidence: 'high',
				messageId: 'message-2',
				sender: {role: 'incoming'},
			},
		],
		idPrefix: 'context-capture-2',
		pipeline: {
			async capture(messageId) {
				return messageId === 'message-1'
					? {reason: 'hidden-target', status: 'unavailable'}
					: {
						byteLength: 16,
						handleId: 'capture-2',
						height: 2,
						messageId,
						snapshot,
						status: 'captured',
						width: 2,
					};
			},
			async normalize() {
				return {reason: 'normalization-failed', status: 'unavailable'};
			},
			releaseProcessed() {},
			async withPreview() {
				throw new Error('must not preview failed images');
			},
		},
		signal: new AbortController().signal,
		snapshot,
	});
	assert.deepEqual(items.map(item => item.status), ['capture-failed', 'normalization-failed']);
	assert.match(items[0].failureReason, /hidden-target/);
	assert.match(items[1].failureReason, /normalization-failed/);
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

test('provider handoff resolves selected handles in review order and clears bytes after success', async () => {
	const items = selected(processed(1, 4), processed(2, 3));
	const store = handleStore(items);
	let firstReference;
	let secondReference;
	const result = await withSelectedReviewedImageInputs({
		items,
		async run(images) {
			firstReference = images[0].bytes;
			secondReference = images[1].bytes;
			assert.deepEqual(images.map(image => ({
				bytes: [...image.bytes],
				label: image.label,
				mimeType: image.mimeType,
			})), [{
				bytes: [1, 2, 3, 4],
				label: 'Received from Alex',
				mimeType: 'image/png',
			}, {
				bytes: [2, 3, 4],
				label: 'Sent by you',
				mimeType: 'image/png',
			}]);
			return 'submitted';
		},
		snapshot,
		store,
	});
	assert.equal(result, 'submitted');
	assert.equal(firstReference.every(byte => byte === 0), true);
	assert.equal(secondReference.every(byte => byte === 0), true);
	assert.deepEqual(store.released, ['processed-image-2', 'processed-image-1']);
	assert.equal(store.retained.size, 0);
});

test('provider handoff keeps text-only fallback and clears acquired bytes on provider failure', async () => {
	const textOnlyStore = handleStore([]);
	assert.equal(await withSelectedReviewedImageInputs({
		items: [createFailedReviewedImage({
			failureReason: 'hidden',
			id: 'failed-image',
			messageContext: 'Image attachment',
			messageId: 'message-failed',
			senderLabel: 'Sender unknown',
			stage: 'capture',
		})],
		async run(images) {
			assert.deepEqual(images, []);
			return 'text-only';
		},
		snapshot,
		store: textOnlyStore,
	}), 'text-only');

	const items = selected(processed(3, 4));
	const store = handleStore(items);
	let byteReference;
	await assert.rejects(withSelectedReviewedImageInputs({
		items,
		async run(images) {
			byteReference = images[0].bytes;
			throw new Error('provider failed');
		},
		snapshot,
		store,
	}), /provider failed/);
	assert.equal(byteReference.every(byte => byte === 0), true);
	assert.deepEqual(store.released, ['processed-image-3']);
});

test('provider handoff clears exact image bytes after cancellation and timeout', async () => {
	const waitForAbort = async (_url, options) => new Promise((_resolve, reject) => {
		options.signal.addEventListener('abort', () => {
			reject(new DOMException('aborted', 'AbortError'));
		}, {once: true});
	});

	const cancellationItems = selected(processed(5, 4));
	const cancellationStore = handleStore(cancellationItems);
	const cancellation = new AbortController();
	const cancelled = withSelectedReviewedImageInputs({
		items: cancellationItems,
		async run(images) {
			return new OpenAiClient({fetchImplementation: waitForAbort}).createResponse(
				'sk-private',
				'Question',
				'off',
				{images, signal: cancellation.signal},
			);
		},
		snapshot,
		store: cancellationStore,
	});
	cancellation.abort();
	await assert.rejects(cancelled, error => error instanceof OpenAiRequestError && error.code === 'cancelled');
	assert.deepEqual(cancellationStore.released, ['processed-image-5']);

	const timeoutItems = selected(processed(6, 4));
	const timeoutStore = handleStore(timeoutItems);
	await assert.rejects(withSelectedReviewedImageInputs({
		items: timeoutItems,
		async run(images) {
			return new OpenAiClient({fetchImplementation: waitForAbort, timeoutMilliseconds: 5}).createResponse(
				'sk-private',
				'Question',
				'off',
				{images},
			);
		},
		snapshot,
		store: timeoutStore,
	}), error => error instanceof OpenAiRequestError && error.code === 'timeout');
	assert.deepEqual(timeoutStore.released, ['processed-image-6']);
});

test('provider handoff rejects duplicate released mismatched and wrong-conversation handles before submission', async () => {
	const first = processed(4, 4);
	const duplicateItems = selected(first, {...first, id: 'duplicate-review-image'});
	let submissions = 0;
	const run = async () => {
		submissions += 1;
	};

	const duplicateStore = handleStore([first]);

	await assert.rejects(withSelectedReviewedImageInputs({
		items: duplicateItems,
		run,
		snapshot,
		store: duplicateStore,
	}), error => error instanceof OpenAiRequestError && error.code === 'provider-unavailable');
	assert.equal(duplicateStore.retained.size, 0);

	const releasedStore = handleStore([first]);
	releasedStore.releaseHandle(first.processedHandleId);
	await assert.rejects(withSelectedReviewedImageInputs({
		items: selected(first),
		run,
		snapshot,
		store: releasedStore,
	}), error => error instanceof OpenAiRequestError && error.code === 'provider-unavailable');

	const mismatchedStore = handleStore([first]);
	mismatchedStore.retained.get(first.processedHandleId).description.width += 1;
	await assert.rejects(withSelectedReviewedImageInputs({
		items: selected(first),
		run,
		snapshot,
		store: mismatchedStore,
	}), error => error instanceof OpenAiRequestError && error.code === 'provider-unavailable');
	assert.equal(mismatchedStore.retained.size, 0);

	const wrongConversationStore = handleStore([first], {...snapshot, conversationId: 'messenger-thread:other'});
	await assert.rejects(withSelectedReviewedImageInputs({
		items: selected(first),
		run,
		snapshot,
		store: wrongConversationStore,
	}), error => error instanceof OpenAiRequestError && error.code === 'provider-unavailable');
	assert.equal(wrongConversationStore.retained.size, 0);
	assert.equal(submissions, 0);
});
