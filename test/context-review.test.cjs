const assert = require('node:assert/strict');
const test = require('node:test');
const {
	buildReviewedPrompt,
	captureBoundedContext,
	captureContextReviewSnapshot,
	ContextCaptureCoordinator,
	contextReviewSubmissionDecision,
	contextVersion,
	createUnlockedContextReview,
	editContextReviewItem,
	isContextWindowComplete,
	mergeContextPages,
	removeContextReviewItem,
	restoredConversationScrollTop,
	selectContextWindow,
	updateContextReview,
} = require('../dist-js/context-review.js');

function messages(count) {
	return Array.from({length: count}, (_, index) => ({
		confidence: 'high',
		messageId: `message-${index + 1}`,
		sender: {role: index % 2 === 0 ? 'incoming' : 'outgoing'},
		text: `Message ${index + 1}`,
	}));
}

test('locked reviewed submissions publish the terminal notice without invoking a provider', () => {
	let providerCalls = 0;
	const decision = contextReviewSubmissionDecision(true);
	if (decision.allowed) {
		providerCalls += 1;
	}

	assert.equal(decision.allowed, false);
	assert.equal(decision.notice, 'This reviewed context has already been submitted. Refresh context before asking again.');
	assert.equal(providerCalls, 0);
	assert.deepEqual(contextReviewSubmissionDecision(false), {allowed: true});
});

test('refreshing context creates an unlocked review and preserves the previous question', () => {
	const previousQuestion = 'Keep this exact question';
	const review = createUnlockedContextReview({
		contextVersion: 'message:message-1',
		items: [{id: 'refresh:0', item: messages(1)[0]}],
		question: previousQuestion,
		requestedCount: 10,
		snapshot: {
			captureGeneration: 2,
			conversationId: 'messenger-thread:123',
			messengerWebContentsId: 3,
			sessionId: 'ai-session-1',
		},
	});

	assert.equal(review.locked, false);
	assert.equal(review.snapshot.question, previousQuestion);
});

test('latest and anchor-aware windows select deterministic 10/20/50 ranges', () => {
	const items = messages(60);
	assert.deepEqual(selectContextWindow(items, 10).map(item => item.messageId),
		messages(60).slice(-10).map(item => item.messageId));
	assert.deepEqual(selectContextWindow(items, 10, 'message-1').map(item => item.messageId),
		messages(10).map(item => item.messageId));
	assert.deepEqual(selectContextWindow(items, 10, 'message-60').map(item => item.messageId),
		messages(60).slice(-10).map(item => item.messageId));
	assert.equal(selectContextWindow(items, 20, 'missing').length, 0);
	assert.equal(selectContextWindow(items, 50).length, 50);
});

test('page merging reconciles only demonstrable contiguous overlap and preserves chronology', () => {
	const omission = {confidence: 'low', omittedReason: 'virtualized-placeholder', sender: {role: 'unknown'}};
	const anonymous = text => ({confidence: 'medium', sender: {role: 'incoming'}, text});
	assert.deepEqual(
		mergeContextPages([anonymous('Older'), anonymous('Overlap')], [anonymous('Overlap'), anonymous('Newer')])
			.map(item => item.text),
		['Older', 'Overlap', 'Newer'],
	);
	assert.deepEqual(
		mergeContextPages([anonymous('Again'), anonymous('Again')], [anonymous('Newer')])
			.map(item => item.text),
		['Again', 'Again', 'Newer'],
	);
	assert.equal(mergeContextPages([omission], [omission]).length, 2);
	const mixed = mergeContextPages(
		[messages(3)[0], anonymous('Anonymous overlap'), messages(3)[1]],
		[anonymous('Anonymous overlap'), messages(3)[1], messages(3)[2]],
	);
	assert.deepEqual(mixed.map(item => item.messageId ?? item.text), [
		'message-1',
		'Anonymous overlap',
		'message-2',
		'message-3',
	]);
});

test('anchor backfill continues until enough older messages can center the window', async () => {
	let page = messages(20).slice(10);
	let attempts = 0;
	const capture = await captureBoundedContext({
		async backfillOnce() {
			attempts += 1;
			page = messages(20).slice(Math.max(0, 10 - (attempts * 5)));
			return 'attempted';
		},
		isComplete: items => isContextWindowComplete(items, 10, 'message-11'),
		isConversationCurrent: () => true,
		readPage: () => page,
		requestedCount: 10,
		restore() {},
	});
	assert.equal(capture.stopReason, 'complete');
	assert.equal(attempts, 1);
	assert.deepEqual(selectContextWindow(capture.items, 10, 'message-11').map(item => item.messageId),
		messages(20).slice(6, 16).map(item => item.messageId));
});

