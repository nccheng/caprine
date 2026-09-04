const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const test = require('node:test');
const {restoreContextReviewSnapshot, buildReviewedPrompt} = require('../dist-js/context-review.js');
const {AiHistoryStore} = require('../dist-js/ai-history-store.js');
const {executeQuickMessengerAction} = require('../dist-js/ai-quick-messenger.js');
const {resolveQuickReplyTarget, quickObservedMessageIds} = require('../dist-js/ai-quick-dom.js');
const {parseAiComposerCommand} = require('../dist-js/ai-composer-command.js');
const {MessengerContextFixtureElement: Element} = require('./helpers/messenger-context-fixture.cjs');

// Exercise the real controller methods without constructing windows, opening a
// real database, loading Electron, reading a key, or contacting a provider.
function loadController() {
	const modulePath = path.resolve('dist-js/ai-assist.js');
	const localRequire = createRequire(modulePath);
	const settings = {
		aiAssistEnabled: true, aiAssistQuickMode: true, aiAssistWebSearchMode: 'off', aiAssistContextWindowSize: 10,
		aiAssistOpenAiKeyCiphertext: 'fixture-only-ciphertext',
	};
	const mocks = {
		electron: {app: {getVersion: () => 'test'}},
		'./config': {
			get: key => settings[key], set(key, value) {
				settings[key] = value;
			},
		},
		'./messenger-image-normalization': {},
		'./reviewed-images': {
			finalizeReviewedImageSelection: items => ({items, releasedHandleIds: []}),
			reviewedImageSelectionSummary: () => ({aggregateBytes: 0, selectedCount: 0}),
			withSelectedReviewedImageInputs: async ({run}) => run([]),
		},
	};
	const exports = {};
	vm.runInNewContext(`${readFileSync(modulePath, 'utf8')}\nexports.ControllerForTest = AiAssistController;`, {
		exports, require: id => Object.hasOwn(mocks, id) ? mocks[id] : localRequire(id),
		console, Buffer, URL, AbortController, structuredClone, setTimeout, clearTimeout,
	}, {filename: modulePath});
	return exports.ControllerForTest;
}

function deferred() {
	let resolve;
	const promise = new Promise(done => {
		resolve = done;
	});
	return {promise, resolve};
}

function fixture(report = deferred(), response = deferred()) {
	const Controller = loadController();
	const controller = Object.create(Controller.prototype);
	const counts = {
		provider: 0, persisted: 0, stored: 0, authorized: 0,
	};
	const snapshot = {
		captureGeneration: 1, conversationId: 'messenger-thread:fixture', messengerWebContentsId: 1, sessionId: 'fixture-session',
	};
	const run = {
		id: 'run-1', chatId: 'chat-1', conversationId: snapshot.conversationId, createdAt: 1, updatedAt: 1,
		appVersion: 'test', model: 'test', browsingMode: 'off', contextCount: 10,
		question: 'fixture', prompt: 'fixture prompt', answer: '', outcome: 'running',
		events: [{at: 1, stage: 'model', status: 'started'}],
	};
	Object.assign(controller, {
		quickRun: {run, snapshot}, requestCounter: 0, answerGeneration: 0, reviewSequence: 0, invocationSequence: 0,
		promptReelUrls: new Map(),
		conversationLifecycle: {snapshot: 1, isCurrent: () => true},
		requestConversationState: () => report.promise,
		conversationBinding: {currentSnapshot: snapshot},
		sessionState: {snapshot: {status: 'open'}, beginRequest() {}, completeRequest() {}},
		isRequestSnapshotCurrent: () => true,
		clearAnswer() {}, clearContextReview() {}, broadcastState() {}, cancelPendingContextCapture() {}, notifyMessenger() {},
		readApiKey: () => 'fixture-only-key',
		historyStore: {updateQuickRun() {}}, diagnosticsHealth: {historyFailed() {}},
		persistCompletedInteraction(answer, frozenReview) {
			counts.persisted++;
			counts.savedReview = frozenReview;
			return 'interaction-1';
		},
		answer: {
			store() {
				counts.stored++;
				return true;
			},
		},
		draftInsertionAuthorization: {
			issue() {
				counts.authorized++;
			},
		},
		openAiClient: {
			createResponse(key, prompt, mode, options) {
				counts.provider++;
				counts.signal = options.signal;
				counts.prompt = prompt;
				counts.mode = mode;
				return response.promise;
			},
		},
	});
	return {
		controller, counts, report, response, run, snapshot,
	};
}

