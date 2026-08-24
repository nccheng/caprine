const assert = require('node:assert/strict');
const test = require('node:test');
const {
	isMessageAnchorRectangleVisible,
	isMessageAnchorShortcut,
} = require('../dist-js/message-anchor-interaction.js');

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
