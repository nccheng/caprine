const assert = require('node:assert/strict');
const {mkdtempSync, rmSync} = require('node:fs');
const {tmpdir} = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {AiHistoryStore} = require('../dist-js/ai-history-store.js');
const {advanceQuickRun, formatQuickRunDiagnostics, isAiQuickRun} = require('../dist-js/ai-quick-run.js');
const {executeQuickMessengerAction, isQuickMessengerAction} = require('../dist-js/ai-quick-messenger.js');
const {isAiAssistMessengerEvent, isAiAssistMessengerCommand, isAiAssistPanelCommand} = require('../dist-js/ai-assist-ipc.js');
const {quickOutgoingMessages, quickComposerSurface, quickQuotePreview, hasQuickQuote, quickHasAttachment, quickQuoteTextMatches, quickMessageHasQuote, resolveQuickReplyTarget} = require('../dist-js/ai-quick-dom.js');
const {formatCaprineAiSharedAnswer, caprineAiSharedAnswerCharacterLimit} = require('../dist-js/share-text-protocol.js');
const {MessengerContextFixtureElement: Element} = require('./helpers/messenger-context-fixture.cjs');

function run(chatId, overrides = {}) {
	return {
		id: 'run-1', chatId, conversationId: 'messenger-thread:private', createdAt: 100, updatedAt: 100,
		appVersion: 'PRIVATE-VERSION', model: 'PRIVATE-MODEL', browsingMode: 'off', contextCount: 10,
		question: 'PRIVATE-QUESTION', prompt: 'PRIVATE-CONTEXT', answer: '', outcome: 'running',
		events: [{at: 100, stage: 'invocation', status: 'succeeded'}], ...overrides,
	};
}

test('failed-only runs are searchable, survive reopen, and delete with their history chat', () => {
	const directory = mkdtempSync(path.join(tmpdir(), 'caprine-quick-'));
	const databasePath = path.join(directory, 'history.sqlite');
	let store = new AiHistoryStore({databasePath, now: () => 100});
	try {
		const chatId = store.createChat('messenger-thread:private');
		const initial = run(chatId);
		store.createQuickRun(initial);
		const failed = advanceQuickRun(initial, {
			at: 200, stage: 'context', status: 'failed', code: 'context-unavailable',
		}, 'failed');
		store.updateQuickRun(failed);
		assert.throws(() => store.updateQuickRun(failed), /finished/);
		assert.equal(store.loadConversationSummaries(initial.conversationId, 'PRIVATE-QUESTION')[0].id, chatId);
		assert.equal(store.loadConversationSummaries(initial.conversationId)[0].lastActivityAt, 200);
		store.close();
		store = new AiHistoryStore({databasePath});
		assert.equal(store.loadQuickRuns(initial.conversationId, chatId)[0].outcome, 'failed');
		assert.deepEqual(store.loadQuickRuns('messenger-thread:other', chatId), []);
		assert.equal(store.deleteChat(initial.conversationId, chatId), true);
		assert.deepEqual(store.loadQuickRuns(initial.conversationId, chatId), []);
		assert.throws(() => store.updateQuickRun(initial), /deleted/);
	} finally {
		store.close();
		rmSync(directory, {recursive: true, force: true});
	}
});

test('restart after send authorization preserves uncertainty and cannot resume', () => {
	const directory = mkdtempSync(path.join(tmpdir(), 'caprine-quick-'));
	const databasePath = path.join(directory, 'history.sqlite');
	let store = new AiHistoryStore({databasePath, now: () => 300});
	try {
		const chatId = store.createChat('messenger-thread:private');
		const initial = run(chatId);
		store.createQuickRun(initial);
		store.updateQuickRun(advanceQuickRun(initial, {at: 200, stage: 'answer-send', status: 'started'}));
		store.close();
		store = new AiHistoryStore({databasePath, now: () => 400});
		const recovered = store.loadQuickRuns(initial.conversationId, chatId)[0];
		assert.equal(recovered.outcome, 'send-uncertain');
		assert.equal(recovered.events.at(-1).code, 'restart');
		assert.throws(() => advanceQuickRun(recovered, {at: 500, stage: 'answer-send', status: 'started'}), /finished/);
		store.clearConversation(initial.conversationId);
		assert.deepEqual(store.loadQuickRuns(initial.conversationId, chatId), []);
	} finally {
		store.close();
		rmSync(directory, {recursive: true, force: true});
	}
});

test('diagnostic export only includes allowlisted structural fields', () => {
	const data = run('PRIVATE-CHAT', {answer: 'PRIVATE-ANSWER', questionMessageId: 'PRIVATE-MESSAGE'});
	assert.equal(isAiQuickRun(data), true);
	const report = formatQuickRunDiagnostics(data);
	assert.equal(report.includes('PRIVATE'), false);
	assert.equal(report.includes('run-1'), false);
	assert.match(report, /does not prove delivery/);
	assert.equal(isAiQuickRun({...data, secret: 'credential'}), false);
	assert.equal(isAiQuickRun({
		...data, events: [{
			at: 100, stage: 'model', status: 'failed', code: 'PRIVATE-ERROR',
		}],
	}), false);
});