const answer = {
	text: 'fixture answer', webSearch: {
		mode: 'off', ran: false, citations: [], sources: [],
	},
};
const options = {isConnectionTest: false, quickRunId: 'run-1', searchMode: 'off'};

test('Quick-mode Reel composer command opens private review instead of starting a public run', async () => {
	const f = fixture();
	f.controller.quickRun = undefined;

	const calls = {
		focus: 0, refresh: [], review: [], show: 0, startQuick: 0,
	};
	f.controller.showPanelWindow = () => {
		calls.show += 1;
	};

	f.controller.panelReady = Promise.resolve(true);
	f.controller.panelWindow = {
		focus() {
			calls.focus += 1;
		},
		isDestroyed: () => false,
		show() {
			calls.show += 1;
		},
	};

	f.controller.refreshConversation = async (...arguments_) => {
		calls.refresh.push(arguments_);
	};

	f.controller.requestContextReview = async question => {
		calls.review.push(question);
	};

	f.controller.startQuickRun = () => {
		calls.startQuick += 1;
	};

	const prompt = '幫我總結這個影片 https://www.facebook.com/reel/1744555046768453';
	const accepted = await f.controller.acceptComposerCommand({conversationId: f.snapshot.conversationId, prompt});
	assert.equal(accepted, true, JSON.stringify(calls));
	await new Promise(resolve => {
		setImmediate(resolve);
	});

	assert.equal(calls.startQuick, 0);
	assert.deepEqual(calls.refresh, [[]]);
	assert.deepEqual(calls.review, [prompt]);
	assert.equal(calls.show, 2);
	assert.equal(calls.focus, 1);
	assert.equal(f.controller.invocation.prompt, prompt);
	assert.match(f.controller.notice, /moved here without being sent to Messenger/);
});

test('cancel while waiting for conversation authority prevents the provider request', async () => {
	const f = fixture();
	const pending = f.controller.runOpenAiRequest('fixture prompt', options);
	f.controller.cancelQuickRun('cancelled');
	f.report.resolve(1);
	f.response.resolve(answer);
	await pending;
	assert.deepEqual(f.counts, {
		provider: 0, persisted: 0, stored: 0, authorized: 0,
	});
	assert.equal(f.controller.quickRun.run.outcome, 'cancelled');
});

test('disabling an active quick run aborts its provider and rejects late success', async () => {
	const f = fixture();
	const pending = f.controller.runOpenAiRequest('fixture prompt', options);
	f.report.resolve(1);
	await new Promise(resolve => {
		setImmediate(resolve);
	});
	assert.equal(f.counts.provider, 1);
	f.controller.cancelQuickRun('disabled');
	f.response.resolve(answer); // Deliberately ignore abort in the fake provider.
	await pending;
	assert.equal(f.counts.signal.aborted, true);
	assert.equal(f.counts.persisted, 0);
	assert.equal(f.counts.stored, 0);
	assert.equal(f.counts.authorized, 0);
	assert.equal(f.controller.quickRun.run.events.at(-1).code, 'disabled');
});

