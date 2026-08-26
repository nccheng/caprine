const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
	caprineAiShareDecorationAttribute,
	createCaprineAiShareDecorationViewModel,
	reconcileCaprineAiShareDecoration,
	reconcileLoadedCaprineAiShareDecorations,
	removeLoadedCaprineAiShareDecorations,
} = require('../dist-js/share-message-decoration.js');
const {formatCaprineAiShareText} = require('../dist-js/share-text-protocol.js');
const {
	loadMessengerContextFixture,
	MessengerContextFixtureElement,
} = require('./helpers/messenger-context-fixture.cjs');

const decorationSelector = `[${caprineAiShareDecorationAttribute}]`;

function fixtureRows(fixture) {
	return fixture.root.querySelectorAll('[role="row"]');
}

function decorationText(row) {
	return row.querySelector(decorationSelector)?.shadowRoot.textContent;
}

test('view model trusts the native sender role and treats protocol sharer text as display metadata', () => {
	const text = formatCaprineAiShareText({
		answer: 'Answer',
		modelLabel: 'gpt-5.6',
		question: 'Question',
		sources: [],
	});
	assert.equal(createCaprineAiShareDecorationViewModel(text, 'unknown'), undefined);
	assert.equal(createCaprineAiShareDecorationViewModel(text, 'incoming').sharerLabel, undefined);
	assert.equal(
		createCaprineAiShareDecorationViewModel(text, 'outgoing').sharerLabel,
		'AI response shared by Derek',
	);
	assert.equal(
		createCaprineAiShareDecorationViewModel(text.replace('shared by Derek', 'shared by Mallory'), 'outgoing'),
		undefined,
	);
});

test('live-like rows decorate valid outgoing and incoming shares without replacing native content', () => {
	const fixture = loadMessengerContextFixture('share-decoration.json');
	const [outgoing, incoming, forged, unknown] = fixtureRows(fixture);
	const outgoingText = outgoing.querySelector('[data-ad-preview="message"]').textContent;
	const incomingText = incoming.querySelector('[data-ad-preview="message"]').textContent;

	assert.equal(reconcileLoadedCaprineAiShareDecorations(fixture.root), 2);
	assert.equal(outgoing.querySelectorAll(decorationSelector).length, 1);
	assert.equal(incoming.querySelectorAll(decorationSelector).length, 1);
	assert.equal(forged.querySelector(decorationSelector), undefined);
	assert.equal(unknown.querySelector(decorationSelector), undefined);
	assert.equal(outgoing.querySelector('[data-ad-preview="message"]').textContent, outgoingText);
	assert.equal(incoming.querySelector('[data-ad-preview="message"]').textContent, incomingText);
	assert.match(decorationText(outgoing), /Caprine AI AssistModel: gpt-5\.6AI response shared by DerekNot an authenticated Messenger botSources \(1\)Example source/);
	assert.doesNotMatch(decorationText(outgoing), /A complete answer/);
	assert.match(decorationText(incoming), /Model: gpt-5\.6-miniNot an authenticated Messenger bot/);
	assert.doesNotMatch(decorationText(incoming), /AI response shared by Derek/);
	const details = outgoing.querySelector(decorationSelector).shadowRoot.children[1].children.at(-1);
	assert.equal(details.localName, 'details');
	assert.equal(details.getAttribute('open'), null);
	assert.equal(details.children[0].localName, 'summary');
	assert.equal(details.children[0].getAttribute('aria-label'), '1 cited sources');
});

test('reconciliation is idempotent and removes or refreshes stale decoration after edits', () => {
	const fixture = loadMessengerContextFixture('share-decoration.json');
	const [row] = fixtureRows(fixture);
	const message = row.querySelector('[data-ad-preview="message"]');

	assert.equal(reconcileCaprineAiShareDecoration(row), true);
	const firstHost = row.querySelector(decorationSelector);
	assert.equal(reconcileCaprineAiShareDecoration(row), true);
	assert.equal(row.querySelectorAll(decorationSelector).length, 1);
	assert.equal(row.querySelector(decorationSelector), firstHost);

	message.textContent = 'Edited into ordinary Messenger text';
	assert.equal(reconcileCaprineAiShareDecoration(row), false);
	assert.equal(row.querySelector(decorationSelector), undefined);

	message.textContent = formatCaprineAiShareText({
		answer: 'Updated answer',
		modelLabel: 'updated-model',
		question: 'Updated question',
		sources: [],
	});
	assert.equal(reconcileCaprineAiShareDecoration(row), true);
	assert.match(decorationText(row), /Model: updated-model/);
	assert.doesNotMatch(decorationText(row), /Updated answer/);
});