test('stale updates at the same timestamp cannot overwrite newer run stages', () => {
	const store = new AiHistoryStore({databasePath: ':memory:', now: () => 100});
	try {
		const chatId = store.createChat('messenger-thread:private');
		const initial = run(chatId);
		store.createQuickRun(initial);
		const next = advanceQuickRun(initial, {at: 100, stage: 'context', status: 'started'});
		store.updateQuickRun(next);
		assert.throws(() => store.updateQuickRun(next), /finished/);
		assert.equal(store.loadQuickRuns(initial.conversationId, chatId)[0].events.length, 2);
	} finally {
		store.close();
	}
});

test('native DOM scope keeps the reply preview outside the composer region and rejects ambiguous surfaces', () => {
	const surface = new Element({
		children: [
			{
				children: [
					{children: [{attributes: {role: 'button', 'aria-label': '取消回覆'}}]},
					{attributes: {dir: 'auto'}, text: 'Synthetic question'},
				],
			},
			{attributes: {role: 'region'}, children: [{attributes: {contenteditable: 'true'}}]},
		],
	});
	const composer = surface.querySelector('[contenteditable="true"]');
	assert.equal(quickComposerSurface(composer), surface);
	const preview = quickQuotePreview(composer);
	assert.equal(preview, surface.children[0]);
	assert.equal(hasQuickQuote(composer), true);
	assert.equal(quickQuoteTextMatches(preview, 'Synthetic question'), true);
	assert.equal(quickQuoteTextMatches(preview, 'Synthetic question longer'), false);
	assert.equal(quickHasAttachment(composer), false);
	preview.append(new Element({tag: 'img'}));
	assert.equal(quickHasAttachment(composer), false, 'an image in the quoted message is not a new attachment');
	surface.append(new Element({tag: 'img'}));
	assert.equal(quickHasAttachment(composer), true);
	surface.append(new Element({attributes: {contenteditable: 'true'}}));
	assert.equal(quickComposerSurface(composer), undefined);
});

test('repeated question text still resolves the exact newly sent message identity', () => {
	const messages = ['previous-question', 'new-question'].map(id => ({
		id, text: 'Repeated question', element: {}, article: {},
	}));
	assert.equal(resolveQuickReplyTarget(messages, 'new-question'), messages[1]);
	assert.equal(resolveQuickReplyTarget(messages, 'missing-question'), undefined);
	assert.equal(resolveQuickReplyTarget([...messages, {...messages[1], element: {}}], 'new-question'), undefined);
});

test('attributed maximum-size answers fit both sending paths without allowing larger questions', () => {
	const text = formatCaprineAiSharedAnswer('x'.repeat(20_000));
	assert.equal(text.length, caprineAiSharedAnswerCharacterLimit);
	assert.match(text, /^Caprine AI Assist\nAI response shared by Derek\n\n/);
	assert.equal(isQuickMessengerAction({...fixture().action, text}), true);
	const questionAction = {...fixture().action, phase: 'question', text: 'x'.repeat(20_000)};
	delete questionAction.replyToMessageId;
	assert.equal(isQuickMessengerAction(questionAction), true);
	assert.equal(isQuickMessengerAction({...questionAction, text}), false);
	const insertion = {
		type: 'insert-draft', requestId: 'draft-insertion-request-1', conversationId: 'messenger-thread:test',
		answerGeneration: 1, authorizationToken: 'draft-insertion-token:00000000-0000-4000-8000-000000000001', text,
	};
	assert.equal(isAiAssistMessengerCommand(insertion), true);
	assert.equal(isAiAssistMessengerCommand({...insertion, text: text + 'x'}), false);
});

test('native observations require outgoing identity, one message per article and exact quoted text', () => {
	const root = new Element({
		attributes: {role: 'main'}, children: [
			{
				attributes: {role: 'article'}, children: [
					{attributes: {'data-message-id': 'mid.$synthetic_1', 'data-scope': 'messages_table', 'aria-label': '10:00，你：Synthetic question'}},
				],
			},
			{
				attributes: {role: 'article'}, children: [
					{attributes: {'data-message-id': 'mid.synthetic_2', 'data-scope': 'messages_table', 'aria-label': 'At 10:01 AM, You: Synthetic answer'}},
					{attributes: {role: 'button', 'aria-label': '前往已回覆的訊息'}, children: [{attributes: {dir: 'auto'}, text: 'Synthetic question'}]},
				],
			},
			{
				attributes: {role: 'article'}, children: [
					{attributes: {'data-message-id': 'incoming', 'data-scope': 'messages_table', 'aria-label': '10:02，Other：Synthetic question'}},
				],
			},
		],
	});
	const messages = quickOutgoingMessages(root);
	assert.deepEqual(messages.map(message => message.id), ['mid.$synthetic_1', 'mid.synthetic_2']);
	assert.equal(isQuickMessengerAction({...fixture().action, replyToMessageId: messages[0].id}), true);
	assert.equal(quickMessageHasQuote(messages[1], 'Synthetic question'), true);
	assert.equal(quickMessageHasQuote(messages[1]), false);
	assert.equal(quickMessageHasQuote(messages[1], 'Other question'), false);
	messages[1].article.append(new Element({attributes: {'data-message-id': 'ambiguous'}}));
	assert.equal(quickOutgoingMessages(root).length, 1);
});

