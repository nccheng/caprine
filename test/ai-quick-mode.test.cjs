const assert = require('node:assert/strict');
const {mkdtempSync, rmSync} = require('node:fs');
const {tmpdir} = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {AiHistoryStore} = require('../dist-js/ai-history-store.js');
const {advanceQuickRun, formatQuickRunDiagnostics, isAiQuickRun} = require('../dist-js/ai-quick-run.js');
const {executeQuickMessengerAction, isQuickMessengerAction} = require('../dist-js/ai-quick-messenger.js');
const {isAiAssistMessengerEvent, isAiAssistMessengerCommand, isAiAssistPanelCommand} = require('../dist-js/ai-assist-ipc.js');
const {quickOutgoingMessages, quickObservedMessageIds, quickComposerSurface, quickQuotePreview, hasQuickQuote, quickHasAttachment, quickTextSendControl, quickQuoteTextMatches, quickMessageHasQuote, resolveQuickReplyTarget} = require('../dist-js/ai-quick-dom.js');
const {isAiComposerSendControlDescription} = require('../dist-js/ai-composer-command.js');
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

function emojiComposer(emoji = '😻', label = `傳送${emoji}`) {
	// Sanitized native structure: the quick-reaction image is a control beside
	// the empty editor, not a pending upload or a message-history attachment.
	const surface = new Element({
		children: [{
			attributes: {role: 'region'}, children: [
				{attributes: {contenteditable: 'true'}},
				{
					attributes: {role: 'button', 'aria-label': label}, rectangle: {width: 30, height: 30}, children: [
						{children: [{children: [{tag: 'span', children: [{tag: 'img', attributes: {alt: emoji}}]}]}]},
					],
				},
			],
		}],
	});
	return {
		surface,
		region: surface.children[0],
		composer: surface.querySelector('[contenteditable="true"]'),
		button: surface.querySelector('[role="button"]'),
		image: surface.querySelector('img'),
	};
}

test('native quick-emoji controls are not pending attachments', () => {
	for (const emoji of ['😻', '👍🏽', '❤️', '👩‍💻', '🇹🇼', '1️⃣']) {
		for (const label of [`傳送${emoji}`, `Send ${emoji}`]) {
			assert.equal(quickHasAttachment(emojiComposer(emoji, label).composer), false, label);
		}
	}
});

test('unknown image controls and misplaced emoji images still block Quick sends', () => {
	for (const [emoji, label] of [
		['😻', 'Choose sticker'],
		['😻', 'Remove attachment'],
		['😻', '傳送👍'],
		['', '傳送'],
		['photo.png', 'Send photo.png'],
		['😻😻', '傳送😻😻'],
		['😻photo', 'Send 😻photo'],
		['x', 'Send x'],
	]) {
		assert.equal(quickHasAttachment(emojiComposer(emoji, label).composer), true, label);
	}

	for (const location of ['surface', 'composer']) {
		const f = emojiComposer();
		f.button.remove();
		f[location].append(f.button);
		assert.equal(quickHasAttachment(f.composer), true, location);
	}

	const f = emojiComposer();
	f.button.append(new Element({tag: 'img', attributes: {alt: '😻'}}));
	assert.equal(quickHasAttachment(f.composer), true, 'ambiguous control with multiple images');
});

test('real attachments remain blocked beside and inside a quick-emoji control', () => {
	const attachments = [
		{tag: 'img'},
		{tag: 'video'},
		{tag: 'audio'},
		{attributes: {'data-testid': 'attachment-preview'}},
		{attributes: {'data-testid': 'composer-attachment'}},
		{attributes: {role: 'progressbar'}},
		{attributes: {role: 'button', 'aria-label': '移除附件'}},
		{attributes: {role: 'button', 'aria-label': '刪除附件'}},
		{attributes: {role: 'button', 'aria-label': 'Remove attachment'}},
	];
	for (const attachment of attachments) {
		for (const location of ['surface', 'button']) {
			const f = emojiComposer();
			f[location].append(new Element(attachment));
			assert.equal(quickHasAttachment(f.composer), true, `${location}: ${JSON.stringify(attachment)}`);
		}
	}

	for (const attributes of [
		{'data-testid': 'attachment-preview'},
		{'data-testid': 'composer-attachment'},
		{role: 'progressbar'},
		{'aria-label': 'Remove attachment'},
	]) {
		const f = emojiComposer();
		for (const [key, value] of Object.entries(attributes)) {
			f.image.setAttribute(key, value);
		}

		assert.equal(quickHasAttachment(f.composer), true, 'explicit attachment marker on the control image wins');
	}
});