test('provider persistence uses the submitted frozen review even if the panel review changes', async () => {
	const f = fixture();
	const frozenReview = restoreContextReviewSnapshot({
		actualCount: 0, contextVersion: 'fixture', images: [], items: [], newMessagesAvailable: false,
		question: 'Original question', requestedCount: 10, snapshot: f.snapshot, transcripts: [],
	});
	const prompt = buildReviewedPrompt(frozenReview);
	const pending = f.controller.runOpenAiRequest(prompt, {...options, frozenReview});
	f.controller.review = {snapshot: {...frozenReview, question: 'Different panel input'}};
	f.report.resolve(1);
	f.response.resolve(answer);
	await pending;
	assert.equal(f.counts.prompt, prompt);
	assert.equal(f.counts.mode, 'off');
	assert.equal(f.counts.savedReview, frozenReview);
	assert.equal(f.counts.savedReview.question, 'Original question');
});

test('manual recovery restores original input and saved answer without a request or send', () => {
	const f = fixture();
	const savedContext = {
		actualCount: 0, contextVersion: 'fixture', items: [], question: f.run.question, requestedCount: 10,
	};
	const savedRun = {
		...f.run, answer: answer.text, contextJson: JSON.stringify(savedContext), outcome: 'send-uncertain',
	};
	f.controller.quickRun = undefined;
	f.controller.historyStore.loadQuickRuns = (conversationId, chatId) => conversationId === f.snapshot.conversationId && chatId === 'chat-1' ? [savedRun] : [];
	f.controller.recoverQuickRun('chat-1', 'run-1');
	assert.equal(f.controller.review.snapshot.question, f.run.question);
	assert.equal(f.controller.review.locked, false);
	assert.equal(f.counts.provider, 0);
	assert.equal(f.counts.persisted, 0);
	assert.equal(f.counts.stored, 1);
	assert.equal(f.counts.authorized, 1);
	assert.match(f.controller.notice, /Nothing was sent or requested again/);
	f.controller.recoverQuickRun('other-chat', 'run-1');
	assert.equal(f.counts.authorized, 1);
});

test('quick invocation can bind a conversation without opening the manual panel', async () => {
	const f = fixture();
	let opened = 0;
	let bound = 0;
	f.controller.clearMediaState = () => {};
	f.controller.clearConversationBoundRequestState = () => {};
	f.controller.sessionState.open = () => {
		opened++;
	};

	f.controller.bindCurrentConversation = () => {
		bound++;
	};

	f.report.resolve(1);
	await f.controller.refreshConversation(undefined, true);
	assert.equal(opened, 1);
	assert.equal(bound, 1);
	assert.equal(f.controller.panelWindow, undefined);
});

test('oversized provider input remains a terminal inspectable failure with frozen context', async () => {
	const f = fixture();
	const store = new AiHistoryStore({databasePath: ':memory:'});
	const question = 'Summarize the discussion';
	const frozen = restoreContextReviewSnapshot({
		actualCount: 1, contextVersion: 'fixture', images: [], newMessagesAvailable: false, question,
		requestedCount: 10, snapshot: f.snapshot, transcripts: [],
		items: [{
			id: 'context-1', item: {
				confidence: 'high', messageId: 'message-1', sender: {role: 'incoming'}, text: 'x'.repeat(19_990),
			},
		}],
	});
	const prompt = buildReviewedPrompt(frozen);
	assert.ok(prompt.length > 20_000);
	f.controller.quickRun = undefined;
	f.controller.historyStore = store;
	f.controller.requestContextReview = async () => {
		f.controller.review = {snapshot: frozen};
	};

	f.controller.showPanelWindow = () => {};
	let sends = 0;
	f.controller.quickMessengerAction = async () => {
		sends++;
	};

	try {
		await f.controller.startQuickRun(question, f.snapshot);
		const chat = store.loadConversationSummaries(f.snapshot.conversationId)[0];
		const saved = store.loadQuickRuns(f.snapshot.conversationId, chat.id)[0];
		assert.equal(saved.outcome, 'failed');
		assert.equal(saved.events.at(-1).code, 'input-too-large');
		assert.equal(saved.prompt, prompt);
		assert.equal(JSON.parse(saved.contextJson).items[0].item.text.length, 19_990);
		assert.equal(f.counts.provider, 0);
		assert.equal(sends, 0);
		assert.equal(f.controller.quickRun, undefined);
	} finally {
		store.close();
	}
});

