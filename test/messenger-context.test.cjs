const assert = require('node:assert/strict');
const test = require('node:test');
const {
	captureMessengerMessageAnchor,
	extractConversationContextCandidates,
	extractLoadedMessengerConversationContext,
	maximumMessengerDomExtractionItems,
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

test('message anchors capture one immutable-order logical message with visible sender semantics', () => {
	const candidates = [
		{
			domOrder: 4,
			senderDisplayName: 'Alex',
			senderRole: 'incoming',
			stableId: 'message-incoming',
			text: 'Can you review this?',
		},
		{
			attachments: ['image'],
			domOrder: 8,
			senderDisplayName: 'You',
			senderRole: 'outgoing',
			stableId: 'message-outgoing',
		},
	];

	assert.deepEqual(captureMessengerMessageAnchor(candidates, 4), {
		item: {
			confidence: 'high',
			messageId: 'message-incoming',
			sender: {displayName: 'Alex', role: 'incoming'},
			text: 'Can you review this?',
		},
		loadedCount: 2,
		loadedIndex: 0,
	});
	assert.deepEqual(captureMessengerMessageAnchor(candidates, 8)?.item.attachments, [{kind: 'image'}]);
});

test('message anchors fail closed for ambiguous unsupported and identity-free rows', () => {
	assert.equal(captureMessengerMessageAnchor([
		{
			domOrder: 0, senderRole: 'incoming', stableId: 'duplicate', text: 'First',
		},
		{
			domOrder: 1, senderRole: 'incoming', stableId: 'duplicate', text: 'Changed',
		},
	], 0), undefined);
	assert.equal(captureMessengerMessageAnchor([
		{domOrder: 0, senderRole: 'incoming', text: 'No stable identity'},
	], 0), undefined);
	assert.equal(captureMessengerMessageAnchor([
		{domOrder: 0, stableId: 'unknown-sender', text: 'No visible sender'},
	], 0), undefined);
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

test('same sender and text without a shared stable ID preserve distinct message instances', () => {
	const result = extractConversationContextCandidates([
		{
			domOrder: 0,
			senderDisplayName: 'Alex',
			senderRole: 'incoming',
			text: 'Repeated words',
			timestamp: '2026-08-23T13:00:00-07:00',
		},
		{
			domOrder: 1,
			senderDisplayName: 'Alex',
			senderRole: 'incoming',
			text: 'Repeated words',
			timestamp: '2026-08-23T13:00:00-07:00',
		},
	]);

	assert.equal(result.length, 2);
	assert.equal(result[0].text, 'Repeated words');
	assert.equal(result[1].text, 'Repeated words');
});

test('repeated messages with distinct stable IDs are never semantically collapsed', () => {
	const result = extractConversationContextCandidates([
		{
			domOrder: 0, senderRole: 'outgoing', stableId: 'message-one', text: 'Again',
		},
		{
			domOrder: 1, senderRole: 'outgoing', stableId: 'message-two', text: 'Again',
		},
	]);

	assert.deepEqual(result.map(item => item.messageId), ['message-one', 'message-two']);
});

test('virtualized mutations with one stable ID retain the latest mutable metadata', () => {
	const result = extractConversationContextCandidates([
		{
			domOrder: 0,
			reactions: [{count: 1, emoji: '👍'}],
			senderRole: 'incoming',
			stableId: 'message-virtualized',
			text: 'One logical message',
		},
		{
			domOrder: 7,
			reactions: [{count: 2, emoji: '👍'}],
			senderRole: 'incoming',
			stableId: 'message-virtualized',
			text: 'One logical message',
		},
	]);

	assert.equal(result.length, 1);
	assert.deepEqual(result[0].reactions, [{count: 2, emoji: '👍'}]);
});

test('conflicting duplicate mutations and malformed content fail closed', () => {
	const result = extractConversationContextCandidates([
		{domOrder: 0, stableId: 'message-conflict', text: 'First value'},
		{domOrder: 1, stableId: 'message-conflict', text: 'Different value'},
		{domOrder: 2, stableId: 'message-conflict', text: 'First value'},
		{domOrder: 3, malformed: true},
		{domOrder: 4, unsupported: true},
		{domOrder: 5},
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
		{length: maximumMessengerDomExtractionItems + 2},
		(_, domOrder) => ({domOrder, text: `Message ${domOrder}`}),
	);
	const result = extractConversationContextCandidates(candidates);

	assert.equal(result.length, maximumMessengerDomExtractionItems);
	assert.equal(result[0].text, 'Message 2');
	assert.equal(result.at(-1).text, `Message ${maximumMessengerDomExtractionItems + 1}`);
});

test('sanitized semantic DOM fixtures exercise traversal and deduplicate virtualized copies', () => {
	const makeRow = () => {
		const avatar = new FixtureElement({attributes: {alt: 'Alex', 'data-message-author': ''}});
		const quotedAvatar = new FixtureElement({attributes: {alt: 'Taylor', 'data-message-author': ''}});
		const currentText = new FixtureElement({text: 'Current message'});
		const reply = new FixtureElement({
			children: {[messengerContextSelectors.senderAvatar]: [quotedAvatar]},
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
			attributes: {'data-message-id': 'message-rich'},
			children: {
				'[aria-label]': [reaction],
				'a[href]': [link],
				audio: [new FixtureElement()],
				'img[alt]': [avatar, photo],
				[messengerContextSelectors.senderAvatar]: [avatar],
				[messengerContextSelectors.message]: [],
				[messengerContextSelectors.reaction]: [reaction],
				[messengerContextSelectors.reply]: [reply],
				[messengerContextSelectors.messageText]: [wrappingText, reply, currentText],
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

test('DOM boundary rejects unrelated UI placeholders and incomplete containers with reasons', () => {
	const unrelatedAccessibilityText = new FixtureElement({
		attributes: {'aria-label': 'Navigation notice'},
		children: {
			'[aria-label]': [new FixtureElement({attributes: {'aria-label': 'Press Escape to close'}})],
			'[dir="auto"]': [new FixtureElement({text: 'Keyboard shortcut help'})],
			[messengerContextSelectors.message]: [],
		},
	});
	const sidebarRow = new FixtureElement({
		children: {
			[messengerContextSelectors.message]: [],
			[messengerContextSelectors.messageText]: [new FixtureElement({text: 'Pinned chats'})],
		},
		closest: ['[data-messenger-sidebar]'],
	});
	const placeholder = new FixtureElement({
		children: {[messengerContextSelectors.message]: []},
		closest: ['[aria-busy="true"]'],
	});
	const incompleteMessage = new FixtureElement({
		children: {
			'img[alt]': [new FixtureElement({attributes: {alt: 'Article thumbnail'}})],
			[messengerContextSelectors.message]: [],
			[messengerContextSelectors.messageText]: [new FixtureElement({text: 'Unanchored text'})],
			[messengerContextSelectors.senderAvatar]: [],
		},
	});
	const conversation = new FixtureElement({
		children: {
			[messengerContextSelectors.message]: [
				unrelatedAccessibilityText,
				sidebarRow,
				placeholder,
				incompleteMessage,
			],
		},
	});
	const root = new FixtureElement({
		children: {[messengerContextSelectors.conversation]: [conversation]},
	});

	assert.deepEqual(
		extractLoadedMessengerConversationContext(root).map(item => item.omittedReason),
		['non-message-ui', 'non-message-ui', 'virtualized-placeholder', 'incomplete-message'],
	);
});

test('integration seam normalizes renderer candidates and fails closed on malformed input', () => {
	const result = extractConversationContextCandidates([
		{
			domOrder: 0,
			senderDisplayName: '  Alex  ',
			senderRole: 'incoming',
			stableId: 'message-normalized',
			text: ' first line \n   second line ',
		},
		{domOrder: 1, text: 42},
	]);

	assert.deepEqual(result, [
		{
			confidence: 'high',
			messageId: 'message-normalized',
			sender: {displayName: 'Alex', role: 'incoming'},
			text: 'first line\nsecond line',
		},
		{
			confidence: 'low',
			omittedReason: 'no-supported-content',
			sender: {role: 'unknown'},
		},
	]);
	assert.deepEqual(extractConversationContextCandidates(null), []);
	assert.deepEqual(extractLoadedMessengerConversationContext({
		querySelector() {
			throw new Error('malformed renderer root');
		},
	}), []);
});
