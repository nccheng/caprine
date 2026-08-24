const assert = require('node:assert/strict');
const test = require('node:test');
const {
	AiComposerCommandState,
	consumeAiComposerCommand,
	isAiComposerSendControlDescription,
	isAiComposerSendControlEvent,
	isNormalAiComposerEnter,
	parseAiComposerCommand,
	resolveAiComposerFromEventSignals,
	routeArmedAiComposerEnter,
	routeArmedAiComposerSend,
	shouldInterceptAiComposerEnter,
	shouldInterceptAiComposerSend,
} = require('../dist-js/ai-composer-command.js');

const enterEvent = {
	isComposing: false,
	key: 'Enter',
	keyCode: 13,
	shiftKey: false,
};

function createComposer() {
	return {};
}

function snapshotState(snapshot, overrides = {}) {
	return {
		composer: snapshot.composer,
		conversationId: snapshot.conversationId,
		draftText: snapshot.command.draftText,
		isConnected: true,
		...overrides,
	};
}

function protectedEnterEvent(overrides = {}) {
	const calls = {prevented: 0, stopped: 0};
	return {
		calls,
		event: {
			...enterEvent,
			...overrides,
			preventDefault() {
				calls.prevented += 1;
			},
			stopImmediatePropagation() {
				calls.stopped += 1;
			},
		},
	};
}

function protectedEvent() {
	const calls = {prevented: 0, stopped: 0};
	return {
		calls,
		event: {
			preventDefault() {
				calls.prevented += 1;
			},
			stopImmediatePropagation() {
				calls.stopped += 1;
			},
		},
	};
}

function routeEnter(state, snapshot, event, options) {
	const {resolution} = options;
	let consumed = 0;
	let invalidated = 0;
	const outcome = routeArmedAiComposerEnter(
		event,
		{
			blockedArmedFallback: resolution.blockedArmedFallback,
			composer: resolution.composer,
			composingComposer: options.composingComposer,
			consume() {
				consumed += 1;
			},
			invalidate() {
				invalidated += 1;
				state.invalidate();
			},
			isCurrent: options.isCurrent ?? (candidate => state.matches(candidate, snapshotState(candidate))),
			snapshot,
		},
	);
	return {consumed, invalidated, outcome};
}

test('an armed Enter falls back to the snapshot when the event target cannot resolve', () => {
	const state = new AiComposerCommandState();
	const composer = createComposer();
	const snapshot = state.arm(composer, '/ai private question', 'conversation-a');
	const unhelpfulTarget = {};
	const resolution = resolveAiComposerFromEventSignals({
		activeElement: undefined,
		armedComposer: snapshot.composer,
		composedPath: [],
		target: unhelpfulTarget,
	}, () => undefined, () => false);
	const {calls, event} = protectedEnterEvent();

	assert.deepEqual(resolution, {blockedArmedFallback: false, composer});
	assert.deepEqual(routeEnter(state, snapshot, event, {resolution}), {
		consumed: 1,
		invalidated: 0,
		outcome: 'protected-consumed',
	});
	assert.deepEqual(calls, {prevented: 1, stopped: 1});
});

test('composer event resolution checks composedPath before activeElement', () => {
	const pathComposer = createComposer();
	const activeComposer = createComposer();
	const pathNode = {};
	const activeNode = {};
	const resolution = resolveAiComposerFromEventSignals({
		activeElement: activeNode,
		armedComposer: createComposer(),
		composedPath: [{}, pathNode],
		target: {},
	}, node => {
		if (node === pathNode) {
			return pathComposer;
		}

		return node === activeNode ? activeComposer : undefined;
	}, () => false);

	assert.deepEqual(resolution, {blockedArmedFallback: false, composer: pathComposer});
});

test('composer event resolution uses activeElement when target and path are unhelpful', () => {
	const composer = createComposer();
	const activeNode = {};
	const resolution = resolveAiComposerFromEventSignals({
		activeElement: activeNode,
		armedComposer: createComposer(),
		composedPath: [{}],
		target: {},
	}, node => node === activeNode ? composer : undefined, () => false);

	assert.deepEqual(resolution, {blockedArmedFallback: false, composer});
});

test('unrelated editable event signals reject the armed composer fallback', () => {
	const editable = {};
	const resolution = resolveAiComposerFromEventSignals({
		activeElement: editable,
		armedComposer: createComposer(),
		composedPath: [],
		target: {},
	}, () => undefined, node => node === editable);

	assert.deepEqual(resolution, {blockedArmedFallback: true, composer: undefined});
});