test('manual Reel submission without prepared video evidence stays editable and never reaches the provider', async () => {
	const f = fixture();
	const question = '幫我總結這個影片';
	const frozen = restoreContextReviewSnapshot({
		actualCount: 1, contextVersion: 'fixture', images: [], newMessagesAvailable: false, question,
		requestedCount: 10, snapshot: f.snapshot,
		transcripts: [{
			contextItemId: 'different-video', id: 'transcript:different-video', kind: 'video',
			messageId: 'message-video',
			originalSegments: [{endSeconds: 1, startSeconds: 0, text: 'Unrelated completed transcript'}],
			senderLabel: 'Video received from Alex', status: 'completed',
		}],
		items: [{
			id: 'context-reel', item: {
				attachments: [{kind: 'video'}], confidence: 'high',
				linkPreview: {
					domain: 'facebook.com', url: 'https://www.facebook.com/reel/1744555046768453',
				},
				sender: {role: 'incoming'},
			},
		}],
	});
	f.controller.quickRun = undefined;
	f.controller.reviewedImageCapture = undefined;
	f.controller.review = {
		browsingMode: 'auto', contextSource: 'current', editable: true, locked: false,
		sequence: 1, snapshot: frozen,
	};
	f.controller.videoArtifacts = new Map();
	let broadcasts = 0;
	f.controller.broadcastState = () => {
		broadcasts++;
	};

	await f.controller.submitReviewedPrompt(question);

	assert.equal(f.counts.provider, 0);
	assert.equal(f.counts.persisted, 0);
	assert.equal(f.controller.review.locked, false);
	assert.match(f.controller.notice, /Facebook Reel detected/);
	assert.match(f.controller.notice, /Nothing was sent to OpenAI\.$/);
	assert.equal(broadcasts, 1);
});

test('Ask refreshes an existing review when its private question adds a Reel URL', async () => {
	const f = fixture();
	const reelUrl = 'https://www.facebook.com/reel/1744555046768453';
	f.controller.quickRun = undefined;
	f.controller.reviewedImageCapture = undefined;
	f.controller.promptReelUrls = new Map();
	f.controller.review = {
		browsingMode: 'auto', contextSource: 'current', editable: true, locked: false,
		sequence: 1,
		snapshot: restoreContextReviewSnapshot({
			actualCount: 0, contextVersion: 'fixture', images: [], items: [], newMessagesAvailable: false,
			question: '', requestedCount: 10, snapshot: f.snapshot, transcripts: [],
		}),
	};
	let refreshed;
	f.controller.requestContextReview = async (question, anchorMessageId) => {
		refreshed = {anchorMessageId, question};
	};

	await f.controller.submitReviewedPrompt(`幫我總結這個影片 ${reelUrl}`);

	assert.deepEqual(refreshed, {anchorMessageId: undefined, question: `幫我總結這個影片 ${reelUrl}`});
	assert.equal(f.counts.provider, 0);
	assert.equal(f.counts.persisted, 0);
});