test('newest anchor backfills a full 50-message window from the older side', async () => {
	const all = messages(75);
	let page = all.slice(-25);
	let attempts = 0;
	const capture = await captureBoundedContext({
		async backfillOnce() {
			attempts += 1;
			page = all.slice(-60);
			return 'attempted';
		},
		isComplete: items => isContextWindowComplete(items, 50, 'message-75'),
		isConversationCurrent: () => true,
		readPage: () => page,
		requestedCount: 50,
		restore() {},
	});
	const selected = selectContextWindow(capture.items, 50, 'message-75');
	assert.equal(capture.stopReason, 'complete');
	assert.equal(attempts, 1);
	assert.equal(selected.length, 50);
	assert.equal(selected.at(-1).messageId, 'message-75');
});

test('anchor completion backfills toward a centered window even when N loaded items can be selected', async () => {
	const all = messages(80);
	let page = all.slice(30);
	let attempts = 0;
	const capture = await captureBoundedContext({
		async backfillOnce() {
			attempts += 1;
			page = all;
			return 'attempted';
		},
		isComplete: items => isContextWindowComplete(items, 50, 'message-32'),
		isConversationCurrent: () => true,
		readPage: () => page,
		requestedCount: 50,
		restore() {},
	});
	assert.equal(selectContextWindow(all.slice(30), 50, 'message-32').length, 50);
	assert.equal(isContextWindowComplete(all.slice(30), 50, 'message-32'), false);
	assert.equal(capture.stopReason, 'complete');
	assert.equal(attempts, 1);
	assert.deepEqual(
		selectContextWindow(capture.items, 50, 'message-32').map(item => item.messageId),
		all.slice(7, 57).map(item => item.messageId),
	);
});

test('anchor windows fill from either boundary and remain partial only at a justified stop', async () => {
	const items = messages(60);
	assert.deepEqual(selectContextWindow(items, 10, 'message-1').map(item => item.messageId),
		items.slice(0, 10).map(item => item.messageId));
	assert.deepEqual(selectContextWindow(items, 10, 'message-60').map(item => item.messageId),
		items.slice(-10).map(item => item.messageId));
	assert.deepEqual(selectContextWindow(items.slice(0, 18), 10, 'message-17').map(item => item.messageId),
		items.slice(8, 18).map(item => item.messageId));
	let oldestAttempts = 0;
	const oldest = await captureBoundedContext({
		async backfillOnce() {
			oldestAttempts += 1;
			return 'no-more-history';
		},
		isComplete: page => isContextWindowComplete(page, 10, 'message-1'),
		isConversationCurrent: () => true,
		readPage: () => items,
		requestedCount: 10,
		restore() {},
	});
	assert.equal(oldest.stopReason, 'no-more-history');
	assert.equal(oldestAttempts, 1);
	assert.equal(selectContextWindow(oldest.items, 10, 'message-1').length, 10);

	const missingAnchor = await captureBoundedContext({
		backfillOnce: async () => 'no-more-history',
		isComplete: page => selectContextWindow(page, 10, 'missing').length === 10,
		isConversationCurrent: () => true,
		readPage: () => items.slice(-20),
		requestedCount: 10,
		restore() {},
	});
	assert.equal(missingAnchor.stopReason, 'no-more-history');
	assert.equal(selectContextWindow(missingAnchor.items, 10, 'missing').length, 0);
});

test('bounded backfill reports partial history and always restores scroll state', async () => {
	let page = messages(10).slice(5);
	let restored = false;
	let attempts = 0;
	const result = await captureBoundedContext({
		async backfillOnce() {
			attempts += 1;
			if (attempts === 1) {
				page = messages(10).slice(0, 8);
				return 'attempted';
			}

			return 'no-more-history';
		},
		isConversationCurrent: () => true,
		readPage: () => page,
		requestedCount: 20,
		restore() {
			restored = true;
		},
	});
	assert.equal(result.items.length, 10);
	assert.equal(result.stopReason, 'no-more-history');
	assert.equal(restored, true);
	assert.equal(restoredConversationScrollTop(400, 2000, 2600), 1000);
});

