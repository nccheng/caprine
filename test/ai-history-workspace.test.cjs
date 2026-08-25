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
		model: 'gpt-test',
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
	const chats = Array.from({length: maximumHistoryChats + 1}, (_, index) => ({
		conversationId: 'messenger-thread:one',
		createdAt: index,
		id: `chat-${index}`,
		interactions: index === maximumHistoryChats ? [interaction()] : [],
	}));
	const views = buildAiHistoryChatViews(chats);
	assert.equal(views.length, maximumHistoryChats);
	assert.equal(views[0].id, `chat-${maximumHistoryChats}`);
	assert.equal(views[0].title, 'First question');
	assert.equal(views[0].preview.length, 240);
	assert.deepEqual(views[0].badges, ['Web', 'Image']);
	assert.deepEqual(views[0].interactions[0].artifacts, [{id: 'transcript-1', kind: 'transcript'}]);
	assert.equal(JSON.stringify(views).includes('/private/path'), false);
});

test('empty durable chats remain visible as new chats', () => {
	assert.deepEqual(buildAiHistoryChatViews([{
		conversationId: 'messenger-thread:one',
		createdAt: 50,
		id: 'empty-chat',
		interactions: [],
	}])[0], {
		badges: [],
		contextCount: 0,
		createdAt: 50,
		id: 'empty-chat',
		interactions: [],
		lastActivityAt: 50,
		preview: 'No answers yet.',
		title: 'New AI chat',
	});
});
