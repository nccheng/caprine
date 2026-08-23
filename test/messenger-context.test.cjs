const assert = require('node:assert/strict');
const test = require('node:test');
const {
	extractConversationContextCandidates,
	extractLoadedMessengerConversationContext,
	maximumLoadedConversationContextItems,
	messengerContextSelectors,
} = require('../dist-js/messenger-context.js');

class FixtureElement {
	constructor({attributes = {}, children = {}, closest = [], href, id = '', text = ''} = {}) {
		this.attributes = attributes;
		this.children = children;
		this.closestSelectors = closest;
		this.dataset = {
			messageId: attributes['data-message-id'],
			messageid: attributes['data-messageid'],
		};
		this.href = href;
		this.id = id;
		this.textContent = text;
	}

	closest(selector) {
		return this.closestSelectors.some(value => selector.includes(value)) ? this : undefined;
	}

	getAttribute(name) {
		return this.attributes[name] ?? null;
	}

	querySelector(selector) {
		return this.querySelectorAll(selector)[0];
	}

	querySelectorAll(selector) {
		if (this.children[selector]) {
			return this.children[selector];
		}

		for (const [childSelector, children] of Object.entries(this.children)) {
			if (selector.includes(childSelector)) {
				return children;
			}
		}

		return [];
	}
}

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

test('sanitized semantic DOM fixtures exercise traversal and deduplicate virtualized copies', () => {
	const makeRow = () => {
		const avatar = new FixtureElement({attributes: {alt: 'Alex'}});
		const quotedAvatar = new FixtureElement({attributes: {alt: 'Taylor'}});
		const currentText = new FixtureElement({text: 'Current message'});
		const reply = new FixtureElement({
			children: {'img[alt]': [quotedAvatar]},
			closest: [messengerContextSelectors.reply],
			text: 'Earlier message',
		});
		const wrappingText = new FixtureElement({
			children: {[messengerContextSelectors.reply]: [reply]},
			text: 'Earlier message\nCurrent message\n👍 2\nExample page',
		});
		const reaction = new FixtureElement({
			attributes: {'aria-label': '👍 2 reactions'},
			closest: [messengerContextSelectors.reaction],
			text: '👍',
		});
		const linkTitle = new FixtureElement({text: 'Example page'});
		const linkDescription = new FixtureElement({text: 'Visible description'});
		const link = new FixtureElement({
			children: {'[dir="auto"]': [linkTitle, linkDescription]},
			href: 'https://example.com/article',
		});
		const timestamp = new FixtureElement({attributes: {datetime: '2026-08-23T13:00:00-07:00'}});
		const photo = new FixtureElement({attributes: {alt: 'Photo'}});
		return new FixtureElement({
			children: {
				'[aria-label]': [reaction],
				'a[href]': [link],
				audio: [new FixtureElement()],
				'img[alt]': [avatar, photo],
				[messengerContextSelectors.message]: [],
				[messengerContextSelectors.reaction]: [reaction],
				[messengerContextSelectors.reply]: [reply],
				[messengerContextSelectors.text]: [wrappingText, reply, currentText],
				[messengerContextSelectors.timestamp]: [timestamp],
			},
		});
	};

	const conversation = new FixtureElement({
		children: {[messengerContextSelectors.message]: [makeRow(), makeRow()]},
	});
	const root = new FixtureElement({
		children: {[messengerContextSelectors.conversation]: [conversation]},
	});
	global.window = {location: {href: 'https://www.facebook.com/messages/t/123'}};

	const result = extractLoadedMessengerConversationContext(root);

	assert.equal(result.length, 1);
	assert.equal(result[0].text, 'Current message');
	assert.deepEqual(result[0].sender, {displayName: 'Alex', role: 'incoming'});
	assert.deepEqual(result[0].reply, {quotedSender: 'Taylor', text: 'Earlier message'});
	assert.deepEqual(result[0].reactions, [{count: 2, emoji: '👍'}]);
	assert.deepEqual(result[0].linkPreview, {
		description: 'Visible description',
		domain: 'example.com',
		title: 'Example page',
		url: 'https://example.com/article',
	});
	assert.deepEqual(result[0].attachments, [{kind: 'audio'}, {kind: 'image'}]);
});