test('normal Enter without an arm stays untouched', () => {
	const state = new AiComposerCommandState();
	const {calls, event} = protectedEnterEvent();
	const result = routeEnter(state, undefined, event, {
		resolution: {
			blockedArmedFallback: false,
			composer: undefined,
		},
	});

	assert.deepEqual(result, {consumed: 0, invalidated: 0, outcome: 'ignored'});
	assert.deepEqual(calls, {prevented: 0, stopped: 0});
});

test('stale armed Enter is protected and invalidated without consumption', () => {
	const state = new AiComposerCommandState();
	const composer = createComposer();
	const snapshot = state.arm(composer, '/ai stale question', 'conversation-a');
	const {calls, event} = protectedEnterEvent();
	const result = routeEnter(state, snapshot, event, {
		isCurrent: () => false,
		resolution: {
			blockedArmedFallback: false,
			composer,
		},
	});

	assert.deepEqual(result, {consumed: 0, invalidated: 1, outcome: 'protected-stale'});
	assert.deepEqual(calls, {prevented: 1, stopped: 1});
	assert.equal(state.current(), undefined);
});

test('Enter resolved to another composer protects the armed draft without consuming it', () => {
	const state = new AiComposerCommandState();
	const snapshot = state.arm(createComposer(), '/ai wrong composer', 'conversation-a');
	const {calls, event} = protectedEnterEvent();
	const result = routeEnter(state, snapshot, event, {
		resolution: {
			blockedArmedFallback: false,
			composer: createComposer(),
		},
	});

	assert.deepEqual(result, {consumed: 0, invalidated: 1, outcome: 'protected-stale'});
	assert.deepEqual(calls, {prevented: 1, stopped: 1});
});

test('IME, keyCode 229, and Shift+Enter leave a valid arm untouched', () => {
	for (const overrides of [
		{isComposing: true},
		{keyCode: 229},
		{shiftKey: true},
	]) {
		const state = new AiComposerCommandState();
		const composer = createComposer();
		const snapshot = state.arm(composer, '/ai keep composing', 'conversation-a');
		const {calls, event} = protectedEnterEvent(overrides);
		const result = routeEnter(state, snapshot, event, {
			resolution: {
				blockedArmedFallback: false,
				composer,
			},
		});

		assert.deepEqual(result, {consumed: 0, invalidated: 0, outcome: 'ignored'});
		assert.deepEqual(calls, {prevented: 0, stopped: 0});
		assert.equal(state.current(), snapshot);
	}
});

test('only an ordinary Enter key has command submission semantics', () => {
	assert.equal(isNormalAiComposerEnter(enterEvent), true);
	assert.equal(isNormalAiComposerEnter({...enterEvent, key: 'Tab'}), false);
	assert.equal(isNormalAiComposerEnter({...enterEvent, isComposing: true}), false);
	assert.equal(isNormalAiComposerEnter({...enterEvent, keyCode: 229}), false);
	assert.equal(isNormalAiComposerEnter({...enterEvent, shiftKey: true}), false);
});

test('an armed send control is protected and consumed through snapshot authority', () => {
	const state = new AiComposerCommandState();
	const composer = createComposer();
	const snapshot = state.arm(composer, '/ai send privately', 'conversation-a');
	const {calls, event} = protectedEvent();
	let consumed = 0;
	let invalidated = 0;
	const outcome = routeArmedAiComposerSend(
		event,
		true,
		{
			blockedArmedFallback: false,
			composer,
			composingComposer: undefined,
			consume() {
				consumed += 1;
			},
			invalidate() {
				invalidated += 1;
			},
			isCurrent: candidate => state.matches(candidate, snapshotState(candidate)),
			snapshot,
		},
	);

	assert.equal(outcome, 'protected-consumed');
	assert.equal(consumed, 1);
	assert.equal(invalidated, 0);
	assert.deepEqual(calls, {prevented: 1, stopped: 1});
});

test('localized send controls remain recognizable through their Enter hint', () => {
	assert.equal(isAiComposerSendControlDescription('Press Enter to send'), true);
	assert.equal(isAiComposerSendControlDescription('按 Enter 即可傳送'), true);
	assert.equal(isAiComposerSendControlDescription('Open more actions'), false);
});

test('send-control routing checks composedPath when the event target is unhelpful', () => {
	const sendControl = {};
	assert.equal(isAiComposerSendControlEvent(
		{},
		[{}, sendControl],
		candidate => candidate === sendControl,
	), true);
	assert.equal(isAiComposerSendControlEvent({}, [{}], () => false), false);
});

