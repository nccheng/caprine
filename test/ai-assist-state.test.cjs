const assert = require('node:assert/strict');
const test = require('node:test');
const {AiAssistSessionStateMachine} = require('../dist-js/ai-assist-state.js');
const {
	isAiAssistMessengerCommand,
	isAiAssistMessengerEvent,
	isAiAssistPanelCommand,
	isAiAssistPanelState,
} = require('../dist-js/ai-assist-ipc.js');

test('AI session state transitions are bounded and generation-safe', () => {
	const state = new AiAssistSessionStateMachine();

	assert.deepEqual(state.snapshot, {generation: 0, status: 'closed'});
	assert.equal(state.open().sessionId, 'ai-session-1');
	assert.equal(state.beginRequest().status, 'requesting');
	assert.equal(state.cancel().status, 'cancelled');
	assert.equal(state.invalidate('conversation-changed').status, 'invalidated');
	assert.deepEqual(state.close(), {generation: 1, status: 'closed'});
	assert.equal(state.open().sessionId, 'ai-session-2');
});

test('closed sessions ignore invalidation and cancellation', () => {
	const state = new AiAssistSessionStateMachine();

	assert.equal(state.cancel().status, 'closed');
	assert.equal(state.invalidate('messenger-reloaded').status, 'closed');
});

test('AI IPC validators reject unknown, malformed, and over-posted messages', () => {
	assert.equal(isAiAssistPanelCommand({type: 'get-state'}), true);
	assert.equal(isAiAssistPanelCommand({type: 'open'}), false);
	assert.equal(isAiAssistPanelCommand({type: 'close', extra: true}), false);
	assert.equal(isAiAssistPanelState({
		enabled: true,
		session: {generation: 1, sessionId: 'ai-session-1', status: 'open'},
	}), true);
	assert.equal(isAiAssistPanelState({
		enabled: true,
		session: {generation: 1, status: 'open', answer: 'private'},
	}), false);
	assert.equal(isAiAssistMessengerCommand({type: 'set-enabled', enabled: true}), true);
	assert.equal(isAiAssistMessengerCommand({type: 'set-enabled', enabled: 'yes'}), false);
	assert.equal(isAiAssistMessengerEvent({type: 'conversation-route-changed'}), true);
	assert.equal(isAiAssistMessengerEvent({type: 'conversation-route-changed', url: 'secret'}), false);
});
