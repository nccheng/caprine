const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const test = require('node:test');
const {restoreContextReviewSnapshot, buildReviewedPrompt} = require('../dist-js/context-review.js');
const {AiHistoryStore} = require('../dist-js/ai-history-store.js');

// Exercise the real controller methods without constructing windows, opening a
// real database, loading Electron, reading a key, or contacting a provider.
function loadController() {
	const modulePath = path.resolve('dist-js/ai-assist.js');
	const localRequire = createRequire(modulePath);
	const settings = {
		aiAssistEnabled: true, aiAssistQuickMode: true, aiAssistWebSearchMode: 'off', aiAssistContextWindowSize: 10,
	};
	const mocks = {
		electron: {app: {getVersion: () => 'test'}},
		'./config': {
			get: key => settings[key], set(key, value) {
				settings[key] = value;
			},
		},
		'./messenger-image-normalization': {},
		'./reviewed-images': {withSelectedReviewedImageInputs: async ({run}) => run([])},
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