test('Quick text Send selection rejects emoji, hidden and ambiguous controls', () => {
	const dom = emojiComposer('😻', 'Send 😻');
	const classify = control => isAiComposerSendControlDescription(control.getAttribute('aria-label') ?? '');
	assert.equal(classify(dom.button), true, 'native emoji labels also match the existing Send classifier');
	assert.equal(quickTextSendControl(dom.composer, classify), undefined, 'emoji-only is not text Send');
	const send = new Element({attributes: {role: 'button', 'aria-label': 'Press Enter to send'}, rectangle: {width: 30, height: 30}});
	dom.region.append(send);
	assert.equal(quickTextSendControl(dom.composer, classify), send);
	send.hidden = true;
	assert.equal(quickTextSendControl(dom.composer, classify), undefined, 'hidden text Send cannot fall back to emoji');
	send.hidden = false;
	dom.region.append(new Element({attributes: {role: 'button', 'aria-label': 'Send'}, rectangle: {width: 30, height: 30}}));
	assert.equal(quickTextSendControl(dom.composer, classify), undefined, 'multiple text Send controls are ambiguous');
});

for (const phase of ['question', 'answer']) {
	test(`Quick ${phase} send selects text Send only and still stops newly added attachments`, async () => {
		for (const scenario of ['text-send', 'emoji-only', 'insert-attachment', 'authorize-attachment']) {
			const dom = emojiComposer('😻', 'Send 😻');
			const f = fixture();
			f.action.phase = phase;
			if (phase === 'question') {
				delete f.action.replyToMessageId;
			}

			let emojiClicks = 0;
			dom.button.click = () => {
				emojiClicks++;
			};

			const send = new Element({attributes: {role: 'button', 'aria-label': 'Press Enter to send'}, rectangle: {width: 30, height: 30}});
			send.click = () => {
				f.state.sends++;
				dom.composer.textContent = '';
				quickQuotePreview(dom.composer)?.remove();
			};

			if (scenario !== 'emoji-only') {
				dom.region.append(send);
			}

			const resolveSend = composer => quickTextSendControl(composer, control => isAiComposerSendControlDescription(control.getAttribute('aria-label') ?? ''));
			Object.assign(f.adapter, {
				resolveComposer: () => dom.composer,
				readText: composer => composer.textContent,
				hasAttachment: quickHasAttachment,
				hasReply: hasQuickQuote,
				async prepareReply() {
					dom.surface.setChildren([new Element({
						children: [
							{children: [{attributes: {role: 'button', 'aria-label': 'Cancel reply'}}]},
							{attributes: {dir: 'auto'}, text: 'Synthetic question'},
						],
					}), dom.region]);
					return true;
				},
				replyMatches: () => quickQuoteTextMatches(quickQuotePreview(dom.composer), 'Synthetic question'),
				insertText(composer, text) {
					composer.textContent = text;
					if (scenario === 'insert-attachment') {
						dom.surface.append(new Element({tag: 'img'}));
					}
				},
				async authorizeSend() {
					f.state.auths++;
					if (scenario === 'authorize-attachment') {
						dom.surface.append(new Element({attributes: {role: 'progressbar'}}));
					}

					return true;
				},
				canSend: composer => Boolean(resolveSend(composer)),
				send(composer) {
					resolveSend(composer).click();
				},
			});
			// eslint-disable-next-line no-await-in-loop
			const result = await executeQuickMessengerAction(f.action, f.adapter);
			const expected = scenario === 'text-send' ? {status: 'observed', messageId: 'new-answer'}
				: {status: 'blocked', code: scenario === 'emoji-only' ? 'send-control-unavailable' : 'attachment-present'};
			assert.deepEqual(result, expected);
			assert.equal(emojiClicks, 0);
			assert.equal(f.state.sends, scenario === 'text-send' ? 1 : 0);
			assert.equal(f.state.auths, ['text-send', 'authorize-attachment'].includes(scenario) ? 1 : 0);
		}
	});
}

test('repeated question text still resolves the exact newly sent message identity', () => {
	const messages = ['previous-question', 'new-question'].map(id => ({
		id, text: 'Repeated question', element: {}, article: {},
	}));
	assert.equal(resolveQuickReplyTarget(messages, 'new-question'), messages[1]);
	assert.equal(resolveQuickReplyTarget(messages, 'missing-question'), undefined);
	assert.equal(resolveQuickReplyTarget([...messages, {...messages[1], element: {}}], 'new-question'), undefined);
});

