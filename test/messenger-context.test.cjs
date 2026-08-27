const assert = require('node:assert/strict');
const test = require('node:test');
const {
	captureMessengerMessageAnchor,
	captureLoadedMessengerMessageAnchor,
	extractConversationContextCandidates,
	extractLoadedMessengerConversationContext,
	extractLoadedMessengerConversationTail,
	inspectLoadedMessengerConversationContext,
	maximumMessengerDomExtractionItems,
	maximumMessengerTailTraversalElements,
	messengerContextSelectors,
	resolveLoadedMessengerMessageRow,
} = require('../dist-js/messenger-context.js');
const {contextVersion} = require('../dist-js/context-review.js');
const {
	loadMessengerContextFixture,
	MessengerContextFixtureElement,
} = require('./helpers/messenger-context-fixture.cjs');

const sanitizedFixtureFilenames = [
	'current-loaded-conversation.json',
	'edge-cases.json',
	'prepend-history.json',
	'stable-leaf-text.json',
	'supported-messages.json',
];

test('Messenger context fixtures contain no recognizable authenticated or account data', () => {
	for (const filename of sanitizedFixtureFilenames) {
		const fixture = loadMessengerContextFixture(filename);
		assert.doesNotMatch(
			fixture.source,
			/access_token|c_user|facebook\.com\/messages\/t\/\d|set-cookie|\bxs=/i,
		);
	}
});

test('fixture selector matching fails closed for syntax outside its supported subset', () => {
	const row = new MessengerContextFixtureElement({attributes: {role: 'row'}});

	assert.equal(row.matches('[role="row"]'), true);
	assert.equal(row.matches('.required-class[role="row"]'), false);
	assert.equal(row.matches('[role="row"]:last-child'), false);
});

for (const filename of ['supported-messages.json', 'edge-cases.json', 'current-loaded-conversation.json', 'stable-leaf-text.json']) {
	test(`sanitized Messenger context fixture ${filename} produces exact logical items`, () => {
		const fixture = loadMessengerContextFixture(filename);
		global.window = {location: {href: fixture.baseUrl}};

		assert.deepEqual(extractLoadedMessengerConversationContext(fixture.root), fixture.expected);
	});
}

test('context inspection reports bounded adapter stages without message content', () => {
	const missingRoot = new MessengerContextFixtureElement({tag: 'document'});
	const missingRows = new MessengerContextFixtureElement({
		children: [{attributes: {role: 'main'}}],
		tag: 'document',
	});
	const unsupportedContent = new MessengerContextFixtureElement({
		children: [{
			attributes: {role: 'main'},
			children: [{attributes: {'data-message-id': 'sanitized-message'}}],
		}],
		tag: 'document',
	});

	assert.deepEqual(inspectLoadedMessengerConversationContext(missingRoot), {
		items: [],
		reason: 'conversation-root-missing',
	});
	assert.deepEqual(inspectLoadedMessengerConversationContext(missingRows), {
		items: [],
		reason: 'message-rows-missing',
	});
	assert.deepEqual(inspectLoadedMessengerConversationContext(unsupportedContent), {
		items: [{
			confidence: 'low',
			messageId: 'sanitized-message',
			omittedReason: 'no-supported-content',
			sender: {role: 'unknown'},
		}],
		reason: 'supported-content-missing',
	});
});

for (const filename of ['supported-messages.json', 'current-loaded-conversation.json', 'stable-leaf-text.json']) {
	test(`sanitized newest-tail fixture ${filename} reaches the exact bounded fingerprint item`, () => {
		const fixture = loadMessengerContextFixture(filename);
		global.window = {location: {href: fixture.baseUrl}};

		assert.deepEqual(extractLoadedMessengerConversationTail(fixture.root), fixture.expectedTail);
	});
}

test('current loaded Messenger semantics resolve fallback message rows for anchoring', () => {
	const fixture = loadMessengerContextFixture('current-loaded-conversation.json');
	global.window = {location: {href: fixture.baseUrl}};
	const target = fixture.root.querySelector('[data-message-id]').querySelector('[dir="auto"]');
	const row = resolveLoadedMessengerMessageRow(target, fixture.root);

	assert.equal(row?.getAttribute('data-message-id'), 'current-outgoing-1');
	assert.equal(captureLoadedMessengerMessageAnchor(target, fixture.root)?.item.messageId, 'current-outgoing-1');
});

test('stable leaf-text semantics use one logical item for full, tail, and anchor extraction', () => {
	const fixture = loadMessengerContextFixture('stable-leaf-text.json');
	global.window = {location: {href: fixture.baseUrl}};
	const target = fixture.root.querySelectorAll('[data-message-id]').at(-1)?.children[0]?.children[0];

	assert.deepEqual(extractLoadedMessengerConversationContext(fixture.root), fixture.expected);
	assert.deepEqual(extractLoadedMessengerConversationTail(fixture.root), fixture.expectedTail);
	assert.deepEqual(captureLoadedMessengerMessageAnchor(target, fixture.root)?.item, fixture.expectedTail);
});