test('a Reel URL in the private prompt becomes explicit reviewable video evidence', async () => {
	const f = fixture();
	const reelId = '1744555046768453';
	const reelUrl = `https://www.facebook.com/reel/${reelId}`;
	let resolved = 0;
	f.controller.quickRun = undefined;
	f.controller.mediaCandidates = [];
	f.controller.promptReelUrls = new Map();
	f.controller.diagnosticsHealth = {
		contextHealthy() {},
	};
	f.controller.pendingContextCapture = {
		contextSource: 'current',
		question: `幫我總結這個影片 ${reelUrl}`,
		requestId: 'context-capture-reel',
		requestedCount: 10,
		resolve() {
			resolved++;
		},
		snapshot: f.snapshot,
	};

	await f.controller.handleContextCapture({
		contextVersion: 'fixture-reel',
		conversationId: f.snapshot.conversationId,
		items: [],
		requestId: 'context-capture-reel',
		requestedCount: 10,
		status: 'available',
		stopReason: 'no-more-history',
		type: 'context-capture',
	});

	assert.equal(resolved, 1);
	assert.equal(f.controller.review.snapshot.items.length, 1);
	assert.equal(f.controller.review.snapshot.items[0].item.linkPreview.url, reelUrl);
	assert.equal(f.controller.review.snapshot.items[0].item.messageId, `prompt-reel-${reelId}`);
	assert.deepEqual(
		[...f.controller.promptReelUrls],
		[[`prompt-reel-${reelId}`, reelUrl]],
	);
	assert.equal(f.controller.review.snapshot.transcripts.length, 1);
	assert.equal(f.controller.review.snapshot.transcripts[0].kind, 'video');
	assert.equal(f.controller.review.snapshot.transcripts[0].status, 'available');
	assert.equal(f.controller.review.snapshot.transcripts[0].senderLabel, 'Facebook Reel from private prompt');
	assert.match(f.controller.notice, /Select Prepare video audio, then Transcribe and review, before Ask/);
});

test('a private-prompt Reel already present in Messenger is labeled for the primary workflow', async () => {
	const f = fixture();
	const reelId = '1744555046768453';
	const reelUrl = `https://www.facebook.com/reel/${reelId}`;
	f.controller.quickRun = undefined;
	f.controller.mediaCandidates = [];
	f.controller.promptReelUrls = new Map();
	f.controller.diagnosticsHealth = {
		contextHealthy() {},
	};
	f.controller.pendingContextCapture = {
		contextSource: 'current',
		question: `幫我總結這個影片 ${reelUrl}`,
		requestId: 'context-capture-existing-reel',
		requestedCount: 10,
		resolve() {},
		snapshot: f.snapshot,
	};

	await f.controller.handleContextCapture({
		contextVersion: 'fixture-existing-reel',
		conversationId: f.snapshot.conversationId,
		items: [{
			attachments: [{kind: 'video'}],
			confidence: 'high',
			linkPreview: {domain: 'facebook.com', title: 'Facebook Reel', url: reelUrl},
			messageId: 'messenger-reel-message',
			sender: {displayName: 'You', role: 'self'},
		}],
		requestId: 'context-capture-existing-reel',
		requestedCount: 10,
		status: 'available',
		stopReason: 'no-more-history',
		type: 'context-capture',
	});

	assert.deepEqual([...f.controller.promptReelUrls], [['messenger-reel-message', reelUrl]]);
	assert.equal(f.controller.review.snapshot.transcripts.length, 1);
	assert.equal(f.controller.review.snapshot.transcripts[0].messageId, 'messenger-reel-message');
	assert.equal(f.controller.review.snapshot.transcripts[0].senderLabel, 'Facebook Reel from private prompt');
});

test('preparing a private-prompt Reel resolves it in the trusted main process', async () => {
	const f = fixture();
	const messageId = 'prompt-reel-1744555046768453';
	const reelUrl = 'https://www.facebook.com/reel/1744555046768453';
	let messengerRequests = 0;
	let resolved;
	f.controller.quickRun = undefined;
	f.controller.mediaCleanupReady = Promise.resolve();
	f.controller.mediaRequestCounter = 0;
	f.controller.pendingMediaRequests = new Map();
	f.controller.promptReelUrls = new Map([[messageId, reelUrl]]);
	f.controller.notifyMessenger = () => {
		messengerRequests++;
	};

	f.controller.mediaResolver = {
		async releaseAll() {},
		async releaseHandle() {},
		async resolveFacebookReel(...parameters) {
			const [url, resolvedMessageId, snapshot, durationSeconds, signal] = parameters;
			resolved = {
				durationSeconds, resolvedMessageId, signal, snapshot, url,
			};
			return {
				byteLength: 1234,
				handleId: 'media-handle',
				kind: 'video',
				messageId: resolvedMessageId,
				mimeType: 'video/mp4',
				sourceType: 'https',
			};
		},
	};

	await f.controller.resolveMedia(messageId, 'video', {kind: 'video', messageId});

	assert.equal(messengerRequests, 0);
	assert.equal(resolved.url, reelUrl);
	assert.equal(resolved.resolvedMessageId, messageId);
	assert.equal(resolved.snapshot, f.snapshot);
	assert.equal(resolved.signal.aborted, false);
	assert.equal(f.controller.pendingMediaRequests.size, 0);
	assert.equal(f.controller.mediaResolution.status, 'ready');
	assert.equal(f.controller.mediaResolution.handleId, 'media-handle');
});

