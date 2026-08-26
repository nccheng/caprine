const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const {
	AiAssistSessionStateMachine,
	AiConversationBinding,
	captureMessageAnchorSnapshot,
	ConversationBoundAnswer,
	ConversationLifecycle,
	ConversationReportGate,
} = require('../dist-js/ai-assist-state.js');
const {
	conversationIdFromMessengerUrl,
	deriveConversationIdentity,
} = require('../dist-js/conversation-identity.js');
const {
	isAiComposerCommandRequest,
	isAiComposerCommandResult,
	isAiMessageAnchorRequest,
	isAiAssistMessengerCommand,
	isAiAssistMessengerEvent,
	isAiAssistPanelCommand,
	isAiAssistPanelState,
	isDraftInsertionAuthorizationCheck,
} = require('../dist-js/ai-assist-ipc.js');
const {isMessengerMediaResolverRequest} = require('../dist-js/media-resolver-ipc.js');

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
		contextCapturePending: false,
		contextWindowSize: 10,
		webSearchMode: 'always',
		credentials: {configured: true, secureStorageAvailable: true},
		enabled: true,
		history: {chats: [], query: '', status: 'ready'},
		media: {candidates: []},
		request: {
			answer: {
				text: 'private',
				webSearch: {
					citations: [], mode: 'off', ran: false, sources: [],
				},
			},
		},
		session: {generation: 1, sessionId: 'ai-session-1', status: 'open'},
	}), true);
	assert.equal(isAiAssistPanelState({
		conversation: {captureGeneration: 2, status: 'ready'},
		contextCapturePending: false,
		contextWindowSize: 10,
		webSearchMode: 'always',
		credentials: {configured: true, secureStorageAvailable: true},
		enabled: true,
		history: {chats: [], query: '', status: 'ready'},
		media: {candidates: []},
		request: {apiKey: 'secret'},
		session: {generation: 1, status: 'open'},
	}), false);
	assert.equal(isAiAssistPanelCommand({type: 'save-api-key', apiKey: 'sk-test-value'}), true);
	assert.equal(isAiAssistPanelCommand({type: 'save-api-key', apiKey: 'short'}), false);
	assert.equal(isAiAssistPanelCommand({type: 'submit-prompt', prompt: 'Hello'}), true);
	assert.equal(isAiAssistPanelCommand({type: 'submit-prompt', prompt: ''}), false);
	assert.equal(isAiComposerCommandRequest({
		conversationId: 'messenger-thread:123',
		prompt: 'Exact inline question',
	}), true);
	assert.equal(isAiComposerCommandRequest({
		conversationId: 'display-name-only',
		prompt: 'Question',
	}), false);
	assert.equal(isAiComposerCommandResult({accepted: true}), true);
	assert.equal(isAiComposerCommandResult({accepted: true, prompt: 'leak'}), false);
	const anchorRequest = {
		conversationId: 'messenger-thread:123',
		item: {
			attachments: [{kind: 'image'}],
			confidence: 'high',
			messageId: 'message-1',
			sender: {displayName: 'Alex', role: 'incoming'},
			text: 'Visible message',
		},
		loadedCount: 3,
		loadedIndex: 1,
	};
	assert.equal(isAiMessageAnchorRequest(anchorRequest), true);
	assert.equal(isAiMessageAnchorRequest({...anchorRequest, loadedIndex: 3}), false);
	assert.equal(isAiMessageAnchorRequest({...anchorRequest, item: {...anchorRequest.item, rawHtml: '<b>no</b>'}}), false);
	assert.equal(isAiMessageAnchorRequest({...anchorRequest, item: {...anchorRequest.item, sender: {role: 'unknown'}}}), false);
	assert.equal(isAiMessageAnchorRequest({
		...anchorRequest,
		item: {
			...anchorRequest.item,
			linkPreview: {domain: 'example.com', url: 'ftp://example.com/file'},
		},
	}), false);
	assert.equal(isAiAssistMessengerCommand({type: 'set-enabled', enabled: true}), true);
	assert.equal(isAiAssistMessengerCommand({
		conversationId: 'messenger-thread:123',
		requestId: 'context-capture-1',
		requestedCount: 20,
		type: 'capture-context',
	}), true);
	assert.equal(isAiAssistMessengerCommand({requestId: 'context-capture-1', type: 'cancel-context-capture'}), true);
	assert.equal(isAiAssistMessengerCommand({
		conversationId: 'messenger-thread:123',
		messageId: 'message-1',
		requestId: 'image-target-request-1',
		type: 'resolve-image-target',
	}), true);
	assert.equal(isAiAssistMessengerCommand({
		conversationId: 'messenger-thread:123',
		messageId: 'message-1',
		requestId: 'wrong-1',
		type: 'resolve-image-target',
	}), false);
	assert.equal(isAiAssistPanelCommand({type: 'refresh-context'}), true);
	assert.equal(isAiAssistPanelCommand({requestedCount: 50, type: 'set-context-window'}), true);
	assert.equal(isAiAssistPanelCommand({requestedCount: 12, type: 'set-context-window'}), false);
	assert.equal(isAiAssistPanelCommand({mode: 'always', type: 'set-web-search-mode'}), true);
	assert.equal(isAiAssistPanelCommand({mode: 'sometimes', type: 'set-web-search-mode'}), false);
	assert.equal(isAiAssistPanelCommand({type: 'open-citation', url: 'https://example.com/source'}), true);
	assert.equal(isAiAssistPanelCommand({type: 'open-citation', url: 'https://example.com/source', target: '_self'}), false);
	assert.equal(isAiAssistPanelCommand({type: 'new-history-chat'}), true);
	assert.equal(isAiAssistPanelCommand({chatId: 'chat-1', type: 'select-history-chat'}), true);
	assert.equal(isAiAssistPanelCommand({chatId: '', type: 'select-history-chat'}), false);
	assert.equal(isAiAssistPanelCommand({query: 'source title', type: 'search-history'}), true);
	assert.equal(isAiAssistPanelCommand({query: 'x'.repeat(201), type: 'search-history'}), false);
	assert.equal(isAiAssistPanelCommand({
		chatId: 'chat-1',
		contextSource: 'original',
		interactionId: 'interaction-1',
		type: 'prepare-history-replay',
	}), true);
	assert.equal(isAiAssistPanelCommand({
		chatId: 'chat-1',
		contextSource: 'silent',
		interactionId: 'interaction-1',
		type: 'prepare-history-replay',
	}), false);
	const insertionToken = 'draft-insertion-token:00000000-0000-4000-8000-000000000001';
	assert.equal(isAiAssistPanelCommand({
		answerGeneration: 3,
		authorizationToken: insertionToken,
		conversationId: 'messenger-thread:123',
		type: 'insert-answer',
	}), true);
	assert.equal(isAiAssistPanelCommand({
		answerGeneration: 3,
		authorizationToken: insertionToken,
		conversationId: 'messenger-thread:other',
		extra: true,
		type: 'insert-answer',
	}), false);
	assert.equal(isAiAssistPanelCommand({
		editedExcerpt: 'Redacted',
		itemId: 'context-capture-1:0',
		reviewSequence: 3,
		type: 'edit-context-item',
	}), true);
	assert.equal(isAiAssistPanelCommand({itemId: 'context-capture-1:0', reviewSequence: 3, type: 'remove-context-item'}), true);
	assert.equal(isAiAssistPanelCommand({
		itemId: 'review-image-1',
		processedHandleId: 'processed-image-1',
		reviewSequence: 3,
		type: 'include-reviewed-image',
	}), true);
	assert.equal(isAiAssistPanelCommand({
		itemId: 'review-image-1',
		processedHandleId: 'processed-image-1',
		reviewSequence: 3,
		type: 'remove-reviewed-image',
	}), true);
	assert.equal(isAiAssistPanelCommand({
		itemId: 'review-image-1',
		processedHandleId: 'processed-image-2',
		reviewSequence: 0,
		type: 'include-reviewed-image',
	}), false);
	assert.equal(isAiAssistPanelCommand({index: 0, type: 'remove-context-item'}), false);
	assert.equal(isAiAssistPanelCommand({itemId: 'context-capture-1:0', reviewSequence: 0, type: 'remove-context-item'}), false);
	assert.equal(isAiAssistMessengerCommand({
		kind: 'video',
		messageId: 'message-1',
		requestId: 'media-request-1',
		type: 'resolve-media',
	}), true);
	const insertionCommand = {
		answerGeneration: 3,
		authorizationToken: insertionToken,
		conversationId: 'messenger-thread:123',
		requestId: 'draft-insertion-request-1',
		text: 'Private answer',
		type: 'insert-draft',
	};
	assert.equal(isDraftInsertionAuthorizationCheck({
		answerGeneration: 3,
		authorizationToken: insertionToken,
		conversationId: 'messenger-thread:123',
		requestId: 'draft-insertion-request-1',
	}), true);
	assert.equal(isDraftInsertionAuthorizationCheck({
		answerGeneration: 3,
		authorizationToken: insertionToken,
		conversationId: 'messenger-thread:123',
		extra: true,
		requestId: 'draft-insertion-request-1',
	}), false);
	assert.equal(isAiAssistMessengerCommand({
		requestId: 'draft-insertion-request-1',
		type: 'cancel-draft-insertion',
	}), true);
	assert.equal(isAiAssistMessengerCommand(insertionCommand), true);
	assert.equal(isAiAssistMessengerCommand({...insertionCommand, text: ''}), false);
	assert.equal(isAiAssistMessengerEvent({
		answerGeneration: 3,
		authorizationToken: insertionToken,
		conversationId: 'messenger-thread:123',
		requestId: 'draft-insertion-request-1',
		status: 'inserted',
		type: 'draft-insertion',
	}), true);
	assert.equal(isAiAssistMessengerEvent({
		conversationId: 'messenger-thread:123',
		messageId: 'message-1',
		rectangle: {
			height: 40, width: 50, x: 10, y: 20,
		},
		requestId: 'image-target-request-1',
		status: 'available',
		targetToken: 'messenger-image-target-1',
		type: 'image-target-resolution',
		viewport: {height: 800, width: 1200},
	}), true);
	assert.equal(isAiAssistMessengerEvent({
		conversationId: 'messenger-thread:123',
		messageId: 'message-1',
		rectangle: {
			height: 5000, width: 5000, x: 0, y: 0,
		},
		requestId: 'image-target-request-1',
		status: 'available',
		targetToken: 'messenger-image-target-1',
		type: 'image-target-resolution',
		viewport: {height: 5000, width: 5000},
	}), false);
	assert.equal(isAiAssistMessengerEvent({
		reason: 'ambiguous-target',
		requestId: 'image-target-request-1',
		status: 'unavailable',
		type: 'image-target-resolution',
	}), true);
	assert.equal(isAiAssistMessengerEvent({
		reason: 'made-up',
		requestId: 'image-target-request-1',
		status: 'unavailable',
		type: 'image-target-resolution',
	}), false);
	assert.equal(isAiAssistMessengerEvent({
		answerGeneration: 3,
		authorizationToken: insertionToken,
		conversationId: 'messenger-thread:123',
		reason: 'draft-present',
		requestId: 'draft-insertion-request-1',
		status: 'blocked',
		type: 'draft-insertion',
	}), true);
	assert.equal(isAiAssistMessengerEvent({
		answerGeneration: 3,
		authorizationToken: insertionToken,
		conversationId: 'messenger-thread:123',
		reason: 'sent-anyway',
		requestId: 'draft-insertion-request-1',
		status: 'blocked',
		type: 'draft-insertion',
	}), false);
	assert.equal(isAiAssistMessengerCommand({type: 'report-conversation'}), true);
	assert.equal(isAiAssistMessengerCommand({
		requestId: 'conversation-report-1',
		type: 'report-conversation',
	}), true);
	assert.equal(isAiAssistMessengerCommand({type: 'set-enabled', enabled: 'yes'}), false);
	assert.equal(isAiAssistMessengerEvent({
		conversationId: 'messenger-thread:123',
		contextVersion: '3:message-3',
		requestId: 'conversation-report-1',
		status: 'available',
		type: 'conversation-state',
	}), true);
	assert.equal(isAiAssistMessengerEvent({
		contextVersion: '1:message-1',
		conversationId: 'messenger-thread:123',
		items: [anchorRequest.item],
		requestId: 'context-capture-1',
		requestedCount: 10,
		status: 'available',
		stopReason: 'no-more-history',
		type: 'context-capture',
	}), true);
	const rawBlobEvent = {
		byteLength: 3,
		bytes: new Uint8Array([1, 2, 3]).buffer,
		kind: 'audio',
		messageId: 'message-1',
		mimeType: 'audio/ogg',
		requestId: 'media-request-1',
		sourceType: 'blob',
		status: 'available',
		type: 'media-resolution',
	};
	assert.equal(isAiAssistMessengerEvent(rawBlobEvent), false);
	assert.equal(isMessengerMediaResolverRequest({
		byteLength: 3,
		bytes: new Uint8Array([1, 2, 3]).buffer,
		kind: 'audio',
		messageId: 'message-1',
		mimeType: 'audio/ogg',
		requestId: 'media-request-1',
		sourceType: 'blob',
	}), true);
	assert.equal(isMessengerMediaResolverRequest({
		byteLength: 0,
		bytes: new ArrayBuffer(0),
		kind: 'audio',
		messageId: 'message-1',
		mimeType: 'audio/ogg',
		requestId: 'media-request-1',
		sourceType: 'blob',
	}), false);
	const handleEvent = {
		byteLength: 3,
		handleId: '12345678-1234-1234-1234-123456789abc',
		kind: 'audio',
		messageId: 'message-1',
		mimeType: 'audio/ogg',
		requestId: 'media-request-1',
		sourceType: 'blob',
		status: 'available',
		type: 'media-resolution',
	};
	assert.equal(isAiAssistMessengerEvent(handleEvent), true);
	assert.equal(isAiAssistMessengerEvent({
		kind: 'video',
		messageId: 'message-1',
		byteLength: 3,
		handleId: '12345678-1234-1234-1234-123456789abc',
		mimeType: 'video/mp4',
		requestId: 'media-request-1',
		sourceType: 'https',
		status: 'available',
		type: 'media-resolution',
	}), true);
	assert.equal(isAiAssistMessengerEvent({
		kind: 'audio',
		messageId: 'message-1',
		requestId: 'media-request-1',
		sourceType: 'blob',
		status: 'unavailable',
		type: 'media-resolution',
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
	const panelStateWithHandle = {
		conversation: {captureGeneration: 2, status: 'ready'},
		contextCapturePending: false,
		contextWindowSize: 20,
		webSearchMode: 'always',
		credentials: {configured: true, secureStorageAvailable: true},
		enabled: true,
		history: {chats: [], query: '', status: 'ready'},
		media: {
			candidates: [],
			resolution: {
				byteLength: 3,
				handleId: handleEvent.handleId,
				kind: 'audio',
				messageId: 'message-1',
				mimeType: 'audio/ogg',
				sourceType: 'blob',
				status: 'ready',
			},
		},
		request: {},
		session: {generation: 1, status: 'open'},
	};
	assert.equal(isAiAssistPanelState(panelStateWithHandle), true);
	assert.equal(isAiAssistPanelState({
		...panelStateWithHandle,
		request: {
			answer: {
				text: 'private',
				webSearch: {
					citations: [], mode: 'off', ran: false, sources: [],
				},
			},
			insertion: {
				answerGeneration: 3,
				authorizationToken: insertionToken,
				conversationId: 'messenger-thread:123',
			},
		},
	}), true);
	assert.equal(isAiAssistPanelState({...panelStateWithHandle, contextCapturePending: 'yes'}), false);
	assert.equal(isAiAssistPanelState({...panelStateWithHandle, contextWindowSize: 12}), false);
	assert.equal(isAiAssistPanelState({...panelStateWithHandle, webSearchMode: 'sometimes'}), false);
	assert.equal(isAiAssistPanelState({
		...panelStateWithHandle,
		invocation: {prompt: 'Exact inline question', sequence: 1},
	}), true);
	assert.equal(isAiAssistPanelState({
		...panelStateWithHandle,
		anchor: {
			item: anchorRequest.item,
			loadedCount: anchorRequest.loadedCount,
			loadedIndex: anchorRequest.loadedIndex,
			sequence: 1,
		},
	}), true);
	assert.equal(isAiAssistPanelState({
		...panelStateWithHandle,
		review: {
			actualCount: 3,
			browsingMode: 'always',
			contextSource: 'current',
			editable: true,
			items: [{editedExcerpt: 'Reviewed excerpt', id: 'context-capture-1:0', item: anchorRequest.item}],
			locked: false,
			newMessagesAvailable: true,
			question: 'Exact question',
			requestedCount: 10,
			sequence: 1,
		},
	}), true);
	assert.equal(isAiAssistPanelState({
		...panelStateWithHandle,
		media: {
			...panelStateWithHandle.media,
			resolution: {...panelStateWithHandle.media.resolution, bytes: new ArrayBuffer(3)},
		},
	}), false);
});

test('captured message anchors detach and deeply freeze renderer data with the current snapshot', () => {
	const rendererAnchor = {
		item: {
			confidence: 'high',
			messageId: 'message-1',
			sender: {displayName: 'Alex', role: 'incoming'},
			text: 'Original',
		},
		loadedCount: 2,
		loadedIndex: 0,
	};
	const snapshot = {
		captureGeneration: 4,
		conversationId: 'messenger-thread:123',
		messengerWebContentsId: 9,
		sessionId: 'ai-session-1',
	};
	const captured = captureMessageAnchorSnapshot(rendererAnchor, snapshot);
	rendererAnchor.item.text = 'Mutated';

	assert.equal(captured.item.text, 'Original');
	assert.deepEqual(captured.snapshot, snapshot);
	assert.equal(Object.isFrozen(captured), true);
	assert.equal(Object.isFrozen(captured.item), true);
	assert.equal(Object.isFrozen(captured.item.sender), true);
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

test('conversation-bound answers never cross snapshot boundaries or revive', () => {
	const binding = new AiConversationBinding();
	const answer = new ConversationBoundAnswer();
	binding.reportAvailable('messenger-thread:111', 'Alex');
	const sessionA = binding.bind('ai-session-1', 7);

	assert.equal(answer.store('Answer for A', sessionA, binding.currentSnapshot), true);
	assert.equal(answer.read(binding.currentSnapshot), 'Answer for A');

	binding.reportAvailable('messenger-thread:222', 'Alex');
	assert.equal(answer.read(binding.currentSnapshot), undefined);
	answer.clear();
	const sessionB = binding.bind('ai-session-2', 7);
	assert.equal(answer.read(sessionB), undefined);

	binding.reportAvailable('messenger-thread:111', 'Alex');
	const newSessionA = binding.bind('ai-session-3', 7);
	assert.equal(answer.read(newSessionA), undefined);

	binding.reportUnavailable();
	assert.equal(answer.read(binding.currentSnapshot), undefined);
	answer.clear();
	binding.close();
	binding.reportAvailable('messenger-thread:111', 'Alex');
	const reopenedA = binding.bind('ai-session-4', 7);
	assert.equal(answer.read(reopenedA), undefined);

	assert.equal(answer.store('Late answer for A', sessionA, reopenedA), false);
	assert.equal(answer.read(reopenedA), undefined);
});

test('conversation reports are rejected until the replacement document is ready', () => {
	const gate = new ConversationReportGate();
	assert.equal(gate.acceptsReports, false);
	gate.markDocumentReady();
	assert.equal(gate.acceptsReports, true);
	gate.markNavigationStarted(true);
	assert.equal(gate.acceptsReports, true);
	gate.markNavigationStarted();
	assert.equal(gate.acceptsReports, false);
	gate.markDocumentReady();
	assert.equal(gate.acceptsReports, true);
});

test('panel clears stale prompts and hides stale answers outside ready state', async () => {
	const elements = new Map();
	let activeElement;
	const reviewCommands = [];
	const imageCommands = [];
	const insertCommands = [];
	const citationCommands = [];
	const webSearchModeCommands = [];
	const commandState = {current: undefined};
	const element = id => {
		if (!elements.has(id)) {
			const listeners = new Map();
			const children = [];
			elements.set(id, {
				attributes: new Map(),
				addEventListener(type, listener) {
					listeners.set(type, listener);
				},
				append(...nodes) {
					children.push(...nodes);
				},
				classList: {toggle() {}},
				children,
				dataset: {},
				disabled: false,
				focus() {
					activeElement = elements.get(id);
				},
				listeners,
				prepend(...nodes) {
					children.unshift(...nodes);
				},
				remove() {},
				textContent: '',
				setAttribute(name, value) {
					this.attributes.set(name, value);
				},
				value: '',
			});
		}

		return elements.get(id);
	};

	let renderState;
	let createdElements = 0;
	const context = {
		document: {
			get activeElement() {
				return activeElement;
			},
			createElement: tag => element(`${tag}-${++createdElements}`),
			querySelector: selector => element(selector.slice(1)),
		},
		window: {
			caprineCitationViewModel: undefined,
			caprineAiAssist: {
				async cancel() {},
				async close() {},
				async deleteApiKey() {},
				async editContextItem(...arguments_) {
					reviewCommands.push(['edit', ...arguments_]);
					return commandState.current;
				},
				async getState() {
					return new Promise(() => {});
				},
				async includeReviewedImage(...arguments_) {
					imageCommands.push(['include', ...arguments_]);
					return commandState.current;
				},
				async insertAnswer(...arguments_) {
					insertCommands.push(arguments_);
					return commandState.current;
				},
				async openCitation(url) {
					citationCommands.push(url);
				},
				onStateChanged(callback) {
					renderState = callback;
				},
				async refreshContext() {},
				async refreshConversation() {},
				async removeContextItem(...arguments_) {
					reviewCommands.push(['remove', ...arguments_]);
					return commandState.current;
				},
				async removeReviewedImage(...arguments_) {
					imageCommands.push(['remove-image', ...arguments_]);
					return commandState.current;
				},
				async resolveMedia() {},
				async saveApiKey() {},
				async setContextWindow() {},
				async setWebSearchMode(mode) {
					webSearchModeCommands.push(mode);
					return commandState.current;
				},
				async submitPrompt() {},
				async testApiKey() {},
			},
		},
	};
	context.URL = URL;
	vm.runInNewContext(
		readFileSync('static/ai-assist/citation-view-model.js', 'utf8'),
		context,
	);
	vm.runInNewContext(
		readFileSync('static/ai-assist/panel.js', 'utf8'),
		context,
	);

	const state = (status, captureGeneration, request = {}) => ({
		conversation: {captureGeneration, status},
		contextCapturePending: false,
		contextWindowSize: 20,
		webSearchMode: 'always',
		credentials: {configured: true, secureStorageAvailable: true},
		enabled: true,
		history: {chats: [], query: '', status: 'ready'},
		media: {candidates: []},
		request,
		session: {generation: 1, sessionId: 'ai-session-1', status: 'open'},
	});
	renderState(state('ready', 1));
	const prompt = element('prompt');
	assert.equal(element('context-window').value, '20');
	assert.equal(element('web-search-mode').value, 'always');
	commandState.current = {...state('ready', 1), webSearchMode: 'auto'};
	element('web-search-mode').value = 'auto';
	await element('web-search-mode').listeners.get('change')();
	assert.deepEqual(webSearchModeCommands, ['auto']);
	assert.equal(element('web-search-mode').value, 'auto');
	prompt.value = 'Question for A';
	prompt.listeners.get('input')();

	renderState(state('changed', 2, {
		answer: {
			text: 'Stale answer for A',
			webSearch: {
				citations: [], mode: 'off', ran: false, sources: [],
			},
		},
	}));
	assert.equal(prompt.value, '');
	assert.equal(element('answer-output').textContent, 'No answer yet.');

	renderState(state('ready', 3));
	assert.equal(prompt.value, '');
	assert.equal(element('ask-button').disabled, false);
	renderState({...state('ready', 3), contextCapturePending: true});
	assert.equal(element('context-window').disabled, true);
	assert.equal(element('refresh-context-button').disabled, true);
	assert.equal(element('ask-button').disabled, true);
	assert.equal(element('cancel-button').disabled, false);
	renderState({
		...state('ready', 3),
		review: {
			actualCount: 0,
			browsingMode: 'always',
			contextSource: 'historical-original',
			editable: false,
			items: [],
			locked: false,
			newMessagesAvailable: false,
			question: 'Historical question?',
			requestedCount: 10,
			sequence: 99,
		},
	});
	assert.equal(context.document.activeElement, element('ask-button'));
	assert.equal(prompt.disabled, true);
	assert.equal(element('context-window').disabled, true);
	assert.equal(element('web-search-mode').disabled, true);
	assert.equal(element('refresh-context-button').disabled, true);
	assert.equal(element('ask-button').disabled, false);
	renderState({
		...state('ready', 3),
		credentials: {configured: false, secureStorageAvailable: true},
		review: {
			actualCount: 0,
			browsingMode: 'always',
			contextSource: 'historical-original',
			editable: false,
			items: [],
			locked: false,
			newMessagesAvailable: false,
			question: 'Historical question?',
			requestedCount: 10,
			sequence: 100,
		},
	});
	assert.equal(element('ask-button').disabled, true);
	assert.equal(context.document.activeElement, element('api-key'));
	renderState({
		...state('ready', 3),
		review: {
			actualCount: 1,
			imageSelection: {aggregateBytes: 0, selectedCount: 0},
			images: [{
				byteLength: 4,
				height: 1,
				id: 'review-image-1',
				messageContext: 'Message with image',
				messageId: 'message-1',
				mimeType: 'image/png',
				processedHandleId: 'processed-image-1',
				senderLabel: 'Received from Alex',
				status: 'available',
				thumbnailDataUrl: 'data:image/png;base64,AQIDBA==',
				width: 1,
			}],
			items: [{
				id: 'context-capture-1:0',
				item: {
					confidence: 'high',
					messageId: 'message-1',
					sender: {role: 'incoming'},
					text: 'Reviewed context',
				},
			}],
			locked: false,
			newMessagesAvailable: false,
			question: '',
			requestedCount: 10,
			sequence: 1,
		},
	});
	assert.equal(element('ask-button').disabled, false);
	const editor = [...elements.entries()].find(([id]) => id.startsWith('textarea-'))[1];
	const elementCountAfterReview = createdElements;
	editor.value = 'Unsaved local redaction';
	editor.selectionStart = 8;
	editor.selectionEnd = 13;
	editor.focus();
	const unrelatedReviewState = {
		...state('ready', 3, {notice: 'Unrelated state update'}),
		review: {
			actualCount: 1,
			imageSelection: {aggregateBytes: 4, selectedCount: 1},
			images: [{
				byteLength: 4,
				height: 1,
				id: 'review-image-1',
				messageContext: 'Message with image',
				messageId: 'message-1',
				mimeType: 'image/png',
				processedHandleId: 'processed-image-1',
				senderLabel: 'Received from Alex',
				status: 'selected',
				thumbnailDataUrl: 'data:image/png;base64,AQIDBA==',
				width: 1,
			}],
			items: [{
				id: 'context-capture-1:0',
				item: {
					confidence: 'high',
					messageId: 'message-1',
					sender: {role: 'incoming'},
					text: 'Reviewed context',
				},
			}],
			locked: false,
			newMessagesAvailable: true,
			question: '',
			requestedCount: 10,
			sequence: 1,
		},
	};
	renderState(unrelatedReviewState);
	assert.equal(createdElements, elementCountAfterReview);
	assert.equal(editor.value, 'Unsaved local redaction');
	assert.equal(editor.selectionStart, 8);
	assert.equal(editor.selectionEnd, 13);
	assert.equal(context.document.activeElement, editor);
	assert.equal(element('context-items').children.length > 0, true);
	assert.equal(element('reviewed-images').children.length, 1);
	const thumbnail = [...elements.values()].find(node => node.alt === 'Processed image from Received from Alex');
	assert.equal(thumbnail.src, 'data:image/png;base64,AQIDBA==');
	assert.match(element('image-selection-summary').textContent, /1 selected · 4 bytes/);
	commandState.current = unrelatedReviewState;
	const removeButton = [...elements.values()].find(node => node.textContent === 'Remove');
	const saveButton = [...elements.values()].find(node => node.textContent === 'Save redaction');
	const imageRemoveButton = [...elements.values()].find(node => node.textContent === 'Remove' && node !== removeButton);
	await Promise.all([
		removeButton.listeners.get('click')(),
		removeButton.listeners.get('click')(),
		saveButton.listeners.get('click')(),
		imageRemoveButton.listeners.get('click')(),
	]);
	assert.deepEqual(reviewCommands, [
		['remove', 1, 'context-capture-1:0'],
		['remove', 1, 'context-capture-1:0'],
		['edit', 1, 'context-capture-1:0', 'Unsaved local redaction'],
	]);
	assert.deepEqual(imageCommands, [[
		'remove-image',
		1,
		'review-image-1',
		'processed-image-1',
	]]);
	renderState({
		...unrelatedReviewState,
		review: {...unrelatedReviewState.review, locked: true},
	});
	assert.equal(removeButton.disabled, true);
	assert.equal(saveButton.disabled, true);
	assert.equal(editor.disabled, true);
	assert.equal(imageRemoveButton.disabled, true);
	assert.equal(prompt.disabled, true);
	assert.equal(element('ask-button').disabled, true);
	assert.equal(element('ask-button').textContent, 'Asked — Refresh context to ask again');
	assert.equal(element('refresh-context-button').disabled, false);
	assert.match(element('context-availability').textContent, /locked Ask snapshot\. Use Refresh context to make changes/);
	const completedState = {
		...unrelatedReviewState,
		review: {...unrelatedReviewState.review, locked: true},
		request: {
			answer: {
				text: 'Cited answer',
				webSearch: {
					citations: [{
						contentIndex: 0,
						endIndex: 5,
						outputIndex: 1,
						providerEndIndex: 5,
						providerStartIndex: 0,
						startIndex: 0,
						title: 'Cited source',
						url: 'https://example.com/cited',
					}],
					mode: 'always',
					ran: true,
					sources: [{title: 'Uncited source', url: 'https://example.com/uncited'}],
				},
			},
			insertion: {
				answerGeneration: 3,
				authorizationToken: 'draft-insertion-token:00000000-0000-4000-8000-000000000001',
				conversationId: 'messenger-thread:alpha',
			},
		},
	};
	renderState(completedState);
	assert.equal(element('answer-search-status').textContent, 'Web search was used for this answer.');
	assert.equal(element('answer-sources').hidden, false);
	const citationMarker = [...elements.values()].find(node => node.className === 'citation-marker');
	const citationSource = [...elements.values()].find(node => node.className === 'citation-source');
	assert.equal(citationMarker.attributes.get('aria-label'), 'Open source 1 for cited text: Cited');
	assert.equal(citationSource.textContent, 'Cited source');
	assert.equal(citationSource.attributes.get('aria-label'), 'Open cited source 1: Cited source');
	assert.equal([...elements.values()].some(node => node.textContent === 'Uncited source'), false);
	await citationMarker.listeners.get('click')();
	assert.deepEqual(citationCommands, ['https://example.com/cited']);
	citationMarker.focus();
	const elementCountAfterAnswer = createdElements;
	renderState({...completedState, request: {...completedState.request, notice: 'Unrelated update'}});
	assert.equal(createdElements, elementCountAfterAnswer);
	assert.equal(context.document.activeElement, citationMarker);
	assert.equal(prompt.disabled, true);
	assert.equal(element('ask-button').disabled, true);
	assert.equal(element('insert-answer-button').disabled, false);
	commandState.current = completedState;
	await element('insert-answer-button').listeners.get('click')();
	assert.deepEqual(insertCommands, [[
		3,
		'draft-insertion-token:00000000-0000-4000-8000-000000000001',
		'messenger-thread:alpha',
	]]);
	renderState({
		...unrelatedReviewState,
		review: {...unrelatedReviewState.review, locked: true},
		request: {error: {code: 'provider-unavailable', message: 'Provider failed'}},
	});
	assert.equal(prompt.disabled, true);
	assert.equal(element('ask-button').disabled, true);
	renderState({
		...state('ready', 3),
		review: {
			actualCount: 2,
			items: [{
				id: 'context-capture-1:0',
				item: {
					confidence: 'high',
					messageId: 'message-1',
					sender: {role: 'incoming'},
					text: 'Reviewed context',
				},
			}, {
				id: 'context-capture-1:1',
				item: {
					confidence: 'low',
					omittedReason: 'unsupported-message',
					sender: {role: 'unknown'},
				},
			}],
			locked: false,
			newMessagesAvailable: false,
			question: '',
			requestedCount: 10,
			sequence: 1,
		},
	});
	assert.equal([...elements.keys()].filter(id => id.startsWith('textarea-')).length, 1);
	assert.equal([...elements.values()].some(node => node.textContent.includes('Not sent to OpenAI')), true);
	renderState({
		...state('ready', 3),
		review: {
			actualCount: 0,
			imageSelection: {
				aggregateBytes: 25 * 1024 * 1024,
				blockingNotice: 'Selected images exceed the 20 MB limit.',
				selectedCount: 2,
			},
			images: [{
				byteLength: 4,
				height: 1,
				id: 'review-image-1',
				messageContext: 'Removed image message',
				messageId: 'message-1',
				mimeType: 'image/png',
				processedHandleId: 'processed-image-1',
				senderLabel: 'Received from Alex',
				status: 'removed',
				thumbnailDataUrl: 'data:image/png;base64,AQIDBA==',
				width: 1,
			}, {
				failureReason: 'target hidden',
				id: 'review-image-2',
				messageContext: 'Capture failure message',
				messageId: 'message-2',
				senderLabel: 'Received from Alex',
				status: 'capture-failed',
			}, {
				failureReason: 'invalid output',
				id: 'review-image-3',
				messageContext: 'Normalization failure message',
				messageId: 'message-3',
				senderLabel: 'Sent by you',
				status: 'normalization-failed',
			}],
			items: [],
			locked: false,
			newMessagesAvailable: false,
			question: '',
			requestedCount: 10,
			sequence: 2,
		},
	});
	assert.equal([...elements.values()].some(node => node.textContent === 'Removed — temporary bytes released'), true);
	assert.equal([...elements.values()].some(node => node.textContent === 'Capture failed: target hidden'), true);
	assert.equal([...elements.values()].some(node => node.textContent === 'Normalization failed: invalid output'), true);
	assert.equal(element('image-selection-notice').textContent, 'Selected images exceed the 20 MB limit.');
	assert.equal(element('ask-button').disabled, true);
	renderState({
		...state('ready', 3),
		invocation: {prompt: 'Exact inline question', sequence: 1},
	});
	assert.equal(prompt.value, 'Exact inline question');
	prompt.value = 'Locally edited question';
	prompt.listeners.get('input')();
	renderState({
		...state('ready', 3),
		invocation: {prompt: 'Exact inline question', sequence: 1},
	});
	assert.equal(prompt.value, 'Locally edited question');
	renderState({
		...state('ready', 3),
		invocation: {prompt: '', sequence: 2},
	});
	assert.equal(prompt.value, '');
	prompt.value = 'Question for B';
	prompt.listeners.get('input')();
	renderState(state('ready', 4));
	assert.equal(prompt.value, '');
});

test('panel discloses web-search inputs and defaults the selector to Always', () => {
	const html = readFileSync('static/ai-assist/index.html', 'utf8');
	assert.match(html, /id="web-search-mode"/);
	assert.match(html, /<option value="always">Always — require a search<\/option>/);
	assert.match(html, /exact question and selected Messenger excerpts may be used to formulate web searches/);
});