test('attributed maximum-size answers fit both sending paths without allowing larger questions', () => {
	const text = formatCaprineAiSharedAnswer('x'.repeat(20_000), 'q'.repeat(20_000));
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

function nativeArticle(id, text, question) {
	return new Element({
		attributes: {role: 'article'}, children: [
			{attributes: {'data-message-id': id, 'data-scope': 'messages_table', 'aria-label': `10:00，你：${text}`}},
			...(question === undefined ? [] : [{attributes: {role: 'button', 'aria-label': '前往已回覆的訊息'}, children: [{attributes: {dir: 'auto'}, text: question}]}]),
		],
	});
}

test('question and answer observations wait through numeric-to-native ID replacement without resending', async () => {
	for (const phase of ['question', 'answer']) {
		const f = fixture();
		const question = 'Repeated question';
		const quoted = phase === 'answer' ? question : undefined;
		f.action.phase = phase;
		if (phase === 'question') {
			delete f.action.replyToMessageId;
		}

		const root = new Element({attributes: {role: 'main'}});
		root.append(nativeArticle('mid.older', f.action.text, quoted));
		let observations = 0;
		let optimistic;
		f.adapter.messageIds = () => new Set(quickOutgoingMessages(root).map(message => message.id));
		f.adapter.observe = (before, text, replyTo) => quickObservedMessageIds(quickOutgoingMessages(root), before, text, replyTo ? question : undefined);
		const {send} = f.adapter;
		f.adapter.send = composer => {
			send(composer);
			optimistic = nativeArticle('1234567890123456789', f.action.text, quoted);
			root.append(optimistic);
		};

		f.adapter.settle = async () => {
			if (f.state.sends && ++observations === 3) {
				optimistic.remove();
				root.append(nativeArticle('1000000000@msgr.1234567890123456789', f.action.text, quoted));
			}
		};

		// eslint-disable-next-line no-await-in-loop
		assert.deepEqual(await executeQuickMessengerAction(f.action, f.adapter), {status: 'observed', messageId: '1000000000@msgr.1234567890123456789'});
		assert.equal(observations, 3, 'the optimistic row must never complete the action');
		assert.equal(f.state.sends, 1);
		assert.equal(f.state.auths, 1);
	}
});

test('older optimistic IDs and renamed native IDs are not newly sent messages', () => {
	const root = new Element({attributes: {role: 'main'}});
	root.append(nativeArticle('100@msgr.111', 'Same'), nativeArticle('100@msgr.222', 'Same'));
	assert.deepEqual(quickObservedMessageIds(quickOutgoingMessages(root), new Set(['111']), 'Same'), ['100@msgr.222']);
	root.append(nativeArticle('mid.unrelated', 'Same'));
	assert.deepEqual(quickObservedMessageIds(quickOutgoingMessages(root), new Set(['111']), 'Same'), [], 'a mid ID cannot resolve an older pending alias');
	assert.deepEqual(quickObservedMessageIds(quickOutgoingMessages(root), new Set(['99@msgr.111', 'mid.unrelated']), 'Same'), ['100@msgr.222']);
	root.append(nativeArticle('100@msgr.333', 'Same'));
	assert.equal(quickObservedMessageIds(quickOutgoingMessages(root), new Set(['111', 'mid.unrelated']), 'Same').length, 2, 'ambiguous new identities must reach the executor ambiguity guard');
});

test('a different native message cannot hide this send while its numeric or unknown identity is unresolved', async () => {
	for (const phase of ['question', 'answer']) {
		for (const pendingId of ['111', 'unknown-id']) {
			const f = fixture();
			f.action.phase = phase;
			if (phase === 'question') {
				delete f.action.replyToMessageId;
			}

			const quoted = phase === 'answer' ? 'Original' : undefined;
			const root = new Element({attributes: {role: 'main'}});
			const {send} = f.adapter;
			f.adapter.send = composer => {
				send(composer);
				// This send is still optimistic; a different client's matching
				// native message arrives. The pending quote is not hydrated yet.
				root.append(nativeArticle(pendingId, f.action.text), nativeArticle('100@msgr.222', f.action.text, quoted));
			};

			f.adapter.observe = (before, text) => quickObservedMessageIds(quickOutgoingMessages(root), before, text, quoted);
			// eslint-disable-next-line no-await-in-loop
			assert.deepEqual(await executeQuickMessengerAction(f.action, f.adapter), {status: 'uncertain', code: 'send-result-unknown'});
			assert.equal(f.state.sends, 1);
			assert.equal(f.state.auths, 1);
		}
	}
});

test('coexisting optimistic and native aliases are one resolved identity, but different native IDs remain ambiguous', () => {
	const root = new Element({attributes: {role: 'main'}});
	root.append(nativeArticle('111', 'Same'), nativeArticle('100@msgr.111', 'Same'));
	assert.deepEqual(quickObservedMessageIds(quickOutgoingMessages(root), new Set(), 'Same'), ['100@msgr.111']);
	root.append(nativeArticle('100@msgr.222', 'Same'));
	assert.deepEqual(quickObservedMessageIds(quickOutgoingMessages(root), new Set(), 'Same'), ['100@msgr.111', '100@msgr.222']);
});

test('unacknowledged or unknown IDs remain uncertain after one send', async () => {
	for (const id of ['1234567890123456789', 'unknown-format']) {
		const f = fixture();
		const root = new Element({attributes: {role: 'main'}});
		const {send} = f.adapter;
		f.adapter.send = composer => {
			send(composer);
			root.append(nativeArticle(id, f.action.text, 'Question'));
		};

		f.adapter.observe = (before, text) => quickObservedMessageIds(quickOutgoingMessages(root), before, text, 'Question');
		// eslint-disable-next-line no-await-in-loop
		assert.deepEqual(await executeQuickMessengerAction(f.action, f.adapter), {status: 'uncertain', code: 'send-result-unknown'});
		assert.equal(f.state.sends, 1);
	}
});

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