test('premature Ask preserves a prepared Reel handle for Transcribe and review', async () => {
	const f = fixture();
	const reelUrl = 'https://www.facebook.com/reel/1744555046768453';
	const transcriptId = 'transcript:context-reel';
	f.controller.quickRun = undefined;
	f.controller.reviewedImageCapture = undefined;
	f.controller.promptReelUrls = new Map([['message-video', reelUrl]]);
	f.controller.videoArtifacts = new Map();
	f.controller.transcriptHandles = new Map([[transcriptId, {
		handleId: 'media-handle', messageId: 'message-video', reviewSequence: 1, snapshot: f.snapshot,
	}]]);
	f.controller.review = {
		browsingMode: 'auto', contextSource: 'current', editable: true, locked: false,
		sequence: 1,
		snapshot: restoreContextReviewSnapshot({
			actualCount: 1, contextVersion: 'fixture', images: [], newMessagesAvailable: false,
			question: `幫我總結這個影片 ${reelUrl}`, requestedCount: 10, snapshot: f.snapshot,
			transcripts: [{
				contextItemId: 'context-reel', id: transcriptId, kind: 'video', messageId: 'message-video',
				senderLabel: 'Facebook Reel from private prompt', status: 'ready',
			}],
			items: [{
				id: 'context-reel', item: {
					attachments: [{kind: 'video'}], confidence: 'high', messageId: 'message-video',
					linkPreview: {domain: 'facebook.com', url: reelUrl}, sender: {role: 'unknown'},
				},
			}],
		}),
	};

	await f.controller.submitReviewedPrompt(`請分析 ${reelUrl}`);

	assert.equal(f.controller.review.sequence, 1);
	assert.equal(f.controller.transcriptHandles.get(transcriptId).reviewSequence, 1);
	assert.equal(f.controller.review.snapshot.transcripts[0].status, 'ready');
	assert.match(f.controller.notice, /no reviewed video evidence is prepared/);
	assert.equal(f.counts.provider, 0);
});

test('Quick mode rejects a Reel before sending the question or contacting the provider', async () => {
	const f = fixture();
	const store = new AiHistoryStore({databasePath: ':memory:'});
	const question = 'Summarize this';
	const frozen = restoreContextReviewSnapshot({
		actualCount: 1, contextVersion: 'fixture', images: [], items: [{
			id: 'context-reel', item: {
				attachments: [{kind: 'video'}], confidence: 'high',
				linkPreview: {
					domain: 'facebook.com', url: 'https://www.facebook.com/reel/1744555046768453',
				},
				sender: {role: 'incoming'},
			},
		}], newMessagesAvailable: false,
		question, requestedCount: 10, snapshot: f.snapshot, transcripts: [],
	});
	f.controller.quickRun = undefined;
	f.controller.historyStore = store;
	f.controller.requestContextReview = async () => {
		f.controller.review = {snapshot: frozen};
	};

	f.controller.showPanelWindow = () => {};
	let sends = 0;
	f.controller.quickMessengerAction = async () => {
		sends++;
	};

	try {
		await f.controller.startQuickRun(question, f.snapshot);
		const chat = store.loadConversationSummaries(f.snapshot.conversationId)[0];
		const saved = store.loadQuickRuns(f.snapshot.conversationId, chat.id)[0];
		assert.equal(saved.outcome, 'failed');
		assert.equal(saved.events.at(-1).stage, 'context');
		assert.equal(saved.events.at(-1).code, 'unsupported-media');
		assert.equal(saved.questionMessageId, undefined);
		assert.equal(f.counts.provider, 0);
		assert.equal(sends, 0);
		assert.match(f.controller.notice, /Facebook Reel detected/);
		assert.match(f.controller.notice, /did not send the question or answer/);
		assert.equal(f.controller.quickRun, undefined);
	} finally {
		store.close();
	}
});

