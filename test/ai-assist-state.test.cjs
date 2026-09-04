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
	isCurrentConversationRequestSnapshot,
} = require('../dist-js/ai-assist-state.js');
const {maximumHistoryTranscriptDtoCharacters} = require('../dist-js/ai-history-workspace.js');
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

const diagnostics = {
	aiEnabled: true,
	contextAdapter: 'healthy',
	copySequence: 1,
	historyDatabase: 'reachable',
	lastMediaError: 'none',
	lastProviderError: 'none',
	messengerConversation: 'healthy',
	openAiKey: 'configured',
	panel: 'loaded',
	videoTools: {ffmpeg: 'available', ffprobe: 'available'},
};

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
	assert.equal(isAiAssistPanelCommand({type: 'prepare-history-deletion', scope: 'all'}), true);
	assert.equal(isAiAssistPanelCommand({type: 'prepare-history-deletion', scope: 'conversation'}), true);
	assert.equal(isAiAssistPanelCommand({chatId: 'chat-1', type: 'prepare-history-deletion', scope: 'chat'}), true);
	assert.equal(isAiAssistPanelCommand({type: 'prepare-history-deletion', scope: 'chat'}), false);
	assert.equal(isAiAssistPanelCommand({chatId: 'chat-1', type: 'prepare-history-deletion', scope: 'all'}), false);
	assert.equal(isAiAssistPanelCommand({
		authorizationToken: 'history-deletion-token:one',
		type: 'confirm-history-deletion',
	}), true);
	assert.equal(isAiAssistPanelCommand({
		authorizationToken: 'wrong-prefix',
		type: 'cancel-history-deletion',
	}), false);
	assert.equal(isAiAssistPanelCommand({type: 'open'}), false);
	assert.equal(isAiAssistPanelCommand({type: 'close', extra: true}), false);
	assert.equal(isAiAssistPanelCommand({copySequence: 1, type: 'copy-diagnostics'}), true);
	assert.equal(isAiAssistPanelCommand({copySequence: 0, type: 'copy-diagnostics'}), false);
	assert.equal(isAiAssistPanelCommand({copySequence: 1, text: 'private', type: 'copy-diagnostics'}), false);
	assert.equal(isAiAssistPanelState({
		conversation: {captureGeneration: 2, displayName: 'Derek', status: 'ready'},
		contextCapturePending: false,
		contextWindowSize: 10,
		webSearchMode: 'always',
		credentials: {configured: true, secureStorageAvailable: true},
		diagnostics,
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
		conversation: {captureGeneration: 2, displayName: 'Derek', status: 'ready'},
		contextCapturePending: false,
		contextWindowSize: 10,
		webSearchMode: 'always',
		credentials: {configured: true, secureStorageAvailable: true},
		diagnostics,
		enabled: true,
		history: {
			chats: [],
			deletionConfirmation: {
				authorizationToken: 'history-deletion-token:one',
				confirmLabel: 'Delete all AI history',
				message: 'Exact scope',
				scope: 'all',
				title: 'Delete all?',
			},
			query: '',
			status: 'ready',
		},
		media: {candidates: []},
		request: {},
		session: {generation: 1, sessionId: 'ai-session-1', status: 'open'},
	}), true);
	assert.equal(isAiAssistPanelState({
		conversation: {captureGeneration: 2, status: 'ready'},
		contextCapturePending: false,
		contextWindowSize: 10,
		webSearchMode: 'always',
		credentials: {configured: true, secureStorageAvailable: true},
		enabled: true,
		history: {
			chats: [],
			deletionConfirmation: {authorizationToken: 'history-deletion-token:one', scope: 'all'},
			query: '',
			status: 'ready',
		},
		media: {candidates: []},
		request: {},
		session: {generation: 1, sessionId: 'ai-session-1', status: 'open'},
	}), false);
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
	assert.equal(isAiAssistPanelCommand({reviewSequence: 1, transcriptId: 'transcript:context-1', type: 'prepare-transcript'}), true);
	assert.equal(isAiAssistPanelCommand({reviewSequence: 1, transcriptId: 'transcript:context-1', type: 'transcribe-reviewed-media'}), true);
	assert.equal(isAiAssistPanelCommand({
		reviewSequence: 1,
		texts: ['Edited segment'],
		transcriptId: 'transcript:context-1',
		type: 'edit-transcript',
	}), true);
	assert.equal(isAiAssistPanelCommand({reviewSequence: 0, transcriptId: 'transcript:context-1', type: 'remove-transcript'}), false);
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
		type: 'focus-composer',
	}), true);
	assert.equal(isAiAssistMessengerCommand({
		conversationId: 'messenger-thread:123',
		prompt: 'private',
		type: 'focus-composer',
	}), false);
	assert.equal(isAiAssistMessengerCommand({
		conversationId: 'messenger-thread:123',
		requestId: 'context-capture-1',
		requestedCount: 20,
		type: 'capture-context',
	}), true);
	assert.equal(isAiAssistMessengerCommand({requestId: 'context-capture-1', type: 'cancel-context-capture'}), true);
	assert.equal(isAiAssistMessengerCommand({
		conversationId: 'messenger-thread:123',
		messageId: 'synthetic@$+/=_message-1',
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
		messageId: 'synthetic@$+/=_message-1',
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
	assert.equal(isAiAssistMessengerEvent({
		reason: 'message-rows-missing',
		requestId: 'context-capture-1',
		status: 'unavailable',
		type: 'context-capture',
	}), true);
	assert.equal(isAiAssistMessengerEvent({
		reason: 'private-dom-detail',
		requestId: 'context-capture-1',
		status: 'unavailable',
		type: 'context-capture',
	}), false);
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
		diagnostics,
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
			transcripts: [],
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

test('history state validator accepts bounded saved video evidence and rejects non-JPEG renderer payloads', () => {
	const videoArtifact = {
		coverage: 'balanced',
		durationSeconds: 10,
		focusedFrameCount: 2,
		keyframes: [{dataUrl: 'data:image/jpeg;base64,/9gB/9k=', timestampSeconds: 5}],
		sampledFrameCount: 12,
		timeline: [{
			description: 'A cup appears', endSeconds: 6, startSeconds: 4, timestamps: [5],
		}],
		transcript: [{endSeconds: 2, startSeconds: 1, text: 'Reviewed words'}],
		uncertaintyNotes: [],
	};
	const state = {
		conversation: {captureGeneration: 2, displayName: 'Derek', status: 'ready'},
		contextCapturePending: false,
		contextWindowSize: 10,
		credentials: {configured: true, secureStorageAvailable: true},
		diagnostics,
		enabled: true,
		history: {
			chats: [{
				badges: ['Video'],
				contextCount: 0,
				createdAt: 1,
				id: 'chat-video',
				interactionCount: 1,
				interactions: [{
					answer: 'Answer [Video 00:05].',
					artifacts: [],
					browsingMode: 'off',
					citations: [],
					completedAt: 2,
					context: [],
					draftStatus: 'not-inserted',
					id: 'interaction-video',
					model: 'gpt-5.6-luna',
					originalReplay: {available: true},
					question: 'What happens?',
					shareStatus: 'private',
					videoArtifact,
					webSearchRan: false,
				}],
				lastActivityAt: 2,
				preview: 'Answer',
				title: 'Question',
			}],
			query: '',
			selectedChatId: 'chat-video',
			status: 'ready',
		},
		media: {candidates: []},
		request: {},
		session: {generation: 1, sessionId: 'ai-session-1', status: 'open'},
		webSearchMode: 'always',
	};
	assert.equal(isAiAssistPanelState(state), true);
	const reviewedTranscript = {
		durationSeconds: 2,
		editedSegments: [{endSeconds: 2, startSeconds: 0, text: 'Edited words'}],
		id: 'transcript:voice',
		kind: 'audio',
		originalSegments: [{endSeconds: 2, startSeconds: 0, text: 'Original words'}],
		senderLabel: 'Voice message from Alex',
		status: 'included',
	};
	const withReviewedTranscript = structuredClone(state);
	withReviewedTranscript.history.chats[0].interactions[0].reviewedTranscripts = [reviewedTranscript];
	assert.equal(isAiAssistPanelState(withReviewedTranscript), true);
	withReviewedTranscript.history.chats[0].interactions[0].reviewedTranscripts[0].mediaSha256 = 'ab'.repeat(32);
	assert.equal(isAiAssistPanelState(withReviewedTranscript), false);
	const oversizedTranscript = structuredClone(state);
	oversizedTranscript.history.chats[0].interactions[0].reviewedTranscripts = [{
		...reviewedTranscript,
		editedSegments: undefined,
		originalSegments: [{
			endSeconds: 2, startSeconds: 0, text: 'x'.repeat(maximumHistoryTranscriptDtoCharacters + 1),
		}],
	}];
	assert.equal(isAiAssistPanelState(oversizedTranscript), false);
	assert.equal(isAiAssistPanelState({
		...state,
		history: {
			...state.history,
			chats: [{
				...state.history.chats[0],
				interactions: [{
					...state.history.chats[0].interactions[0],
					videoArtifact: {
						...videoArtifact,
						keyframes: [{dataUrl: 'data:text/html;base64,PHNjcmlwdD4=', timestampSeconds: 5}],
					},
				}],
			}],
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

test('panel refocus preserves request state only for the exact current snapshot', () => {
	const binding = new AiConversationBinding();
	binding.reportAvailable('messenger-thread:111', 'Alex');
	const snapshot = binding.bind('ai-session-1', 7);

	assert.equal(binding.reportAvailable('messenger-thread:111', 'Alex updated'), false);
	assert.equal(isCurrentConversationRequestSnapshot(
		snapshot,
		binding.currentSnapshot,
		7,
		'ai-session-1',
	), true);
	for (const changedSnapshot of [
		undefined,
		{...snapshot, captureGeneration: snapshot.captureGeneration + 1},
		{...snapshot, conversationId: 'messenger-thread:222'},
		{...snapshot, messengerWebContentsId: 8},
		{...snapshot, sessionId: 'ai-session-2'},
	]) {
		assert.equal(isCurrentConversationRequestSnapshot(
			snapshot,
			changedSnapshot,
			7,
			'ai-session-1',
		), false);
	}

	assert.equal(isCurrentConversationRequestSnapshot(
		snapshot,
		binding.currentSnapshot,
		8,
		'ai-session-1',
	), false);
	assert.equal(isCurrentConversationRequestSnapshot(
		snapshot,
		binding.currentSnapshot,
		7,
		'ai-session-2',
	), false);

	binding.reportAvailable('messenger-thread:222', 'Sam');
	assert.equal(isCurrentConversationRequestSnapshot(
		snapshot,
		binding.currentSnapshot,
		7,
		'ai-session-1',
	), false);
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

function createPanelFixture() {
	const elements = new Map();
	let activeElement;
	const reviewCommands = [];
	const imageCommands = [];
	const insertCommands = [];
	const citationCommands = [];
	const webSearchModeCommands = [];
	const historyDeletionCommands = [];
	const transcriptCommands = [];
	const submitCommands = [];
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
				close() {
					this.open = false;
				},
				closest(selector) {
					if (selector === 'details') {
						if (id === 'api-key') {
							return element('settings-details');
						}

						if (['refresh-context-button', 'refresh-conversation-button', 'context-review-details > summary'].includes(id)) {
							return element('context-review-details');
						}
					}

					return undefined;
				},
				children,
				dataset: {},
				disabled: false,
				focus() {
					if (!this.disabled) {
						activeElement = elements.get(id);
					}
				},
				listeners,
				open: false,
				prepend(...nodes) {
					children.unshift(...nodes);
				},
				remove() {},
				textContent: '',
				setAttribute(name, value) {
					this.attributes.set(name, value);
				},
				showModal() {
					this.open = true;
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
				async cancelTranscription(...arguments_) {
					transcriptCommands.push(['cancel', ...arguments_]);
					return commandState.current;
				},
				async cancelHistoryDeletion(token) {
					historyDeletionCommands.push(['cancel', token]);
					return commandState.current;
				},
				async close() {},
				async confirmHistoryDeletion(token) {
					historyDeletionCommands.push(['confirm', token]);
					return commandState.current;
				},
				async deleteApiKey() {},
				async editContextItem(...arguments_) {
					reviewCommands.push(['edit', ...arguments_]);
					return commandState.current;
				},
				async editTranscript(...arguments_) {
					transcriptCommands.push(['edit', arguments_[0], arguments_[1], [...arguments_[2]]]);
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
				async prepareHistoryDeletion(scope, chatId) {
					historyDeletionCommands.push(['prepare', scope, chatId]);
					return commandState.current;
				},
				async prepareTranscript(...arguments_) {
					transcriptCommands.push(['prepare', ...arguments_]);
					return commandState.current;
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
				async removeTranscript(...arguments_) {
					transcriptCommands.push(['remove', ...arguments_]);
					return commandState.current;
				},
				async resolveMedia() {},
				async saveApiKey() {},
				async setContextWindow() {},
				async setWebSearchMode(mode) {
					webSearchModeCommands.push(mode);
					return commandState.current;
				},
				async submitPrompt(prompt) {
					submitCommands.push(prompt);
					return commandState.current;
				},
				async testApiKey() {},
				async transcribeReviewedMedia(...arguments_) {
					transcriptCommands.push(['transcribe', ...arguments_]);
					return commandState.current;
				},
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
		diagnostics: {
			...diagnostics,
			contextAdapter: status === 'ready' ? 'healthy' : 'degraded',
			messengerConversation: status === 'ready' ? 'healthy' : 'degraded',
		},
		enabled: true,
		history: {chats: [], query: '', status: 'ready'},
		media: {candidates: []},
		request,
		session: {generation: 1, sessionId: 'ai-session-1', status: 'open'},
	});
	return {
		citationCommands,
		commandState,
		context,
		get createdElements() {
			return createdElements;
		},
		element,
		elements,
		historyDeletionCommands,
		imageCommands,
		insertCommands,
		renderState,
		reviewCommands,
		state,
		submitCommands,
		transcriptCommands,
		webSearchModeCommands,
	};
}

test('unsupported HTTPS media is not misreported as a segmented player', () => {
	const {element, renderState, state} = createPanelFixture();
	for (const sourceType of ['https', 'segmented']) {
		renderState({...state('ready', 1), media: {candidates: [], resolution: {kind: 'video', status: 'unsupported', sourceType}}});
		const message = element('media-status').textContent;
		assert.equal(message.includes('segmented or MediaSource'), sourceType === 'segmented');
		if (sourceType === 'https') {
			assert.match(message, /complete video file could not be found/);
		}
	}
});

test('private-prompt Reel uses the primary button for prepare, consent, then Ask', async () => {
	const {
		commandState, element, renderState, state, submitCommands, transcriptCommands,
	} = createPanelFixture();
	const prompt = '幫我總結 https://www.facebook.com/reel/1744555046768453';
	const transcript = {
		contextItemId: 'review:prompt-reel',
		id: 'transcript:prompt-reel',
		kind: 'video',
		messageId: 'prompt-reel-1744555046768453',
		senderLabel: 'Facebook Reel from private prompt',
		status: 'available',
	};
	const review = {
		actualCount: 1,
		browsingMode: 'auto',
		contextSource: 'current',
		editable: true,
		imageSelection: {aggregateBytes: 0, selectedCount: 0},
		images: [],
		items: [],
		locked: false,
		newMessagesAvailable: false,
		question: prompt,
		requestedCount: 10,
		sequence: 1,
		transcripts: [transcript],
	};
	const availableState = {...state('ready', 1), review};
	const readyState = {...availableState, review: {...review, transcripts: [{...transcript, notice: undefined, status: 'ready'}]}};
	const completedState = {
		...availableState,
		review: {
			...review,
			transcripts: [{
				...transcript,
				notice: undefined,
				originalSegments: [{endSeconds: 1, startSeconds: 0, text: 'Transcript'}],
				status: 'completed',
			}],
		},
	};
	const submit = element('prompt-form').listeners.get('submit');
	const event = {preventDefault() {}};
	// Electron structured clone preserves explicitly cleared optional fields.
	// The preload must accept the state before the renderer can advance its button.
	assert.equal(isAiAssistPanelState(structuredClone(readyState)), true);
	assert.equal(isAiAssistPanelState(structuredClone(completedState)), true);

	renderState(state('ready', 1));
	element('prompt').value = prompt;
	element('prompt').listeners.get('input')();
	commandState.current = readyState;
	renderState(availableState);
	assert.equal(element('context-review-details').open, true);
	assert.equal(element('ask-button').textContent, 'Prepare Reel audio');
	element('context-review-details').open = false;
	renderState({...availableState, request: {notice: 'Unrelated update'}});
	assert.equal(element('context-review-details').open, false);
	await submit(event);
	assert.equal(element('context-review-details').open, true);
	assert.deepEqual(transcriptCommands, [['prepare', 1, transcript.id]]);
	assert.equal(element('ask-button').textContent, 'Transcribe and review Reel');

	commandState.current = completedState;
	await submit(event);
	assert.deepEqual(transcriptCommands, [
		['prepare', 1, transcript.id],
		['transcribe', 1, transcript.id],
	]);
	assert.equal(element('ask-button').textContent, 'Ask with reviewed context');

	commandState.current = completedState;
	await submit(event);
	assert.deepEqual(submitCommands, [prompt]);
});

test('transcript IPC accepts cleared optional fields but rejects unknown or malformed fields', () => {
	const {state} = createPanelFixture();
	const transcript = {
		contextItemId: 'review:prompt-reel',
		id: 'transcript:prompt-reel',
		kind: 'video',
		messageId: 'prompt-reel-1744555046768453',
		senderLabel: 'Facebook Reel from private prompt',
		status: 'available',
	};
	const panelState = item => structuredClone({
		...state('ready', 1),
		review: {
			actualCount: 0, browsingMode: 'off', contextSource: 'current', editable: true, items: [], locked: false,
			newMessagesAvailable: false, question: 'Summarize this Reel', requestedCount: 20,
			sequence: 1, transcripts: [item],
		},
	});
	assert.equal(isAiAssistPanelState(panelState(transcript)), true);
	const optionalFields = ['byteLength', 'durationSeconds', 'editedSegments', 'mimeType', 'notice', 'originalSegments'];
	for (const field of optionalFields) {
		assert.equal(isAiAssistPanelState(panelState({...transcript, [field]: undefined})), true, field);
		assert.equal(isAiAssistPanelState(panelState({...transcript, [field]: null})), false, field);
	}

	for (const status of ['preparing', 'ready', 'extracting', 'transcribing', 'failed', 'canceled', 'removed', 'timed-out', 'unsupported', 'oversized', 'no-audio']) {
		assert.equal(isAiAssistPanelState(panelState({...transcript, notice: undefined, status})), true, status);
	}

	const {completeReviewedTranscript} = require('../dist-js/reviewed-transcripts.js');
	const completed = completeReviewedTranscript(transcript, {
		byteLength: 1234, durationSeconds: 2, mimeType: 'audio/mpeg',
		segments: [{startSeconds: 0, endSeconds: 2, text: 'Fixture transcript'}],
	});
	assert.equal(Object.hasOwn(completed, 'notice'), true);
	assert.equal(isAiAssistPanelState(panelState(completed)), true);
	assert.equal(isAiAssistPanelState(panelState({...transcript, unexpected: undefined})), false);
	assert.equal(isAiAssistPanelState(panelState({...transcript, notice: 'x'.repeat(1001)})), false);
	assert.equal(isAiAssistPanelState(panelState({...completed, originalSegments: undefined})), false);
	assert.equal(isAiAssistPanelState(panelState({...completed, editedSegments: [{startSeconds: 0, endSeconds: 3, text: 'Wrong times'}]})), false);
});

test('panel initial focus leaves Context review collapsed across initial states', async t => {
	const review = {
		actualCount: 0,
		editable: true,
		items: [],
		locked: false,
		newMessagesAvailable: false,
		question: '',
		requestedCount: 10,
		sequence: 1,
	};
	const summary = 'context-review-details > summary';
	await Promise.all([
		{name: 'ready without review', status: 'ready', focus: 'prompt'},
		{name: 'conversation not ready', status: 'unavailable', focus: summary},
		{
			name: 'context loading', status: 'ready', update: {contextCapturePending: true}, focus: 'prompt',
		},
		{
			name: 'existing review', status: 'ready', update: {review}, focus: 'prompt',
		},
		{
			name: 'slash ai invocation', status: 'ready', update: {invocation: {sequence: 1, prompt: 'Private question'}}, focus: 'prompt',
		},
		{
			name: 'invocation with review', status: 'ready', update: {review, invocation: {sequence: 1, prompt: 'Private question'}}, focus: 'prompt',
		},
		{
			name: 'locked review', status: 'ready', update: {review: {...review, locked: true}}, focus: summary,
		},
		{
			name: 'request in progress', status: 'ready', update: {session: {status: 'requesting'}}, focus: summary,
		},
		{
			name: 'key not configured', status: 'ready', update: {credentials: {configured: false, secureStorageAvailable: true}}, focus: 'prompt',
		},
	].map(scenario => t.test(scenario.name, () => {
		const {context, element, renderState, state} = createPanelFixture();
		const initial = {...state(scenario.status, 1), ...scenario.update};
		renderState(initial);
		assert.equal(element('context-review-details').open, false);
		assert.equal(element('context-message-details').open, false);
		assert.equal(context.document.activeElement, element(scenario.focus));
		assert.equal(context.document.activeElement.disabled, false);
		if (initial.invocation) {
			assert.equal(element('prompt').value, initial.invocation.prompt);
		}

		// State updates must not override the user's disclosure or focus choice.
		element('context-review-details').open = true;
		element('close-button').focus();
		renderState({...initial, request: {notice: 'Unrelated update'}});
		assert.equal(element('context-review-details').open, true);
		assert.equal(context.document.activeElement, element('close-button'));
		element('context-review-details').open = false;
		renderState({...initial, conversation: {status: 'ready', captureGeneration: 1}});
		assert.equal(element('context-review-details').open, false);
		assert.equal(context.document.activeElement, element('close-button'));
	})));
});

test('removing the last reviewed item still reveals and focuses Refresh context', async () => {
	const {commandState, context, element, elements, renderState, reviewCommands, state} = createPanelFixture();
	const initial = {
		...state('ready', 1),
		review: {
			actualCount: 1,
			editable: true,
			items: [{id: 'review:0', item: {sender: {role: 'incoming'}, text: 'Synthetic excerpt', confidence: 'high'}}],
			locked: false,
			question: '',
			requestedCount: 10,
			sequence: 1,
		},
	};
	renderState(initial);
	element('context-review-details').open = true;
	element('context-message-details').open = true;
	const remove = [...elements.values()].find(node => node.textContent === 'Remove');
	remove.focus();
	commandState.current = {
		...initial, review: {
			...initial.review, actualCount: 0, items: [], sequence: 2,
		},
	};
	const removal = remove.listeners.get('click')();
	// The user can collapse the section while the local command is pending.
	element('context-review-details').open = false;
	await removal;
	assert.deepEqual(reviewCommands, [['remove', 1, 'review:0']]);
	assert.equal(element('context-review-details').open, true);
	assert.equal(context.document.activeElement, element('refresh-context-button'));
});

test('panel clears stale prompts and hides stale answers outside ready state', async () => {
	const panel = createPanelFixture();
	const {
		citationCommands, commandState, context, element, elements, historyDeletionCommands,
		imageCommands, insertCommands, renderState, reviewCommands, state, transcriptCommands, webSearchModeCommands,
	} = panel;
	renderState(state('ready', 1));
	const prompt = element('prompt');
	assert.equal(element('context-window').value, '20');
	assert.equal(element('web-search-mode').value, 'always');
	assert.equal(element('context-message-details').open, false);
	assert.equal(element('context-message-summary').textContent, 'Context messages (0)');
	const confirmationState = {
		...state('ready', 1),
		history: {
			chats: [],
			deletionConfirmation: {
				authorizationToken: 'history-deletion-token:ui',
				confirmLabel: 'Delete all AI history',
				message: 'Delete every local chat, but no Messenger messages.',
				scope: 'all',
				title: 'Delete all local AI history?',
			},
			query: '',
			status: 'ready',
		},
	};
	renderState(confirmationState);
	assert.equal(element('history-deletion-dialog').open, true);
	assert.equal(element('history-deletion-title').textContent, 'Delete all local AI history?');
	assert.equal(element('history-deletion-message').textContent, 'Delete every local chat, but no Messenger messages.');
	assert.equal(context.document.activeElement, element('cancel-history-deletion-button'));
	commandState.current = state('ready', 1);
	await element('cancel-history-deletion-button').listeners.get('click')();
	assert.deepEqual(historyDeletionCommands, [['cancel', 'history-deletion-token:ui']]);
	assert.equal(element('history-deletion-dialog').open, false);
	assert.equal(context.document.activeElement, element('new-history-chat-button'));
	const escapeState = {
		...confirmationState,
		history: {
			...confirmationState.history,
			deletionConfirmation: {
				...confirmationState.history.deletionConfirmation,
				authorizationToken: 'history-deletion-token:escape',
			},
		},
	};
	renderState(escapeState);
	let defaultPrevented = false;
	await element('history-deletion-dialog').listeners.get('cancel')({
		preventDefault() {
			defaultPrevented = true;
		},
	});
	assert.equal(defaultPrevented, true);
	assert.deepEqual(historyDeletionCommands.at(-1), ['cancel', 'history-deletion-token:escape']);
	assert.equal(element('history-deletion-dialog').open, false);
	const historyState = {
		...state('ready', 1),
		history: {
			chats: [{
				badges: [],
				contextCount: 0,
				id: 'chat-1',
				interactionCount: 0,
				interactions: [],
				lastActivityAt: 1,
				preview: 'No questions yet',
				title: 'New AI chat',
			}],
			query: '',
			selectedChatId: 'chat-1',
			status: 'ready',
		},
	};
	commandState.current = historyState;
	renderState(historyState);
	await element('clear-conversation-history-button').listeners.get('click')();
	await element('clear-all-history-button').listeners.get('click')();
	const deleteChatButton = [...elements.values()].find(node => node.textContent === 'Delete this AI chat');
	await deleteChatButton.listeners.get('click')();
	assert.deepEqual(historyDeletionCommands.slice(-3), [
		['prepare', 'conversation', undefined],
		['prepare', 'all', undefined],
		['prepare', 'chat', 'chat-1'],
	]);
	const currentDeleteChatButton = [...elements.values()]
		.filter(node => node.textContent === 'Delete this AI chat')
		.at(-1);
	const chatConfirmationState = {
		...historyState,
		history: {
			...historyState.history,
			deletionConfirmation: {
				authorizationToken: 'history-deletion-token:chat',
				confirmLabel: 'Delete AI chat',
				message: 'Delete this local AI chat, but no Messenger messages.',
				scope: 'chat',
				title: 'Delete this local AI chat?',
			},
		},
	};
	commandState.current = chatConfirmationState;
	await currentDeleteChatButton.listeners.get('click')();
	assert.equal(context.document.activeElement, element('cancel-history-deletion-button'));
	commandState.current = historyState;
	await element('cancel-history-deletion-button').listeners.get('click')();
	const restoredDeleteChatButton = [...elements.values()]
		.filter(node => node.textContent === 'Delete this AI chat')
		.at(-1);
	assert.notEqual(restoredDeleteChatButton, currentDeleteChatButton);
	assert.equal(context.document.activeElement, restoredDeleteChatButton);
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
	assert.equal(element('context-message-summary').textContent, 'Context messages (0) · Show review details');
	assert.equal(prompt.disabled, true);
	assert.equal(element('context-window').disabled, true);
	assert.equal(element('web-search-mode').disabled, true);
	assert.equal(element('refresh-context-button').disabled, true);
	assert.equal(element('ask-button').disabled, false);
	renderState({
		...state('ready', 3),
		review: {
			actualCount: 1,
			browsingMode: 'always',
			contextSource: 'historical-original',
			editable: false,
			items: [],
			locked: false,
			newMessagesAvailable: false,
			question: 'Original saved-video question?',
			requestedCount: 10,
			sequence: 150,
		},
		videoAnalysis: {
			coverage: 'balanced',
			frameCount: 2,
			phase: 'preprocessing',
			status: 'ready',
			transcriptAvailable: true,
		},
	});
	assert.equal(prompt.disabled, false);
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
	assert.equal(element('settings-details').open, true);
	assert.equal(context.document.activeElement, element('api-key'));
	renderState({
		...state('ready', 3),
		review: {
			actualCount: 1,
			browsingMode: 'always',
			contextSource: 'current',
			editable: false,
			items: [],
			locked: false,
			newMessagesAvailable: false,
			question: 'First video question',
			requestedCount: 20,
			sequence: 101,
		},
		videoAnalysis: {
			coverage: 'balanced',
			focusedFrameCount: 4,
			frameCount: 24,
			phase: 'pass-2',
			status: 'ready',
			transcriptAvailable: true,
		},
	});
	assert.equal(prompt.disabled, false);
	assert.equal(element('context-window').disabled, true);
	assert.equal(element('web-search-mode').disabled, true);
	assert.equal(element('refresh-context-button').disabled, false);
	assert.equal(element('ask-button').disabled, false);
	renderState({
		...state('ready', 3),
		review: {
			actualCount: 1,
			editable: true,
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
	assert.equal(element('context-message-details').open, false);
	assert.equal(element('context-message-summary').textContent, 'Context messages (1) · Show to review or redact');
	element('context-message-details').open = true;
	assert.equal(element('ask-button').disabled, false);
	const editor = [...elements.entries()].find(([id]) => id.startsWith('textarea-'))[1];
	const elementCountAfterReview = panel.createdElements;
	editor.value = 'Unsaved local redaction';
	editor.selectionStart = 8;
	editor.selectionEnd = 13;
	editor.focus();
	const unrelatedReviewState = {
		...state('ready', 3, {notice: 'Unrelated state update'}),
		review: {
			actualCount: 1,
			editable: true,
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
	assert.equal(element('context-message-details').open, true);
	assert.equal(panel.createdElements, elementCountAfterReview);
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
	assert.equal(element('context-message-details').open, true);
	assert.equal(element('context-message-summary').textContent, 'Context messages (1) · Show review details');
	assert.equal(removeButton.disabled, true);
	assert.equal(saveButton.disabled, true);
	assert.equal(editor.disabled, true);
	assert.equal(imageRemoveButton.disabled, true);
	assert.equal(prompt.disabled, true);
	assert.equal(element('ask-button').disabled, true);
	assert.equal(element('ask-button').textContent, 'Asked — Refresh context to ask again');
	assert.equal(element('refresh-context-button').disabled, false);
	assert.match(element('context-availability').textContent, /locked Ask snapshot\. Use Refresh context to make changes/);
	const transcriptBase = {
		byteLength: 4096,
		contextItemId: 'context-capture-2:0',
		durationSeconds: 2.5,
		id: 'transcript:context-capture-2:0',
		kind: 'audio',
		messageId: 'message-voice',
		mimeType: 'audio/ogg',
		senderLabel: 'Voice message received from Alex',
	};
	const transcriptReviewState = {
		...state('ready', 3),
		review: {
			actualCount: 1,
			browsingMode: 'always',
			contextSource: 'current',
			editable: true,
			imageSelection: {aggregateBytes: 0, selectedCount: 0},
			images: [],
			items: [{
				id: 'context-capture-2:0',
				item: {
					attachments: [{kind: 'audio'}],
					confidence: 'high',
					messageId: 'message-voice',
					sender: {displayName: 'Alex', role: 'incoming'},
				},
			}],
			locked: false,
			newMessagesAvailable: false,
			question: 'Review voice',
			requestedCount: 10,
			sequence: 2,
			transcripts: [{...transcriptBase, status: 'ready'}],
		},
	};
	commandState.current = transcriptReviewState;
	renderState(transcriptReviewState);
	assert.equal(element('context-message-details').open, false);
	const transcribeButton = [...elements.values()].find(node => node.textContent === 'Transcribe and review');
	assert.ok(transcribeButton);
	assert.equal(transcribeButton.disabled, false);
	assert.ok([...elements.values()].some(node => node.textContent === 'This media will be sent to OpenAI for transcription'));
	assert.ok([...elements.values()].some(node => /2\.5 seconds · 4,096 bytes · audio\/ogg/.test(node.textContent)));
	await transcribeButton.listeners.get('click')();
	assert.deepEqual(transcriptCommands.at(-1), ['transcribe', 2, 'transcript:context-capture-2:0']);
	const transcribingState = {
		...transcriptReviewState,
		review: {
			...transcriptReviewState.review,
			transcripts: [{...transcriptBase, status: 'transcribing'}],
		},
	};
	commandState.current = transcribingState;
	renderState(transcribingState);
	assert.equal(transcribeButton.textContent, 'Cancel transcription');
	await transcribeButton.listeners.get('click')();
	assert.deepEqual(transcriptCommands.at(-1), ['cancel', 2, 'transcript:context-capture-2:0']);
	const videoTranscript = {
		...transcriptBase,
		id: 'transcript:context-capture-2:video',
		kind: 'video',
		messageId: 'message-video',
		mimeType: 'video/mp4',
		senderLabel: 'Video received from Alex',
		status: 'extracting',
	};
	const extractingState = {
		...transcriptReviewState,
		review: {
			...transcriptReviewState.review,
			transcripts: [videoTranscript],
		},
	};
	commandState.current = extractingState;
	renderState(extractingState);
	const cancelExtractionButton = [...elements.values()].find(node => node.textContent === 'Cancel extraction');
	assert.ok(cancelExtractionButton);
	assert.match([...elements.values()].find(node => /Extracting bounded video audio locally/.test(node.textContent)).textContent, /Nothing has been sent/);
	await cancelExtractionButton.listeners.get('click')();
	assert.deepEqual(transcriptCommands.at(-1), ['cancel', 2, 'transcript:context-capture-2:video']);
	const noAudioState = {
		...extractingState,
		review: {
			...extractingState.review,
			transcripts: [{...videoTranscript, notice: 'No audio track. The video remains available for visual processing.', status: 'no-audio'}],
		},
	};
	commandState.current = noAudioState;
	renderState(noAudioState);
	assert.ok([...elements.values()].some(node => node.textContent === 'No audio track. The video remains available for visual processing.'));
	const completedTranscriptState = {
		...transcriptReviewState,
		review: {
			...transcriptReviewState.review,
			transcripts: [{
				...transcriptBase,
				originalSegments: [
					{endSeconds: 1.25, startSeconds: 0, text: 'First segment'},
					{endSeconds: 2.5, startSeconds: 1.25, text: 'Second segment'},
				],
				status: 'completed',
			}],
		},
	};
	commandState.current = completedTranscriptState;
	renderState(completedTranscriptState);
	assert.ok([...elements.values()].some(node => node.textContent === '00:00.000–00:01.250'));
	const firstTranscriptEditor = [...elements.values()].find(node => node.attributes.get('aria-label') === 'Edit transcript segment 1');
	firstTranscriptEditor.value = 'Edited first segment';
	const saveTranscriptButton = [...elements.values()].reverse().find(node => node.textContent === 'Save transcript edits');
	const removeTranscriptButton = [...elements.values()].reverse().find(node => node.textContent === 'Remove transcript');
	await saveTranscriptButton.listeners.get('click')();
	await removeTranscriptButton.listeners.get('click')();
	assert.deepEqual(transcriptCommands.slice(-2), [
		['edit', 2, 'transcript:context-capture-2:0', ['Edited first segment', 'Second segment']],
		['remove', 2, 'transcript:context-capture-2:0'],
	]);
	const removedTranscriptState = {
		...transcriptReviewState,
		review: {
			...transcriptReviewState.review,
			transcripts: [{...transcriptBase, status: 'removed'}],
		},
	};
	commandState.current = removedTranscriptState;
	renderState(removedTranscriptState);
	commandState.current = completedTranscriptState;
	renderState(completedTranscriptState);
	const rebuiltTranscriptEditor = [...elements.values()].find(node => node.attributes.get('aria-label') === 'Edit transcript segment 1' && node.value === 'First segment');
	assert.ok(rebuiltTranscriptEditor);
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
	assert.equal(citationMarker.attributes.get('aria-label'), 'Open cited source 1');
	assert.equal(citationSource.textContent, 'Cited source');
	assert.equal(citationSource.attributes.get('aria-label'), 'Open cited source 1: Cited source');
	assert.equal([...elements.values()].some(node => node.textContent === 'Uncited source'), false);
	await citationMarker.listeners.get('click')();
	assert.deepEqual(citationCommands, ['https://example.com/cited']);
	citationMarker.focus();
	const elementCountAfterAnswer = panel.createdElements;
	renderState({...completedState, request: {...completedState.request, notice: 'Unrelated update'}});
	assert.equal(panel.createdElements, elementCountAfterAnswer);
	assert.equal(context.document.activeElement, citationMarker);
	assert.equal(prompt.disabled, true);
	assert.equal(element('ask-button').disabled, true);
	assert.equal(element('insert-answer-button').disabled, false);
	const retryState = {
		...completedState,
		request: {
			...completedState.request,
			insertion: {
				...completedState.request.insertion,
				authorizationToken: 'draft-insertion-token:00000000-0000-4000-8000-000000000002',
			},
			notice: 'Messenger already contains draft text. It was preserved. Clear it, then try again.',
		},
	};
	commandState.current = retryState;
	await element('insert-answer-button').listeners.get('click')();
	assert.equal(element('insert-answer-button').disabled, false);
	await element('insert-answer-button').listeners.get('click')();
	assert.deepEqual(insertCommands, [
		[
			3,
			'draft-insertion-token:00000000-0000-4000-8000-000000000001',
			'messenger-thread:alpha',
		],
		[
			3,
			'draft-insertion-token:00000000-0000-4000-8000-000000000002',
			'messenger-thread:alpha',
		],
	]);
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
	assert.equal([...elements.values()].some(node => node.attributes.get('aria-label') === 'Edit message 2 excerpt'), false);
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
	const quickRun = {
		id: 'synthetic-run', createdAt: 1000, appVersion: 'test', model: 'test', browsingMode: 'off', contextCount: 10,
		question: '<script>untrusted question</script>', prompt: 'Frozen synthetic input', answer: 'Saved synthetic answer',
		outcome: 'send-uncertain', contextJson: '{}',
		events: [{
			at: 1100, stage: 'answer-send', status: 'unknown', code: 'send-result-unknown',
		}],
	};
	const quickState = {
		...state('ready', 5), quickMode: true,
		history: {
			status: 'ready', query: '', selectedChatId: 'quick-chat',
			chats: [{
				id: 'quick-chat', title: 'Quick run', preview: '', badges: [], contextCount: 0, lastActivityAt: 1100, interactionCount: 0, interactions: [], quickRuns: [quickRun],
			}],
		},
	};
	renderState(quickState);
	assert.equal(element('quick-mode').checked, true);
	const failedNotice = 'Quick mode stopped: quote-unavailable (reply). No automatic retry.';
	renderState({...quickState, request: {...quickState.request, notice: failedNotice}});
	assert.equal(element('session-status').textContent, failedNotice, 'a stopped quick run must not look like normal manual review');
	assert.equal([...elements.values()].some(node => node.textContent === quickRun.question), true);
	assert.equal([...elements.values()].some(node => node.textContent === 'Open for manual review (no resend)'), true);
	assert.equal([...elements.values()].some(node => node.textContent === '+100 ms · answer-send: unknown (send-result-unknown)'), true);
	assert.equal([...elements.values()].some(node => node.textContent === 'No completed model interaction. Inspect the quick-run stages above.'), true);
	quickRun.outcome = 'running';
	renderState(quickState);
	assert.equal(element('ask-button').disabled, true);
	assert.equal(element('cancel-button').disabled, false);
});

test('panel discloses web-search inputs and defaults the selector to Always', () => {
	const html = readFileSync('static/ai-assist/index.html', 'utf8');
	assert.match(html, /id="web-search-mode"/);
	assert.match(html, /<option value="always">Always — require a search<\/option>/);
	assert.match(html, /exact question and selected Messenger excerpts may be used to formulate web searches/);
});