test('a backfill attempt can load new rows without observable scroll motion', async () => {
	let page = messages(4);
	const result = await captureBoundedContext({
		async backfillOnce() {
			page = messages(10);
			return 'attempted';
		},
		isConversationCurrent: () => true,
		readPage: () => page,
		requestedCount: 10,
		restore() {},
	});
	assert.equal(result.stopReason, 'complete');
	assert.equal(result.items.length, 10);
});

test('the completed wait is read before explicit no-more-history and completion wins', async () => {
	let page = messages(4);
	const complete = await captureBoundedContext({
		async backfillOnce() {
			page = messages(10);
			return 'no-more-history';
		},
		isConversationCurrent: () => true,
		readPage: () => page,
		requestedCount: 10,
		restore() {},
	});
	assert.equal(complete.stopReason, 'complete');
	assert.equal(complete.items.at(-1).messageId, 'message-10');

	page = messages(4);
	const partial = await captureBoundedContext({
		async backfillOnce() {
			page = messages(6);
			return 'no-more-history';
		},
		isConversationCurrent: () => true,
		readPage: () => page,
		requestedCount: 10,
		restore() {},
	});
	assert.equal(partial.stopReason, 'no-more-history');
	assert.equal(partial.items.at(-1).messageId, 'message-6');
});

test('repeated attempted backfills with no progress exhaust the attempt bound as timeout', async () => {
	let attempts = 0;
	const result = await captureBoundedContext({
		async backfillOnce() {
			attempts += 1;
			return 'attempted';
		},
		isConversationCurrent: () => true,
		maximumAttempts: 3,
		readPage: () => messages(1),
		requestedCount: 10,
		restore() {},
	});
	assert.equal(attempts, 3);
	assert.equal(result.stopReason, 'timeout');
});

test('abort and conversation change after a completed wait stop before merging its page', async () => {
	const abortController = new AbortController();
	let abortPage = messages(1);
	let abortReads = 0;
	const cancelled = await captureBoundedContext({
		async backfillOnce() {
			abortPage = messages(10);
			abortController.abort();
			return 'attempted';
		},
		isConversationCurrent: () => true,
		readPage() {
			abortReads += 1;
			return abortPage;
		},
		requestedCount: 10,
		restore() {},
		signal: abortController.signal,
	});
	assert.equal(cancelled.stopReason, 'cancelled');
	assert.equal(cancelled.items.length, 1);
	assert.equal(abortReads, 1);

	let current = true;
	let changedPage = messages(1);
	let changedReads = 0;
	const changed = await captureBoundedContext({
		async backfillOnce() {
			changedPage = messages(10);
			current = false;
			return 'attempted';
		},
		isConversationCurrent: () => current,
		readPage() {
			changedReads += 1;
			return changedPage;
		},
		requestedCount: 10,
		restore() {},
	});
	assert.equal(changed.stopReason, 'conversation-changed');
	assert.equal(changed.items.length, 1);
	assert.equal(changedReads, 1);
});

test('complete no-more timeout cancel and conversation-change paths restore exactly once', async () => {
	await Promise.all(['complete', 'no-more-history', 'timeout', 'cancelled', 'conversation-changed'].map(async scenario => {
		let current = true;
		let restored = 0;
		const abortController = new AbortController();
		const result = await captureBoundedContext({
			async backfillOnce() {
				if (scenario === 'cancelled') {
					abortController.abort();
				}

				if (scenario === 'conversation-changed') {
					current = false;
				}

				return scenario === 'no-more-history' ? 'no-more-history' : 'attempted';
			},
			isConversationCurrent: () => current,
			maximumAttempts: 1,
			readPage: () => messages(scenario === 'complete' ? 10 : 1),
			requestedCount: 10,
			restore() {
				restored += 1;
			},
			signal: abortController.signal,
		});
		assert.equal(result.stopReason, scenario);
		assert.equal(restored, 1);
	}));
});