test('only exact /ai commands arm and preserve the inline question', () => {
	assert.deepEqual(parseAiComposerCommand('/ai'), {draftText: '/ai', prompt: ''});
	assert.deepEqual(parseAiComposerCommand('/ai exact  question\nline two'), {
		draftText: '/ai exact  question\nline two',
		prompt: 'exact  question\nline two',
	});
	assert.deepEqual(parseAiComposerCommand('/ai\u00A0pasted question'), {
		draftText: '/ai\u00A0pasted question',
		prompt: 'pasted question',
	});
	assert.equal(parseAiComposerCommand('hello /ai'), undefined);
	assert.equal(parseAiComposerCommand('/aide'), undefined);
	assert.equal(parseAiComposerCommand(' /ai'), undefined);
	const oversized = parseAiComposerCommand(`/ai ${'x'.repeat(20_001)}`);
	assert.equal(oversized.error, 'prompt-too-long');
	assert.equal(shouldInterceptAiComposerEnter({
		isComposing: false,
		key: 'Enter',
		keyCode: 13,
		shiftKey: false,
	}, oversized), true);
	assert.equal(shouldInterceptAiComposerSend(true, oversized), true);
});

test('Enter and send clicks intercept armed commands without breaking IME or Shift+Enter', () => {
	const command = parseAiComposerCommand('/ai pasted immediately');
	assert.equal(shouldInterceptAiComposerEnter(enterEvent, command), true);
	assert.equal(shouldInterceptAiComposerEnter({
		isComposing: false,
		key: 'Enter',
		keyCode: 13,
		shiftKey: true,
	}, command), false);
	assert.equal(shouldInterceptAiComposerEnter({
		isComposing: true,
		key: 'Enter',
		keyCode: 13,
		shiftKey: false,
	}, command), false);
	assert.equal(shouldInterceptAiComposerEnter({
		isComposing: false,
		key: 'Enter',
		keyCode: 229,
		shiftKey: false,
	}, command), false);
	assert.equal(shouldInterceptAiComposerSend(true, command), true);
	assert.equal(shouldInterceptAiComposerSend(false, command), false);
	assert.equal(shouldInterceptAiComposerSend(true, parseAiComposerCommand('normal message')), false);
});

test('conversation switch after arm protects Enter but cannot consume against the new conversation', () => {
	const state = new AiComposerCommandState();
	const composer = createComposer();
	const snapshot = state.arm(composer, '/ai question', 'conversation-a');

	assert.equal(shouldInterceptAiComposerEnter(enterEvent, parseAiComposerCommand('/ai question')), true);
	assert.equal(state.matches(snapshot, snapshotState(snapshot, {conversationId: 'conversation-b'})), false);
});

test('a command cannot arm without a stable conversation identity', () => {
	const state = new AiComposerCommandState();
	assert.equal(state.arm(createComposer(), '/ai question', undefined), undefined);
	assert.equal(state.current(), undefined);
});

test('conversation switch after arm protects Send but cannot consume against the new conversation', () => {
	const state = new AiComposerCommandState();
	const composer = createComposer();
	const snapshot = state.arm(composer, '/ai question', 'conversation-a');

	assert.equal(shouldInterceptAiComposerSend(true, parseAiComposerCommand('/ai question')), true);
	assert.equal(state.matches(snapshot, snapshotState(snapshot, {conversationId: 'conversation-b'})), false);
});

test('composer replacement or disconnection invalidates stale authority', () => {
	const state = new AiComposerCommandState();
	const snapshot = state.arm(createComposer(), '/ai question', 'conversation-a');

	assert.equal(state.matches(snapshot, snapshotState(snapshot, {isConnected: false})), false);
	assert.equal(state.matches(snapshot, snapshotState(snapshot, {composer: createComposer()})), false);
});

test('draft mutation invalidates the old arm and rearming cannot revive its generation', () => {
	const state = new AiComposerCommandState();
	const composer = createComposer();
	const oldSnapshot = state.arm(composer, '/ai old', 'conversation-a');

	assert.equal(state.matches(oldSnapshot, snapshotState(oldSnapshot, {draftText: '/ai new'})), false);
	const newSnapshot = state.arm(composer, '/ai new', 'conversation-a');
	assert.equal(state.matches(oldSnapshot, snapshotState(oldSnapshot)), false);
	assert.equal(state.matches(newSnapshot, snapshotState(newSnapshot)), true);
});

