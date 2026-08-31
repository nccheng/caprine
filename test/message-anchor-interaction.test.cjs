const assert = require('node:assert/strict');
const test = require('node:test');
const {
	isMessageAnchorRectangleVisible,
	isMessageAnchorShortcut,
	messageAnchorContentRectangle,
	messageAnchorPosition,
	isWithinMessageAnchorBridge,
} = require('../dist-js/message-anchor-interaction.js');
const {MessengerContextFixtureElement: Element} = require('./helpers/messenger-context-fixture.cjs');

test('Ask AI follows message content instead of a full-width outgoing row or the sidebar', () => {
	const conversation = {
		left: 320, right: 1400, top: 50, bottom: 800, width: 1080, height: 750,
	};
	const bubble = {
		left: 1200, right: 1380, top: 300, bottom: 350, width: 180, height: 50,
	};
	const row = new Element({
		rectangle: {
			...conversation, top: 300, bottom: 350, height: 50,
		}, children: [
			{attributes: {dir: 'auto'}, text: 'Owner question', rectangle: bubble},
		],
	});
	const content = messageAnchorContentRectangle(row, 'Owner question');
	assert.deepEqual(content, bubble);
	const position = messageAnchorPosition(content, conversation, {width: 1400, height: 900}, {width: 76, height: 32});
	assert.deepEqual(position, {left: 1116, top: 304});
	const fallback = messageAnchorPosition(row.getBoundingClientRect(), conversation, {width: 1400, height: 900}, {width: 76, height: 32});
	assert.equal(fallback.left >= conversation.left, true);
	const button = {
		...position, right: position.left + 76, bottom: position.top + 32, width: 76, height: 32,
	};
	assert.equal(isWithinMessageAnchorBridge({x: 1196, y: 310}, content, button), true, 'crossing the eight-pixel gap keeps the button reachable');
	assert.equal(isWithinMessageAnchorBridge({x: 200, y: 310}, content, button), false, 'sidebar hover must not retain the target');
});

test('Ask AI ignores quoted duplicate text when measuring its message', () => {
	const own = {
		left: 900, right: 1200, top: 300, bottom: 340, width: 300, height: 40,
	};
	const quote = {
		left: 950, right: 1000, top: 250, bottom: 270, width: 50, height: 20,
	};
	const row = new Element({
		children: [
			{attributes: {'aria-label': '前往已回覆的訊息'}, children: [{attributes: {dir: 'auto'}, text: 'Same', rectangle: quote}]},
			{attributes: {dir: 'auto'}, text: 'Same', rectangle: own},
		],
	});
	assert.deepEqual(messageAnchorContentRectangle(row, 'Same'), own);
	assert.equal(messageAnchorPosition(own, own, {width: 50, height: 50}, {width: 76, height: 32}), undefined);
});

test('Option+A uses the physical key code across macOS keyboard layouts', () => {
	assert.equal(isMessageAnchorShortcut({
		altKey: true,
		code: 'KeyA',
		ctrlKey: false,
		metaKey: false,
		shiftKey: false,
	}), true);
	assert.equal(isMessageAnchorShortcut({
		altKey: true,
		code: 'KeyQ',
		ctrlKey: false,
		metaKey: false,
		shiftKey: false,
	}), false);
	assert.equal(isMessageAnchorShortcut({
		altKey: true,
		code: 'KeyA',
		ctrlKey: false,
		metaKey: true,
		shiftKey: false,
	}), false);
});

test('message anchor rectangles must intersect both viewport axes', () => {
	const visible = {
		bottom: 140,
		height: 40,
		left: 100,
		right: 260,
		top: 100,
		width: 160,
	};
	assert.equal(isMessageAnchorRectangleVisible(visible, 800, 600), true);
	assert.equal(isMessageAnchorRectangleVisible({...visible, bottom: 0, top: -40}, 800, 600), false);
	assert.equal(isMessageAnchorRectangleVisible({...visible, bottom: 640, top: 600}, 800, 600), false);
	assert.equal(isMessageAnchorRectangleVisible({...visible, left: -160, right: 0}, 800, 600), false);
	assert.equal(isMessageAnchorRectangleVisible({...visible, left: 800, right: 960}, 800, 600), false);
	assert.equal(isMessageAnchorRectangleVisible({...visible, height: 0}, 800, 600), false);
});