test('bounded backfill stops on timeout and conversation changes', async () => {
	let now = 0;
	let restored = 0;
	const timedOut = await captureBoundedContext({
		backfillOnce: async () => 'attempted',
		isConversationCurrent: () => true,
		now() {
			now += 1000;
			return now;
		},
		readPage: () => messages(1),
		requestedCount: 10,
		restore() {
			restored += 1;
		},
		timeoutMilliseconds: 500,
	});
	assert.equal(timedOut.stopReason, 'timeout');
	const changed = await captureBoundedContext({
		backfillOnce: async () => 'attempted',
		isConversationCurrent: () => false,
		readPage: () => messages(1),
		requestedCount: 10,
		restore() {
			restored += 1;
		},
	});
	assert.equal(changed.stopReason, 'conversation-changed');
	assert.equal(restored, 2);
});

test('rapid 10 to 20 to 50 capture changes restore before the latest capture starts', async () => {
	const events = [];
	let finishRestore;
	const restoreGate = new Promise(resolve => {
		finishRestore = resolve;
	});
	const coordinator = new ContextCaptureCoordinator();
	const run = requestId => async signal => {
		events.push(`start:${requestId}`);
		if (requestId === 'context-capture-1') {
			await new Promise(resolve => {
				signal.addEventListener('abort', resolve, {once: true});
			});
			events.push('restore:start');
			await restoreGate;
			events.push('restore:end');
		}

		events.push(`finish:${requestId}`);
	};

	coordinator.enqueue('context-capture-1', run('context-capture-1'));
	await new Promise(resolve => {
		setImmediate(resolve);
	});
	coordinator.enqueue('context-capture-2', run('context-capture-2'));
	coordinator.enqueue('context-capture-3', run('context-capture-3'));
	await new Promise(resolve => {
		setImmediate(resolve);
	});
	assert.deepEqual(events, ['start:context-capture-1', 'restore:start']);
	finishRestore();
	await coordinator.waitForIdle();
	assert.deepEqual(events, [
		'start:context-capture-1',
		'restore:start',
		'restore:end',
		'finish:context-capture-1',
		'start:context-capture-3',
		'finish:context-capture-3',
	]);
});

test('cancelled backfill stops and restores exactly once', async () => {
	const abortController = new AbortController();
	let restored = 0;
	const result = await captureBoundedContext({
		async backfillOnce() {
			abortController.abort();
			return 'attempted';
		},
		isConversationCurrent: () => true,
		readPage: () => messages(1),
		requestedCount: 10,
		restore() {
			restored += 1;
		},
		signal: abortController.signal,
	});
	assert.equal(result.stopReason, 'cancelled');
	assert.equal(restored, 1);
});

test('tail context versions are stable and change only with tail evidence', () => {
	const first = messages(2)[1];
	assert.equal(contextVersion(first), contextVersion(structuredClone(first)));
	assert.notEqual(contextVersion(first), contextVersion({...first, messageId: 'message-3'}));
	const anonymous = {...first};
	delete anonymous.messageId;
	assert.notEqual(contextVersion(anonymous), contextVersion({...anonymous, text: 'Changed tail'}));
	assert.notEqual(contextVersion(undefined), contextVersion(first));
});

test('review snapshots freeze context and expose edits without reviving raw changes', () => {
	const source = messages(2);
	const review = captureContextReviewSnapshot({
		contextVersion: '2:message-2',
		images: [{
			byteLength: 4,
			height: 1,
			id: 'review-image-1',
			messageContext: 'Message 1 image',
			messageId: 'message-1',
			mimeType: 'image/png',
			processedHandleId: 'processed-image-1',
			senderLabel: 'Received',
			status: 'available',
			thumbnailDataUrl: 'data:image/png;base64,AQIDBA==',
			width: 1,
		}],
		items: source.map((item, index) => ({id: `item-${index}`, item})),
		question: 'What happened?',
		requestedCount: 10,
		snapshot: {
			captureGeneration: 1,
			conversationId: 'messenger-thread:123',
			messengerWebContentsId: 2,
			sessionId: 'ai-session-1',
		},
	});
	source[0].text = 'Changed later';
	assert.equal(review.items[0].item.text, 'Message 1');
	assert.equal(Object.isFrozen(review.items[0].item), true);
	const edited = updateContextReview(review, {
		items: [{editedExcerpt: 'Redacted excerpt', id: review.items[0].id, item: review.items[0].item}],
		newMessagesAvailable: true,
	});
	assert.equal(edited.newMessagesAvailable, true);
	assert.match(buildReviewedPrompt(edited), /Redacted excerpt/);
	assert.doesNotMatch(buildReviewedPrompt(edited), /Message 1/);
	const imageUpdated = updateContextReview(edited, {
		images: [{...edited.images[0], status: 'selected'}],
	});
	assert.equal(imageUpdated.items[0].editedExcerpt, 'Redacted excerpt');
	assert.equal(imageUpdated.images[0].status, 'selected');
	assert.equal(imageUpdated.images[0].thumbnailDataUrl, 'data:image/png;base64,AQIDBA==');
});