function messengerFixtureRoot(rows) {
	return new MessengerContextFixtureElement({
		children: [{
			attributes: {role: 'main'},
			children: [{attributes: {role: 'grid'}, children: rows}],
		}],
		tag: 'document',
	});
}

test('stable leaf-text fallback requires stable identity, confident sender, and one distinct candidate', () => {
	const root = messengerFixtureRoot([
		{
			attributes: {'aria-label': 'Avery sent a message', 'data-message-id': 'leaf-valid', role: 'row'},
			children: [{children: [{text: 'Only candidate'}, {text: 'Only candidate'}]}],
		},
		{
			attributes: {'aria-label': 'Avery sent a message', role: 'row'},
			children: [{text: 'Missing stable identity'}],
		},
		{
			attributes: {'data-message-id': 'leaf-missing-sender', role: 'row'},
			children: [{text: 'Missing sender evidence'}],
		},
		{
			attributes: {'aria-label': 'Avery sent a message', 'data-message-id': 'leaf-empty', role: 'row'},
			children: [{attributes: {'aria-hidden': 'true'}, text: 'Hidden candidate'}],
		},
		{
			attributes: {'aria-label': 'Avery sent a message', 'data-message-id': 'leaf-ambiguous', role: 'row'},
			children: [{text: 'First candidate'}, {text: 'Second candidate'}],
		},
	]);

	const items = extractLoadedMessengerConversationContext(root);
	assert.equal(items[0].text, 'Only candidate');
	for (const item of items.slice(1)) {
		assert.equal(item.text, undefined);
		assert.equal(item.omittedReason, 'no-supported-content');
	}

	assert.equal(inspectLoadedMessengerConversationContext(root).reason, undefined);
});

test('stable leaf-text fallback excludes message chrome and unrelated UI text', () => {
	const root = messengerFixtureRoot([{
		attributes: {'aria-label': 'Avery sent a message', 'data-message-id': 'leaf-exclusions', role: 'row'},
		children: [
			{children: [{text: 'Expected plain text'}]},
			{tag: 'blockquote', text: 'Quoted reply'},
			{attributes: {'aria-label': '👍 2 reactions'}, text: 'Reaction text'},
			{attributes: {datetime: '2026-08-27T00:00:00Z'}, tag: 'time', text: 'Yesterday'},
			{
				attributes: {href: 'https://example.invalid'},
				href: 'https://example.invalid',
				tag: 'a',
				text: 'Link chrome',
			},
			{tag: 'button', text: 'Button text'},
			{tag: 'input', text: 'Form control text'},
			{attributes: {role: 'textbox'}, text: 'Composer text'},
			{attributes: {'aria-hidden': 'true'}, text: 'Hidden text'},
			{attributes: {'data-placeholder': 'true'}, children: [{text: 'Placeholder text'}]},
			{attributes: {role: 'navigation'}, children: [{text: 'Navigation text'}]},
			{attributes: {'data-messenger-sidebar': ''}, children: [{text: 'Sidebar text'}]},
		],
	}]);

	const [item] = extractLoadedMessengerConversationContext(root);
	assert.equal(item.text, 'Expected plain text');
	assert.doesNotMatch(item.text, /reply|reaction|yesterday|link|button|control|composer|hidden|placeholder|navigation|sidebar/i);
});

test('stable leaf-text fallback fails closed at existing traversal and string bounds', () => {
	let nested = {text: 'Too deeply nested'};
	for (let index = 0; index <= maximumMessengerTailTraversalElements; index += 1) {
		nested = {children: [nested]};
	}

	const root = messengerFixtureRoot([
		{
			attributes: {'aria-label': 'Avery sent a message', 'data-message-id': 'leaf-too-deep', role: 'row'},
			children: [nested],
		},
		{
			attributes: {'aria-label': 'Avery sent a message', 'data-message-id': 'leaf-too-long', role: 'row'},
			children: [{text: 'x'.repeat(20_001)}],
		},
	]);

	const inspection = inspectLoadedMessengerConversationContext(root);
	assert.equal(inspection.reason, 'supported-content-missing');
	assert.deepEqual(inspection.items.map(item => item.text), [undefined, undefined]);
	assert.deepEqual(inspection.items.map(item => item.omittedReason), ['no-supported-content', 'no-supported-content']);
});

test('prepend-style fixture evolution preserves chronological logical identity', () => {
	const fixture = loadMessengerContextFixture('prepend-history.json');
	global.window = {location: {href: fixture.baseUrl}};

	assert.deepEqual(
		extractLoadedMessengerConversationContext(fixture.root).map(item => item.messageId),
		fixture.expectedBefore,
	);
	fixture.prependRows();
	assert.deepEqual(
		extractLoadedMessengerConversationContext(fixture.root).map(item => item.messageId),
		fixture.expectedAfter,
	);
});