test('paste immediately followed by Enter consumes the exact armed draft', async () => {
	const state = new AiComposerCommandState();
	const composer = createComposer();
	const snapshot = state.arm(composer, '/ai pasted immediately', 'conversation-a');
	let draft = snapshot.command.draftText;
	let openedPrompt;

	assert.equal(shouldInterceptAiComposerEnter(enterEvent, parseAiComposerCommand(draft)), true);
	assert.equal(await consumeAiComposerCommand(snapshot.command, {
		clear() {
			draft = '';
			state.invalidate();
		},
		isCurrent() {
			return state.matches(snapshot, snapshotState(snapshot, {draftText: draft}));
		},
		async openPanel(prompt) {
			openedPrompt = prompt;
			return true;
		},
		restore() {},
	}), 'accepted');
	assert.equal(openedPrompt, 'pasted immediately');
	assert.equal(draft, '');
});

test('two-step consume revalidates before clearing and restores on open failure', async () => {
	const command = parseAiComposerCommand('/ai\u00A0keep me');
	let draft = command.draftText;
	let generation = 1;
	const actions = accepted => ({
		clear() {
			draft = '';
		},
		isCurrent() {
			return generation === 1 && draft === command.draftText;
		},
		async openPanel(prompt) {
			assert.equal(prompt, 'keep me');
			return accepted;
		},
		restore(original) {
			draft = original;
		},
	});

	assert.equal(await consumeAiComposerCommand(command, actions(false)), 'restored');
	assert.equal(draft, '/ai\u00A0keep me');

	generation = 2;
	assert.equal(await consumeAiComposerCommand(command, actions(true)), 'stale');
	assert.equal(draft, '/ai\u00A0keep me');

	generation = 1;
	assert.equal(await consumeAiComposerCommand(command, actions(true)), 'accepted');
	assert.equal(draft, '');
});

test('thrown panel-open failures restore the recoverable draft', async () => {
	const command = parseAiComposerCommand('/ai recover');
	let draft = command.draftText;
	const outcome = await consumeAiComposerCommand(command, {
		clear() {
			draft = '';
		},
		isCurrent: () => true,
		async openPanel() {
			throw new Error('panel failed');
		},
		restore(original) {
			draft = original;
		},
	});
	assert.equal(outcome, 'restored');
	assert.equal(draft, '/ai recover');
});

test('panel rejection does not overwrite text entered after the command was cleared', async () => {
	const command = parseAiComposerCommand('/ai recover safely');
	let draft = command.draftText;
	const outcome = await consumeAiComposerCommand(command, {
		clear() {
			draft = '';
		},
		isCurrent: () => true,
		async openPanel() {
			draft = 'newer user draft';
			return false;
		},
		restore(original) {
			if (draft === '') {
				draft = original;
			}
		},
	});
	assert.equal(outcome, 'restored');
	assert.equal(draft, 'newer user draft');
});

test('successful command stays bound to its armed conversation snapshot', async () => {
	const state = new AiComposerCommandState();
	const composer = createComposer();
	const snapshot = state.arm(composer, '/ai expected question', 'conversation-a');
	let openedConversation;
	let draft = snapshot.command.draftText;

	assert.equal(await consumeAiComposerCommand(snapshot.command, {
		clear() {
			draft = '';
			state.invalidate();
		},
		isCurrent() {
			return state.matches(snapshot, snapshotState(snapshot, {draftText: draft}));
		},
		async openPanel() {
			openedConversation = snapshot.conversationId;
			return true;
		},
		restore() {},
	}), 'accepted');
	assert.equal(openedConversation, 'conversation-a');
	assert.equal(draft, '');
});

test('an async conversation change before clear leaves the stale command recoverable', async () => {
	const state = new AiComposerCommandState();
	const composer = createComposer();
	const snapshot = state.arm(composer, '/ai stay private', 'conversation-a');
	let conversationId = 'conversation-a';
	let draft = snapshot.command.draftText;
	const consuming = consumeAiComposerCommand(snapshot.command, {
		clear() {
			draft = '';
		},
		isCurrent() {
			return state.matches(snapshot, snapshotState(snapshot, {conversationId, draftText: draft}));
		},
		async openPanel() {
			throw new Error('must not open');
		},
		restore() {},
	});
	conversationId = 'conversation-b';

	assert.equal(await consuming, 'stale');
	assert.equal(draft, '/ai stay private');
});
