const assert = require('node:assert/strict');
const test = require('node:test');
const {buildAiHistoryChatViews, maximumHistoryChats} = require('../dist-js/ai-history-workspace.js');

function interaction(overrides = {}) {
	return {
		answer: 'A'.repeat(300),
		artifactReferences: [{id: 'transcript-1', kind: 'transcript', path: '/private/path'}],
		browsingMode: 'always',
		completedAt: 200,
		context: {
			actualCount: 1,
			contextVersion: 'v1',
			items: [{
				editedExcerpt: 'Reviewed excerpt',
				id: 'context-1',
				item: {attachments: [{kind: 'image'}], confidence: 'high', sender: {displayName: 'Alex', role: 'incoming'}},
			}],
			question: 'First question',
			requestedCount: 10,
		},
		draftStatus: 'inserted',
		id: 'interaction-1',
		model: 'gpt-5.6-luna',
		outcome: 'completed',
		provider: 'openai',
		question: 'First question',
		requestedAt: 100,
		shareStatus: 'private',
		webSearch: {citations: [], ran: true, sources: [{title: 'Source', url: 'https://example.com'}]},
		...overrides,
	};
}

test('history workspace produces newest-first bounded renderer DTOs without local artifact paths', () => {
	const summaries = Array.from({length: maximumHistoryChats + 1}, (_, index) => ({
		badges: index === 0 ? ['Web', 'Image'] : [],
		contextCount: index === 0 ? 1 : 0,
		createdAt: index,
		id: `chat-${index}`,
		interactionCount: index === 0 ? 1 : 0,
		lastActivityAt: maximumHistoryChats - index,
		preview: index === 0 ? 'A'.repeat(300) : 'No answers yet.',
		title: index === 0 ? 'First question' : 'New AI chat',
	}));
	const selectedChat = {
		conversationId: 'messenger-thread:one',
		createdAt: 0,
		id: 'chat-0',
		interactions: [interaction({
			webSearch: {
				citations: [{title: 'Citation only', url: 'https://example.com/citation'}],
				ran: true,
				sources: [],
			},
		})],
	};
	const views = buildAiHistoryChatViews(summaries, selectedChat);
	assert.equal(views.length, maximumHistoryChats);
	assert.equal(views[0].id, 'chat-0');
	assert.equal(views[0].title, 'First question');
	assert.equal(views[0].preview.length, 240);
	assert.deepEqual(views[0].badges, ['Web', 'Image']);
	assert.deepEqual(views[0].interactions[0].artifacts, [{id: 'transcript-1', kind: 'transcript'}]);
	assert.deepEqual(views[0].interactions[0].originalReplay, {available: false, reason: 'missing-artifacts'});
	assert.deepEqual(views[0].interactions[0].citations, [{title: 'Citation only', url: 'https://example.com/citation'}]);
	assert.equal(views[1].interactions.length, 0);
	assert.equal(JSON.stringify(views).includes('/private/path'), false);
});

test('empty durable chats remain visible as new chats', () => {
	assert.deepEqual(buildAiHistoryChatViews([{
		badges: [],
		contextCount: 0,
		createdAt: 50,
		id: 'empty-chat',
		interactionCount: 0,
		lastActivityAt: 50,
		preview: 'No answers yet.',
		title: 'New AI chat',
	}])[0], {
		badges: [],
		contextCount: 0,
		createdAt: 50,
		id: 'empty-chat',
		interactionCount: 0,
		interactions: [],
		lastActivityAt: 50,
		preview: 'No answers yet.',
		title: 'New AI chat',
	});
});

test('history workspace exposes only bounded renderable video evidence and no local paths or raw provider records', () => {
	const item = interaction({
		artifactReferences: [],
		videoArtifact: {
			coverage: 'sparse',
			durationSeconds: 20,
			focusedFrameCount: 2,
			id: 'video:thread:hash',
			keyframes: [{bytes: Uint8Array.of(0xFF, 0xD8, 1, 0xFF, 0xD9), mimeType: 'image/jpeg', timestampSeconds: 5}],
			mediaSha256: 'ab'.repeat(32),
			model: 'gpt-5.6-luna',
			provider: 'openai',
			sampledFrameCount: 8,
			samplingConfiguration: {maximumFrames: 180},
			sourceConversationId: 'messenger-thread:one',
			sourceMessageId: 'message-video',
			timeline: [{
				description: 'A box appears', endSeconds: 6, startSeconds: 4, timestamps: [5],
			}],
			transcript: {segments: [{endSeconds: 2, startSeconds: 1, text: 'Reviewed transcript'}], status: 'completed'},
			uncertaintyNotes: ['Sparse coverage'],
		},
	});
	const [view] = buildAiHistoryChatViews([{
		badges: ['Video'],
		contextCount: 1,
		createdAt: 1,
		id: 'chat-video',
		interactionCount: 1,
		lastActivityAt: 2,
		preview: 'Video answer',
		title: 'Video question',
	}], {
		conversationId: 'messenger-thread:one',
		createdAt: 1,
		id: 'chat-video',
		interactions: [item],
	});

	assert.equal(view.interactions[0].videoArtifact.keyframes[0].dataUrl, 'data:image/jpeg;base64,/9gB/9k=');
	assert.deepEqual(view.interactions[0].videoArtifact.timeline, item.videoArtifact.timeline);
	assert.deepEqual(view.interactions[0].videoArtifact.transcript, item.videoArtifact.transcript.segments);
	assert.equal(JSON.stringify(view).includes('mediaSha256'), false);
	assert.equal(JSON.stringify(view).includes('sourceMessageId'), false);
});

test('history workspace exposes reviewed transcript snapshots without hashes or source identifiers', () => {
	const transcript = {
		contextItemId: 'context-voice',
		durationSeconds: 2,
		editedSegments: [{endSeconds: 2, startSeconds: 0, text: 'Edited words'}],
		id: 'transcript:context-voice',
		kind: 'audio',
		mediaSha256: 'ab'.repeat(32),
		messageId: 'message-voice',
		originalSegments: [{endSeconds: 2, startSeconds: 0, text: 'Original words'}],
		senderLabel: 'Voice message from Alex',
		status: 'included',
	};
	const [view] = buildAiHistoryChatViews([{
		badges: ['Audio'], contextCount: 1, createdAt: 1, id: 'chat-audio', interactionCount: 1,
		lastActivityAt: 2, preview: 'Audio answer', title: 'Audio question',
	}], {
		conversationId: 'messenger-thread:one', createdAt: 1, id: 'chat-audio',
		interactions: [interaction({artifactReferences: [], reviewedTranscripts: [transcript]})],
	});

	assert.deepEqual(view.interactions[0].reviewedTranscripts, [{
		durationSeconds: 2,
		editedSegments: transcript.editedSegments,
		id: transcript.id,
		kind: 'audio',
		originalSegments: transcript.originalSegments,
		senderLabel: transcript.senderLabel,
		status: 'included',
	}]);
	assert.equal(JSON.stringify(view).includes('mediaSha256'), false);
	assert.equal(JSON.stringify(view).includes('message-voice'), false);
	assert.equal(JSON.stringify(view).includes('context-voice'), true);
});