class FixtureElement {
	constructor({attributes = {}, children = {}, closest = [], elementChildren = [], href, id = '', matches = [], text = '', traversal} = {}) {
		this.attributes = attributes;
		this.children = children;
		this.closestSelectors = closest;
		this.elementChildren = elementChildren;
		this.matchSelectors = matches;
		this.parentElement = null;
		this.traversal = traversal;
		this.dataset = {
			messageId: attributes['data-message-id'],
			messageid: attributes['data-messageid'],
		};
		this.href = href;
		this.id = id;
		this.textContent = text;
		for (const [index, child] of elementChildren.entries()) {
			child.parentElement = this;
			child.previousElementSibling = elementChildren[index - 1] ?? null;
		}
	}

	closest(selector) {
		if (this.closestSelectors.some(value => selector.includes(value))) {
			return this;
		}

		return this.parentElement?.closest(selector);
	}

	get lastElementChild() {
		return this.elementChildren.at(-1) ?? null;
	}

	matches(selector) {
		if (this.traversal) {
			this.traversal.visits += 1;
		}

		return this.matchSelectors.some(value => selector.includes(value));
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

test('tail extraction inspects only the newest logical row', () => {
	const older = new FixtureElement();
	older.querySelector = () => {
		throw new Error('older row must not be inspected');
	};

	const text = new FixtureElement({text: 'Newest message'});
	const newest = new FixtureElement({
		attributes: {'aria-label': 'Alex sent a message', 'data-message-id': 'message-newest'},
		children: {
			[messengerContextSelectors.message]: [],
			[messengerContextSelectors.messageText]: [text],
		},
		matches: [messengerContextSelectors.message],
	});
	const conversation = new FixtureElement({
		elementChildren: [older, newest],
	});
	conversation.querySelectorAll = () => {
		throw new Error('tail extraction must not query the whole conversation');
	};

	const root = new FixtureElement({
		children: {[messengerContextSelectors.conversation]: [conversation]},
	});

	assert.deepEqual(extractLoadedMessengerConversationTail(root), {
		confidence: 'high',
		messageId: 'message-newest',
		sender: {displayName: 'Alex', role: 'incoming'},
		text: 'Newest message',
	});
});

test('tail extraction uses a fixed reverse traversal budget on large conversations', () => {
	const traversal = {visits: 0};
	const newest = new FixtureElement({
		attributes: {'aria-label': 'Alex sent a message', 'data-message-id': 'message-large-tail'},
		children: {
			[messengerContextSelectors.messageText]: [new FixtureElement({text: 'Newest of many'})],
		},
		matches: [messengerContextSelectors.message],
		traversal,
	});
	const elements = [
		...Array.from({length: maximumMessengerTailTraversalElements + 200}, () => new FixtureElement({traversal})),
		newest,
	];
	const conversation = new FixtureElement({elementChildren: elements});
	conversation.querySelectorAll = () => {
		throw new Error('tail extraction must not query the whole conversation');
	};

	const root = new FixtureElement({
		children: {[messengerContextSelectors.conversation]: [conversation]},
	});

	assert.equal(extractLoadedMessengerConversationTail(root).messageId, 'message-large-tail');
	assert.equal(traversal.visits <= maximumMessengerTailTraversalElements, true);

	const noRowTraversal = {visits: 0};
	const noRowConversation = new FixtureElement({
		elementChildren: Array.from(
			{length: maximumMessengerTailTraversalElements + 1},
			() => new FixtureElement({traversal: noRowTraversal}),
		),
	});
	noRowConversation.querySelectorAll = conversation.querySelectorAll;
	const noRowRoot = new FixtureElement({
		children: {[messengerContextSelectors.conversation]: [noRowConversation]},
	});
	assert.equal(extractLoadedMessengerConversationTail(noRowRoot), undefined);
	assert.equal(noRowTraversal.visits, maximumMessengerTailTraversalElements);
});

test('tail extraction chooses the deepest logical row and skips hidden and non-message tail nodes', () => {
	const text = new FixtureElement({text: 'Deep newest message'});
	const deepest = new FixtureElement({
		attributes: {'aria-label': 'Alex sent a message', 'data-message-id': 'message-deepest'},
		children: {
			[messengerContextSelectors.messageText]: [text],
		},
		matches: [messengerContextSelectors.message],
	});
	const wrapper = new FixtureElement({
		elementChildren: [deepest],
		matches: [messengerContextSelectors.message],
	});
	const hidden = new FixtureElement({
		closest: ['[aria-hidden="true"]'],
		matches: [messengerContextSelectors.message],
	});
	const conversation = new FixtureElement({
		elementChildren: [wrapper, hidden, new FixtureElement()],
	});
	conversation.querySelectorAll = () => {
		throw new Error('tail extraction must not query the whole conversation');
	};

	const root = new FixtureElement({
		children: {[messengerContextSelectors.conversation]: [conversation]},
	});

	const tail = extractLoadedMessengerConversationTail(root);
	assert.equal(tail.messageId, 'message-deepest');
	assert.equal(contextVersion(tail), contextVersion(extractLoadedMessengerConversationTail(root)));
	deepest.attributes['data-message-id'] = 'message-changed';
	deepest.dataset.messageId = 'message-changed';
	assert.notEqual(contextVersion(tail), contextVersion(extractLoadedMessengerConversationTail(root)));
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
