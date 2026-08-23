const assert = require('node:assert/strict');
const test = require('node:test');
const {
	extractConversationContextCandidates,
	maximumLoadedConversationContextItems,
} = require('../dist-js/messenger-context.js');

test('context fixtures preserve chronological incoming and outgoing multiline text', () => {
	const result = extractConversationContextCandidates([
		{
			domOrder: 2,
			senderDisplayName: 'Derek',
			senderRole: 'outgoing',
			stableId: 'message-2',
			text: 'Second line\n  stays multiline',
			timestamp: '2026-08-23T13:00:02-07:00',
		},
		{
			domOrder: 1,
			senderDisplayName: 'Alex',
			senderRole: 'incoming',
			stableId: 'message-1',
			text: 'First message',
			timestamp: '2026-08-23T13:00:01-07:00',
		},
	]);

	assert.deepEqual(result, [
		{
			confidence: 'high',
			messageId: 'message-1',
			sender: {displayName: 'Alex', role: 'incoming'},
			text: 'First message',
			timestamp: '2026-08-23T13:00:01-07:00',
		},
		{
			confidence: 'high',
			messageId: 'message-2',
			sender: {displayName: 'Derek', role: 'outgoing'},
			text: 'Second line\nstays multiline',
			timestamp: '2026-08-23T13:00:02-07:00',
		},
	]);
});

test('replies reactions link previews and attachment placeholders stay on their message', () => {
	const [item] = extractConversationContextCandidates([{
		attachments: ['image', 'audio', 'video', 'image'],
		domOrder: 0,
		linkPreview: {
			description: 'A visible preview',
			title: 'Example page',
			url: 'https://example.com/article',
		},
		reactions: [
			{count: 2, emoji: '👍'},
			{count: 3, emoji: '👍'},
			{emoji: '❤️'},
		],
		reply: {quotedSender: 'Alex', text: 'Earlier message'},
		senderRole: 'outgoing',
		stableId: 'message-rich',
		text: 'My reply',
	}]);

	assert.deepEqual(item.reply, {quotedSender: 'Alex', text: 'Earlier message'});
	assert.deepEqual(item.reactions, [
		{count: 3, emoji: '👍'},
		{count: 1, emoji: '❤️'},
	]);
	assert.deepEqual(item.linkPreview, {
		description: 'A visible preview',
		domain: 'example.com',
		title: 'Example page',
		url: 'https://example.com/article',
	});
	assert.deepEqual(item.attachments, [
		{kind: 'image'},
		{kind: 'audio'},
		{kind: 'video'},
	]);
});

test('missing fields stay unknown and stable duplicate mutations emit one plain item', () => {
	const fixture = {
		domOrder: 4,
		stableId: 'message-duplicate',
		text: 'Rendered twice',
	};
	const result = extractConversationContextCandidates([
		fixture,
		{...fixture, domOrder: 8},
	]);

	assert.deepEqual(result, [{
		confidence: 'medium',
		messageId: 'message-duplicate',
		sender: {role: 'unknown'},
		text: 'Rendered twice',
	}]);
	assert.equal('timestamp' in result[0], false);
	assert.equal(JSON.stringify(result).includes('element'), false);
});

test('conflicting duplicate mutations and malformed content fail closed', () => {
	const result = extractConversationContextCandidates([
		{domOrder: 0, stableId: 'message-conflict', text: 'First value'},
		{domOrder: 1, stableId: 'message-conflict', text: 'Different value'},
		{domOrder: 2, malformed: true},
		{domOrder: 3, unsupported: true},
		{domOrder: 4},
		{domOrder: Number.NaN, text: 'Ignored invalid fixture'},
	]);

	assert.deepEqual(result, [
		{
			confidence: 'low',
			messageId: 'message-conflict',
			omittedReason: 'ambiguous-message',
			sender: {role: 'unknown'},
		},
		{
			confidence: 'low',
			omittedReason: 'malformed-message',
			sender: {role: 'unknown'},
		},
		{
			confidence: 'low',
			omittedReason: 'unsupported-message',
			sender: {role: 'unknown'},
		},
		{
			confidence: 'low',
			omittedReason: 'no-supported-content',
			sender: {role: 'unknown'},
		},
	]);
});

test('context extraction stays bounded to the most recent loaded messages', () => {
	const candidates = Array.from(
		{length: maximumLoadedConversationContextItems + 2},
		(_, domOrder) => ({domOrder, text: `Message ${domOrder}`}),
	);
	const result = extractConversationContextCandidates(candidates);

	assert.equal(result.length, maximumLoadedConversationContextItems);
	assert.equal(result[0].text, 'Message 2');
	assert.equal(result.at(-1).text, `Message ${maximumLoadedConversationContextItems + 1}`);
});