function fixture(overrides = {}) {
	const composer = {text: '', quote: undefined};
	const state = {
		conversationId: 'messenger-thread:one', current: true, sends: 0, auths: 0, steps: 0,
	};
	const action = {
		runId: 'run-1', token: 'secret-token', conversationId: state.conversationId, phase: 'answer', text: 'Synthetic answer', replyToMessageId: 'original-1',
	};
	const adapter = {
		currentConversationId: () => state.conversationId,
		isCurrent: () => state.current,
		resolveComposer: () => composer,
		isEditable: () => true,
		readText: c => c.text,
		hasAttachment: () => false,
		hasReply: c => c.quote !== undefined,
		async prepareReply(id) {
			composer.quote = id;
			return true;
		},
		replyMatches: (id, c) => c.quote === id,
		insertText(c, text) {
			c.text = text;
		},
		canSend: () => true,
		async authorizeSend() {
			state.auths++;
			return true;
		},
		send(c) {
			state.sends++;
			c.text = '';
			c.quote = undefined;
		},
		messageIds: () => new Set(['original-1', 'old-answer']),
		observe: () => state.sends ? ['new-answer'] : [],
		async settle() {
			state.steps++;
		},
		...overrides,
	};
	return {
		action, adapter, composer, state,
	};
}

test('native reply sends once only after quote, exact draft and authorization checks', async () => {
	const f = fixture();
	assert.deepEqual(await executeQuickMessengerAction(f.action, f.adapter), {status: 'observed', messageId: 'new-answer'});
	assert.equal(f.state.sends, 1);
	assert.equal(f.state.auths, 1);
});

test('user draft and preexisting quote are preserved without any send', async () => {
	for (const kind of ['draft', 'quote']) {
		const f = fixture();
		if (kind === 'draft') {
			f.composer.text = 'Owner draft';
		} else {
			f.composer.quote = 'other';
		}

		// eslint-disable-next-line no-await-in-loop
		const result = await executeQuickMessengerAction(f.action, f.adapter);
		assert.equal(result.status, 'blocked');
		assert.equal(f.state.sends, 0);
		assert.equal(f.state.auths, 0);
		assert.equal(kind === 'draft' ? f.composer.text : f.composer.quote, kind === 'draft' ? 'Owner draft' : 'other');
	}
});

test('wrong quote, navigation and a new draft during authorization never send', async () => {
	for (const mutate of [f => {
		f.composer.quote = 'wrong';
	}, f => {
		f.state.conversationId = 'messenger-thread:two';
	}, f => {
		f.composer.text = 'New owner text';
	}]) {
		const f = fixture();
		f.adapter.authorizeSend = async () => {
			mutate(f);
			return true;
		};

		// eslint-disable-next-line no-await-in-loop
		const result = await executeQuickMessengerAction(f.action, f.adapter);
		assert.equal(result.status, 'blocked');
		assert.equal(f.state.sends, 0);
	}
});

test('timeout, duplicate observations, and loss of authority after Send never retry', async () => {
	for (const scenario of ['timeout', 'duplicate', 'cancel']) {
		const f = fixture();
		f.adapter.observe = () => scenario === 'duplicate' ? ['new-1', 'new-2'] : [];
		if (scenario === 'cancel') {
			f.adapter.send = () => {
				f.state.sends++;
				f.state.current = false;
			};
		}

		// eslint-disable-next-line no-await-in-loop
		const result = await executeQuickMessengerAction(f.action, f.adapter);
		assert.equal(result.status, 'uncertain');
		assert.equal(f.state.sends, 1);
		assert.equal(f.state.auths, 1);
	}
});

test('quick IPC rejects arbitrary payloads and fake results', () => {
	const {action} = fixture();
	assert.equal(isQuickMessengerAction(action), true);
	assert.equal(isQuickMessengerAction({...action, phase: 'question'}), false);
	assert.equal(isAiAssistMessengerCommand({type: 'quick-action', action}), true);
	assert.equal(isAiAssistMessengerCommand({type: 'quick-action', action, force: true}), false);
	assert.equal(isAiAssistPanelCommand({type: 'set-quick-mode', enabled: true}), true);
	assert.equal(isAiAssistPanelCommand({type: 'set-quick-mode', enabled: 'yes'}), false);
	assert.equal(isAiAssistMessengerEvent({
		type: 'quick-action', runId: 'run', token: 'token', result: {status: 'observed', messageId: 'id-1'},
	}), true);
	assert.equal(isAiAssistMessengerEvent({
		type: 'quick-action', runId: 'run', token: 'token', result: {status: 'delivered', messageId: 'id-1'},
	}), false);
});