test('review mutations target immutable item IDs across removals and reject stale IDs', () => {
	const review = captureContextReviewSnapshot({
		contextVersion: '2:message-2',
		items: messages(2).map((item, index) => ({id: `item-${index + 1}`, item})),
		question: 'What happened?',
		requestedCount: 10,
		transcripts: [{
			contextItemId: 'item-1',
			id: 'transcript:item-1',
			messageId: 'message-1',
			senderLabel: 'Voice message received from Alex',
			status: 'ready',
		}, {
			contextItemId: 'item-2',
			id: 'transcript:item-2',
			messageId: 'message-2',
			senderLabel: 'Voice message received from Alex',
			status: 'ready',
		}],
		snapshot: {
			captureGeneration: 1,
			conversationId: 'messenger-thread:123',
			messengerWebContentsId: 2,
			sessionId: 'ai-session-1',
		},
	});
	const afterRemoval = removeContextReviewItem(review, 'item-1');
	assert.ok(afterRemoval);
	const afterEdit = editContextReviewItem(afterRemoval, 'item-2', 'Redacted second message');
	assert.ok(afterEdit);
	assert.deepEqual(afterEdit.items.map(item => item.id), ['item-2']);
	assert.deepEqual(afterEdit.transcripts.map(item => item.id), ['transcript:item-2']);
	assert.equal(afterEdit.items[0].editedExcerpt, 'Redacted second message');
	assert.equal(removeContextReviewItem(afterEdit, 'item-1'), undefined);
	assert.equal(editContextReviewItem(afterEdit, 'item-1', 'Wrong target'), undefined);
});

test('reviewed prompts include only frozen selected sendable items', () => {
	const supported = messages(1)[0];
	const omitted = {
		confidence: 'low',
		omittedReason: 'unsupported-message',
		sender: {role: 'unknown'},
	};
	const review = captureContextReviewSnapshot({
		contextVersion: 'message:message-1',
		items: [
			{editedExcerpt: 'Only this reviewed excerpt', id: 'item-1', item: supported},
			{id: 'item-2', item: omitted},
		],
		question: 'Use reviewed context?',
		requestedCount: 10,
		snapshot: {
			captureGeneration: 1,
			conversationId: 'messenger-thread:123',
			messengerWebContentsId: 2,
			sessionId: 'ai-session-1',
		},
	});
	const prompt = buildReviewedPrompt(review);
	assert.match(prompt, /Only this reviewed excerpt/);
	assert.doesNotMatch(prompt, /unsupported-message/);
	assert.doesNotMatch(prompt, /Message 1/);
});

test('reviewed prompts include only completed selected transcript snapshots', () => {
	const review = captureContextReviewSnapshot({
		contextVersion: 'message:message-1',
		items: [{id: 'item-1', item: {...messages(1)[0], attachments: [{kind: 'audio'}]}}],
		question: 'Summarize the voice message',
		requestedCount: 10,
		snapshot: {
			captureGeneration: 1,
			conversationId: 'messenger-thread:123',
			messengerWebContentsId: 2,
			sessionId: 'ai-session-1',
		},
		transcripts: [{
			byteLength: 42,
			contextItemId: 'item-1',
			durationSeconds: 1,
			id: 'transcript:item-1',
			messageId: 'message-1',
			mimeType: 'audio/ogg',
			originalSegments: [{endSeconds: 1, startSeconds: 0, text: 'Private reviewed words'}],
			senderLabel: 'Voice message received from Alex',
			status: 'completed',
		}],
	});
	assert.match(buildReviewedPrompt(review), /Original transcript:/);
	assert.match(buildReviewedPrompt(review), /Private reviewed words/);
	const removed = updateContextReview(review, {
		transcripts: [{...review.transcripts[0], originalSegments: undefined, status: 'removed'}],
	});
	assert.doesNotMatch(buildReviewedPrompt(removed), /Private reviewed words/);
});
