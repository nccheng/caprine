const assert = require('node:assert/strict');
const test = require('node:test');
const {
	AiAssistSessionStateMachine,
	AiConversationBinding,
	ConversationLifecycle,
} = require('../dist-js/ai-assist-state.js');
const {
	conversationIdFromMessengerUrl,
	deriveConversationIdentity,
} = require('../dist-js/conversation-identity.js');
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
	assert.equal(state.completeRequest().status, 'open');
	assert.equal(state.beginRequest().status, 'requesting');
	assert.equal(state.cancel().status, 'cancelled');
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
		conversation: {captureGeneration: 2, displayName: 'Derek', status: 'ready'},
		credentials: {configured: true, secureStorageAvailable: true},
		enabled: true,
		request: {answer: 'private'},
		session: {generation: 1, sessionId: 'ai-session-1', status: 'open'},
	}), true);
	assert.equal(isAiAssistPanelState({
		conversation: {captureGeneration: 2, status: 'ready'},
		credentials: {configured: true, secureStorageAvailable: true},
		enabled: true,
		request: {apiKey: 'secret'},
		session: {generation: 1, status: 'open'},
	}), false);
	assert.equal(isAiAssistPanelCommand({type: 'save-api-key', apiKey: 'sk-test-value'}), true);
	assert.equal(isAiAssistPanelCommand({type: 'save-api-key', apiKey: 'short'}), false);
	assert.equal(isAiAssistPanelCommand({type: 'submit-prompt', prompt: 'Hello'}), true);
	assert.equal(isAiAssistPanelCommand({type: 'submit-prompt', prompt: ''}), false);
	assert.equal(isAiAssistMessengerCommand({type: 'set-enabled', enabled: true}), true);
	assert.equal(isAiAssistMessengerCommand({type: 'report-conversation'}), true);
	assert.equal(isAiAssistMessengerCommand({
		requestId: 'conversation-report-1',
		type: 'report-conversation',
	}), true);
	assert.equal(isAiAssistMessengerCommand({type: 'set-enabled', enabled: 'yes'}), false);
	assert.equal(isAiAssistMessengerEvent({
		conversationId: 'messenger-thread:123',
		requestId: 'conversation-report-1',
		status: 'available',
		type: 'conversation-state',
	}), true);
	assert.equal(isAiAssistMessengerEvent({
		conversationId: 'messenger-thread:123',
		status: 'available',
		type: 'conversation-state',
		url: 'secret',
	}), false);
	assert.equal(isAiAssistMessengerEvent({
		reason: 'no-reliable-identity',
		status: 'unavailable',
		type: 'conversation-state',
	}), true);
});

test('Messenger identity uses stable route IDs rather than display names', () => {
	assert.equal(
		conversationIdFromMessengerUrl('https://www.facebook.com/messages/t/111'),
		'messenger-thread:111',
	);
	assert.equal(
		conversationIdFromMessengerUrl('https://www.facebook.com/messages/e2ee/t/222/'),
		'messenger-thread:222',
	);
	assert.equal(
		conversationIdFromMessengerUrl('https://example.com/messages/t/111'),
		undefined,
	);

	const first = deriveConversationIdentity('https://www.facebook.com/messages/t/111', [
		{displayName: 'Alex', href: '/messages/t/111'},
	]);
	const second = deriveConversationIdentity('https://www.facebook.com/messages/t/222', [
		{displayName: 'Alex', href: '/messages/t/222'},
	]);
	assert.equal(first.status, 'available');
	assert.equal(second.status, 'available');
	assert.notEqual(first.conversationId, second.conversationId);
});

test('Messenger identity fails closed for ambiguous or missing active threads', () => {
	assert.deepEqual(
		deriveConversationIdentity('https://www.facebook.com/messages/t/111', [
			{displayName: 'Wrong thread', href: '/messages/t/222'},
		]),
		{reason: 'ambiguous-identity', status: 'unavailable'},
	);
	assert.deepEqual(
		deriveConversationIdentity('https://www.facebook.com/login', []),
		{reason: 'no-reliable-identity', status: 'unavailable'},
	);
});

test('conversation snapshots never revive after rapid thread switches', () => {
	const binding = new AiConversationBinding();
	assert.equal(binding.reportAvailable('messenger-thread:111', 'Alex'), false);
	const first = binding.bind('ai-session-1', 7);
	assert.equal(binding.isCurrent(first), true);
	assert.deepEqual(first, {
		captureGeneration: 2,
		conversationId: 'messenger-thread:111',
		messengerWebContentsId: 7,
		sessionId: 'ai-session-1',
	});

	assert.equal(binding.reportAvailable('messenger-thread:222', 'Alex'), true);
	assert.equal(binding.isCurrent(first), false);
	assert.equal(binding.currentSnapshot, undefined);
	assert.equal(binding.panelState.status, 'changed');

	assert.equal(binding.reportAvailable('messenger-thread:111', 'Alex'), true);
	assert.equal(binding.isCurrent(first), false);
	assert.equal(binding.panelState.status, 'changed');

	const refreshed = binding.bind('ai-session-2', 7);
	assert.equal(binding.isCurrent(refreshed), true);
	assert.notEqual(refreshed.captureGeneration, first.captureGeneration);
	assert.equal(binding.reportUnavailable(), true);
	assert.equal(binding.isCurrent(refreshed), false);
	assert.equal(binding.panelState.status, 'unavailable');
});

test('stale conversation reports cannot cross reload or panel lifecycle boundaries', () => {
	const lifecycle = new ConversationLifecycle();
	const reportStartedBeforeReload = lifecycle.snapshot;
	assert.equal(lifecycle.isCurrent(reportStartedBeforeReload), true);

	lifecycle.advance();
	assert.equal(lifecycle.isCurrent(reportStartedBeforeReload), false);
	const reportStartedAfterReload = lifecycle.snapshot;
	assert.equal(lifecycle.isCurrent(reportStartedAfterReload), true);

	lifecycle.advance();
	assert.equal(lifecycle.isCurrent(reportStartedAfterReload), false);
});