test('opening the inspection panel preserves the active quick run; explicit cancellation still aborts', async () => {
	const f = fixture();
	const pending = f.controller.runOpenAiRequest('fixture prompt', options);
	f.report.resolve(1);
	await new Promise(resolve => {
		setImmediate(resolve);
	});
	f.controller.clearMediaState = () => {};
	f.controller.clearConversationBoundRequestState = () => f.controller.cancelActiveRequest();
	f.controller.showPanelWindow = () => {
		f.controller.panelWindow = {isDestroyed: () => false};
	};

	f.controller.open();
	await new Promise(resolve => {
		setImmediate(resolve);
	});
	assert.equal(f.controller.quickRun.run.outcome, 'running');
	assert.equal(f.counts.signal.aborted, false);
	f.controller.cancelQuickRun('cancelled');
	assert.equal(f.controller.quickRun.run.outcome, 'cancelled');
	assert.equal(f.counts.signal.aborted, true);
	f.response.resolve(answer);
	await pending;
	assert.equal(f.counts.persisted, 0);
});

test('two identical slash questions wait for native IDs and complete quoted, attributed replies without manual review', async () => {
	const f = fixture();
	const store = new AiHistoryStore({databasePath: ':memory:'});
	const question = '再次測試';
	const messages = [{
		id: 'mid.older-question', text: question, element: {}, article: new Element(),
	}];
	const sent = [];
	const composer = {text: '', quote: undefined};
	let pendingAcknowledgement;
	f.controller.quickRun = undefined;
	f.controller.historyStore = store;
	f.controller.refreshConversation = async () => {};
	f.controller.showPanelWindow = () => {
		throw new Error('Quick flow opened manual fallback');
	};

	f.controller.answer.read = () => answer;
	f.controller.draftInsertionAuthorization.invalidate = () => {};
	f.controller.requestContextReview = async prompt => {
		f.controller.review = {
			snapshot: restoreContextReviewSnapshot({
				actualCount: 0, contextVersion: 'fixture', images: [], items: [], newMessagesAvailable: false,
				question: prompt, requestedCount: 10, snapshot: f.snapshot, transcripts: [],
			}),
		};
	};

	f.report.resolve(1);
	f.response.resolve(answer);
	f.controller.quickMessengerAction = async (phase, text) => {
		const action = {
			phase, text, runId: f.controller.quickRun.run.id, token: 'fixture-token', conversationId: f.snapshot.conversationId,
			...(phase === 'answer' ? {replyToMessageId: f.controller.quickRun.run.questionMessageId} : {}),
		};
		return executeQuickMessengerAction(action, {
			currentConversationId: () => f.snapshot.conversationId,
			isCurrent: () => true, resolveComposer: () => composer, isEditable: () => true,
			readText: c => c.text, hasAttachment: () => false, hasReply: c => c.quote !== undefined,
			async prepareReply(id) {
				const original = resolveQuickReplyTarget(messages, id);
				if (!original) {
					return false;
				}

				composer.quote = original.id;
				return true;
			},
			replyMatches: id => composer.quote === id,
			insertText(c, value) {
				c.text = value;
			},
			canSend: () => true, authorizeSend: async () => true,
			send(c) {
				const message = {
					id: String(sent.length + 1), text: c.text, replyTo: c.quote, element: {},
					article: new Element({
						children: c.quote === undefined ? [] : [
							{attributes: {role: 'button', 'aria-label': '前往已回覆的訊息'}, children: [{attributes: {dir: 'auto'}, text: question}]},
						],
					}),
				};
				messages.push(message);
				sent.push(message);
				pendingAcknowledgement = {message, ticks: 0};
				c.text = '';
				c.quote = undefined;
			},
			messageIds: () => new Set(messages.map(message => message.id)),
			observe: (before, value, replyTo) => quickObservedMessageIds(messages, before, value, replyTo ? question : undefined),
			async settle() {
				if (pendingAcknowledgement) {
					if (pendingAcknowledgement.message.replyTo === undefined) {
						assert.equal(f.counts.provider, Math.floor(sent.length / 2), 'model must wait for a native question ID');
					}

					if (++pendingAcknowledgement.ticks === 3) {
						pendingAcknowledgement.message.id = `1000@msgr.${pendingAcknowledgement.message.id}`;
						pendingAcknowledgement = undefined;
					}
				}
			},
		});
	};

	let pending;
	const start = f.controller.startQuickRun.bind(f.controller);
	f.controller.startQuickRun = (...arguments_) => {
		pending = start(...arguments_);
		return pending;
	};

	try {
		for (let index = 0; index < 2; index++) {
			const command = parseAiComposerCommand(`/ai ${question}`);
			// eslint-disable-next-line no-await-in-loop
			assert.equal(await f.controller.acceptComposerCommand({conversationId: f.snapshot.conversationId, prompt: command.prompt}), true);
			// eslint-disable-next-line no-await-in-loop
			await pending;
			assert.equal(f.controller.quickRun, undefined);
		}

		assert.equal(f.counts.provider, 2);
		assert.equal(sent.length, 4);
		assert.equal(sent.every(message => message.id.startsWith('1000@msgr.')), true);
		assert.equal(sent[0].text, question);
		assert.equal(sent[2].text, question);
		assert.equal(sent[1].replyTo, sent[0].id);
		assert.equal(sent[3].replyTo, sent[2].id);
		assert.match(sent[1].text, /^Caprine AI Assist\nAI response shared by Derek\n\nfixture answer$/);
		assert.equal(sent[3].text, sent[1].text);
		const runs = store.loadConversationSummaries(f.snapshot.conversationId).flatMap(chat => store.loadQuickRuns(f.snapshot.conversationId, chat.id));
		assert.equal(runs.length, 2);
		assert.equal(runs.every(run => run.outcome === 'completed' && run.answer === answer.text), true);
	} finally {
		store.close();
	}
});

test('manual insertion also shares attribution while authorizing the exact private answer', async () => {
	const f = fixture();
	f.report.resolve(1);
	f.controller.quickRun = undefined;
	f.controller.draftInsertionGeneration = 0;
	f.controller.draftInsertionRequestCounter = 0;
	f.controller.answer.read = () => answer;
	f.controller.draftInsertionAuthorization.consume = () => ({
		answerGeneration: 1, authorizationToken: 'fixture-token', conversationId: f.snapshot.conversationId, snapshot: f.snapshot, text: answer.text,
	});
	f.controller.restoreMessengerFocus = () => {};
	let shared;
	f.controller.notifyMessenger = command => {
		if (command.type !== 'insert-draft') {
			return;
		}

		shared = command.text;
		const pending = f.controller.pendingDraftInsertion;
		f.controller.pendingDraftInsertion = undefined;
		pending.resolve({status: 'inserted'});
	};

	await f.controller.insertAnswer({answerGeneration: 1, authorizationToken: 'fixture-token', conversationId: f.snapshot.conversationId});
	assert.equal(shared, 'Caprine AI Assist\nAI response shared by Derek\n\nfixture answer');
});