test('virtualized re-addition and thread replacement create one current decoration and cleanup is bounded', () => {
	const first = loadMessengerContextFixture('share-decoration.json');
	const second = loadMessengerContextFixture('share-decoration.json');
	const firstConversation = first.root.querySelector('[role="main"] [role="grid"]');
	const secondConversation = second.root.querySelector('[role="main"] [role="grid"]');
	assert.equal(reconcileLoadedCaprineAiShareDecorations(first.root), 2);

	firstConversation.setChildren(secondConversation.children);
	assert.equal(reconcileLoadedCaprineAiShareDecorations(first.root), 2);
	assert.equal(first.root.querySelectorAll(decorationSelector).length, 2);
	removeLoadedCaprineAiShareDecorations(first.root);
	assert.equal(first.root.querySelectorAll(decorationSelector).length, 0);
});

test('coexisting virtualized copies decorate only the latest consistent row and conflicts fail closed', () => {
	const first = loadMessengerContextFixture('share-decoration.json');
	const second = loadMessengerContextFixture('share-decoration.json');
	const conversation = first.root.querySelector('[role="main"] [role="grid"]');
	const firstOutgoing = fixtureRows(first)[0];
	const secondOutgoing = fixtureRows(second)[0];
	conversation.setChildren([firstOutgoing, secondOutgoing]);

	assert.equal(reconcileLoadedCaprineAiShareDecorations(first.root), 1);
	assert.equal(firstOutgoing.querySelector(decorationSelector), undefined);
	assert.ok(secondOutgoing.querySelector(decorationSelector));

	secondOutgoing.querySelector('[data-ad-preview="message"]').textContent = formatCaprineAiShareText({
		answer: 'Conflicting duplicate',
		modelLabel: 'gpt-5.6',
		question: 'What changed?',
		sources: [],
	});
	assert.equal(reconcileLoadedCaprineAiShareDecorations(first.root), 0);
	assert.equal(first.root.querySelectorAll(decorationSelector).length, 0);
});

test('one malformed row cannot prevent stale cleanup and valid reconciliation elsewhere', () => {
	const fixture = loadMessengerContextFixture('share-decoration.json');
	const [outgoing, incoming, malformed] = fixtureRows(fixture);
	assert.equal(reconcileLoadedCaprineAiShareDecorations(fixture.root), 2);
	outgoing.querySelector('[data-ad-preview="message"]').textContent = 'Edited ordinary text';
	malformed.throwOnSelectors = ['[data-ad-preview="message"]'];

	assert.equal(reconcileLoadedCaprineAiShareDecorations(fixture.root), 1);
	assert.equal(outgoing.querySelector(decorationSelector), undefined);
	assert.ok(incoming.querySelector(decorationSelector));
});

test('rows outside the bounded parsing window cannot retain stale trusted decoration', () => {
	const fixture = loadMessengerContextFixture('share-decoration.json');
	const conversation = fixture.root.querySelector('[role="main"] [role="grid"]');
	const outgoing = fixtureRows(fixture)[0];
	assert.equal(reconcileCaprineAiShareDecoration(outgoing), true);
	outgoing.querySelector('[data-ad-preview="message"]').textContent = 'Edited ordinary text';
	const fillers = Array.from({length: 500}, (_, index) => new MessengerContextFixtureElement({
		attributes: {
			'aria-label': 'Alex sent a message',
			'data-message-id': `filler-${index}`,
			role: 'row',
		},
		children: [{attributes: {'data-ad-preview': 'message'}, text: `Ordinary ${index}`}],
	}));
	conversation.setChildren([outgoing, ...fillers]);

	assert.equal(reconcileLoadedCaprineAiShareDecorations(fixture.root), 0);
	assert.equal(outgoing.querySelector(decorationSelector), undefined);
});

test('production decoration code never uses HTML parsing for provider content', () => {
	const source = readFileSync(path.join(__dirname, '..', 'source', 'share-message-decoration.ts'), 'utf8');
	assert.equal(source.includes('innerHTML'), false);
	const browserSource = readFileSync(path.join(__dirname, '..', 'source', 'browser.ts'), 'utf8');
	for (const attribute of ['aria-label', 'data-ad-preview', 'data-message-id', 'data-messageid']) {
		assert.ok(browserSource.includes(`'${attribute}'`));
	}
});
