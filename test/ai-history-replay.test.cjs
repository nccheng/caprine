const assert = require('node:assert/strict');
const test = require('node:test');
const {
	captureHistoryDestinationChatId,
	originalHistoryReplayAvailability,
	restoreOriginalHistoryReview,
} = require('../dist-js/ai-history-replay.js');

test('history destination capture is immutable across later history selection changes', () => {
	const snapshot = {
		captureGeneration: 7,
		conversationId: 'messenger-thread:one',
		messengerWebContentsId: 3,
		sessionId: 'ai-session-2',
	};
	const selectedChat = {
		chatId: 'chat-original',
		conversationId: snapshot.conversationId,
		sessionId: snapshot.sessionId,
	};
	const destinationChatId = captureHistoryDestinationChatId(selectedChat, snapshot);

	selectedChat.chatId = 'chat-selected-while-requesting';
	assert.equal(destinationChatId, 'chat-original');
	assert.equal(captureHistoryDestinationChatId(selectedChat, snapshot), 'chat-selected-while-requesting');
	assert.equal(captureHistoryDestinationChatId({...selectedChat, sessionId: 'another-session'}, snapshot), undefined);
});

function interaction(overrides = {}) {
	return {
		answer: 'Original answer',
		artifactReferences: [],
		browsingMode: 'always',
		completedAt: 200,
		context: {
			actualCount: 2,
			contextVersion: 'message:two',
			items: [{
				editedExcerpt: 'Reviewed redaction',
				id: 'context-1',
				item: {
					confidence: 'high',
					messageId: 'message-1',
					sender: {displayName: 'Alex', role: 'incoming'},
					text: 'Original private text',
				},
			}],
			question: 'Historical question?',
			requestedCount: 10,
		},
		draftStatus: 'not-inserted',
		id: 'interaction-1',
		model: 'gpt-5.6-luna',
		outcome: 'completed',
		provider: 'openai',
		question: 'Historical question?',
		requestedAt: 100,
		shareStatus: 'private',
		webSearch: {citations: [], ran: true, sources: []},
		...overrides,
	};
}

test('original history replay restores the exact frozen context onto only the current binding', () => {
	const stored = interaction();
	const snapshot = {
		captureGeneration: 7,
		conversationId: 'messenger-thread:one',
		messengerWebContentsId: 3,
		sessionId: 'ai-session-2',
	};
	const restored = restoreOriginalHistoryReview(stored, snapshot);

	assert.deepEqual(restored, {
		...stored.context, images: [], newMessagesAvailable: false, snapshot, transcripts: [],
	});
	assert.notEqual(restored.items, stored.context.items);
	assert.equal(Object.isFrozen(restored), true);
	assert.equal(Object.isFrozen(restored.items[0]), true);
	restored.items[0].editedExcerpt = 'mutated';
	assert.equal(restored.items[0].editedExcerpt, 'Reviewed redaction');
	assert.equal(stored.context.items[0].editedExcerpt, 'Reviewed redaction');
});

test('original history replay fails closed for missing media/artifacts and unsupported model metadata', () => {
	assert.deepEqual(originalHistoryReplayAvailability(interaction(), 'gpt-5.6-luna'), {available: true});
	assert.deepEqual(originalHistoryReplayAvailability(interaction({
		context: {
			...interaction().context,
			items: [{id: 'image', item: {attachments: [{kind: 'image'}], confidence: 'high', sender: {role: 'incoming'}}}],
		},
	}), 'gpt-5.6-luna'), {available: false, reason: 'missing-artifacts'});
	assert.deepEqual(originalHistoryReplayAvailability(interaction({
		artifactReferences: [{id: 'transcript-1', kind: 'transcript', path: '/private/local'}],
	}), 'gpt-5.6-luna'), {available: false, reason: 'missing-artifacts'});
	assert.deepEqual(originalHistoryReplayAvailability(interaction({model: 'retired-model'}), 'gpt-5.6-luna'), {
		available: false,
		reason: 'unsupported-metadata',
	});
});

test('original history replay restores included and removed transcripts without raw media', () => {
	const reviewedTranscripts = [{
		contextItemId: 'context-audio',
		durationSeconds: 2,
		editedSegments: [{endSeconds: 2, startSeconds: 0, text: 'Edited words'}],
		id: 'transcript:context-audio',
		kind: 'audio',
		mediaSha256: 'ab'.repeat(32),
		messageId: 'message-audio',
		originalSegments: [{endSeconds: 2, startSeconds: 0, text: 'Original words'}],
		senderLabel: 'Voice message from Alex',
		status: 'included',
	}, {
		contextItemId: 'context-video',
		durationSeconds: 3,
		id: 'transcript:context-video',
		kind: 'video',
		mediaSha256: 'cd'.repeat(32),
		messageId: 'message-video',
		originalSegments: [{endSeconds: 3, startSeconds: 0, text: 'Removed words'}],
		senderLabel: 'Video from Alex',
		status: 'removed',
	}];
	const stored = interaction({
		context: {
			...interaction().context,
			items: [{
				id: 'context-audio',
				item: {
					attachments: [{kind: 'audio'}], confidence: 'high', messageId: 'message-audio', sender: {role: 'incoming'},
				},
			}],
		},
		reviewedTranscripts,
	});
	const snapshot = {
		captureGeneration: 7,
		conversationId: 'messenger-thread:one',
		messengerWebContentsId: 3,
		sessionId: 'ai-session-2',
	};

	assert.deepEqual(originalHistoryReplayAvailability(stored, 'gpt-5.6-luna'), {available: true});
	assert.deepEqual(restoreOriginalHistoryReview(stored, snapshot).transcripts.map(item => ({
		id: item.id, status: item.status, editedSegments: item.editedSegments,
	})), [
		{id: 'transcript:context-audio', status: 'completed', editedSegments: reviewedTranscripts[0].editedSegments},
		{id: 'transcript:context-video', status: 'removed', editedSegments: undefined},
	]);
});
