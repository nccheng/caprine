const assert = require('node:assert/strict');
const test = require('node:test');
const {
	buildReviewedPrompt,
	captureBoundedContext,
	captureContextReviewSnapshot,
	mergeContextPages,
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

test('backfill merging preserves repeated anonymous omissions while removing page overlap', () => {
	const omission = {confidence: 'low', omittedReason: 'virtualized-placeholder', sender: {role: 'unknown'}};
	const merged = mergeContextPages(
		[omission, omission, ...messages(2)],
		[...messages(2).slice(-1), ...messages(3).slice(-1)],
	);
	assert.equal(merged.filter(item => item.omittedReason).length, 2);
	assert.deepEqual(merged.filter(item => item.messageId).map(item => item.messageId), [
		'message-1',
		'message-2',
		'message-3',
	]);
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
				return 'moved';
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

test('bounded backfill stops on timeout and conversation changes', async () => {
	let now = 0;
	let restored = 0;
	const timedOut = await captureBoundedContext({
		backfillOnce: async () => 'moved',
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
		backfillOnce: async () => 'moved',
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

test('review snapshots freeze context and expose edits without reviving raw changes', () => {
	const source = messages(2);
	const review = captureContextReviewSnapshot({
		contextVersion: '2:message-2',
		items: source.map(item => ({item})),
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
		items: [{editedExcerpt: 'Redacted excerpt', item: review.items[0].item}],
		newMessagesAvailable: true,
	});
	assert.equal(edited.newMessagesAvailable, true);
	assert.match(buildReviewedPrompt(edited), /Redacted excerpt/);
	assert.doesNotMatch(buildReviewedPrompt(edited), /Message 1/);
});
