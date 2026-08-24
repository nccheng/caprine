const assert = require('node:assert/strict');
const test = require('node:test');
const {
	AiComposerCommandState,
	consumeAiComposerCommand,
	isAiComposerSendControlDescription,
	isNormalAiComposerEnter,
	parseAiComposerCommand,
	resolveAiComposerFromEventSignals,
	routeArmedAiComposerEnter,
	routeAiComposerBrowserEnter,
	routeAiComposerBrowserSend,
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

class RoutedEvent extends Event {
	constructor(type, routePath = [], overrides = {}) {
		super(type, {bubbles: true, cancelable: true});
		this.isComposing = overrides.isComposing ?? false;
		this.key = overrides.key ?? 'Enter';
		this.keyCode = overrides.keyCode ?? 13;
		this.routePath = routePath;
		this.shiftKey = overrides.shiftKey ?? false;
	}

	composedPath() {
		return [this.target, ...this.routePath].filter(Boolean);
	}
}

function browserRouteOptions(state, snapshot, overrides = {}) {
	return {
		activeElement: overrides.activeElement,
		blocksArmedFallback: overrides.blocksArmedFallback ?? (() => false),
		commandFromComposer: overrides.commandFromComposer
			?? (composer => parseAiComposerCommand(composer.draftText)),
		composerFromNode: overrides.composerFromNode ?? (() => undefined),
		composingComposer: overrides.composingComposer,
		consume() {
			overrides.onConsume?.();
		},
		invalidate() {
			overrides.onInvalidate?.();
			state.invalidate();
		},
		isCurrent: overrides.isCurrent
			?? (candidate => state.matches(candidate, snapshotState(candidate))),
		snapshot,
	};
}

function dispatchBrowserEnter(state, snapshot, overrides = {}) {
	const target = overrides.target ?? new EventTarget();
	const event = new RoutedEvent('keydown', overrides.routePath, overrides.event);
	let consumed = 0;
	let downstream = 0;
	let invalidated = 0;
	let outcome;
	target.addEventListener('keydown', candidate => {
		outcome = routeAiComposerBrowserEnter(candidate, browserRouteOptions(state, snapshot, {
			...overrides,
			onConsume() {
				consumed += 1;
			},
			onInvalidate() {
				invalidated += 1;
			},
		}));
	}, {capture: true});
	target.addEventListener('keydown', () => {
		downstream += 1;
	}, {capture: true});
	target.dispatchEvent(event);
	return {
		consumed,
		defaultPrevented: event.defaultPrevented,
		downstream,
		invalidated,
		outcome,
	};
}

test('browser keydown routing consumes an arm when the dispatched target cannot resolve', () => {
	const state = new AiComposerCommandState();
	const composer = {draftText: '/ai dispatched'};
	const snapshot = state.arm(composer, composer.draftText, 'conversation-a');

	assert.deepEqual(dispatchBrowserEnter(state, snapshot), {
		consumed: 1,
		defaultPrevented: true,
		downstream: 0,
		invalidated: 0,
		outcome: 'protected-consumed',
	});
});

test('browser keydown routing resolves composedPath before activeElement', () => {
	const state = new AiComposerCommandState();
	const composer = {draftText: '/ai path'};
	const snapshot = state.arm(composer, composer.draftText, 'conversation-a');
	const pathNode = new EventTarget();
	const activeNode = new EventTarget();

	assert.equal(dispatchBrowserEnter(state, snapshot, {
		activeElement: activeNode,
		composerFromNode(node) {
			if (node === pathNode) {
				return composer;
			}

			return node === activeNode ? {draftText: '/ai wrong'} : undefined;
		},
		routePath: [pathNode],
	}).outcome, 'protected-consumed');
});

test('browser keydown routing falls back to activeElement', () => {
	const state = new AiComposerCommandState();
	const composer = {draftText: '/ai active'};
	const snapshot = state.arm(composer, composer.draftText, 'conversation-a');
	const activeNode = new EventTarget();

	assert.equal(dispatchBrowserEnter(state, snapshot, {
		activeElement: activeNode,
		composerFromNode: node => node === activeNode ? composer : undefined,
	}).outcome, 'protected-consumed');
});

test('browser keydown routing leaves no-arm normal messages and IME or Shift Enter untouched', () => {
	const noArmState = new AiComposerCommandState();
	const normalComposer = {draftText: 'normal message'};
	const target = new EventTarget();
	assert.deepEqual(dispatchBrowserEnter(noArmState, undefined, {
		composerFromNode: node => node === target ? normalComposer : undefined,
		target,
	}), {
		consumed: 0,
		defaultPrevented: false,
		downstream: 1,
		invalidated: 0,
		outcome: 'ignored',
	});

	for (const event of [{isComposing: true}, {keyCode: 229}, {shiftKey: true}]) {
		const state = new AiComposerCommandState();
		const composer = {draftText: '/ai composing'};
		const snapshot = state.arm(composer, composer.draftText, 'conversation-a');
		const result = dispatchBrowserEnter(state, snapshot, {event});
		assert.equal(result.defaultPrevented, false);
		assert.equal(result.downstream, 1);
		assert.equal(result.outcome, 'ignored');
	}

	const compositionState = new AiComposerCommandState();
	const composingComposer = {draftText: '/ai composition guard'};
	const composingSnapshot = compositionState.arm(
		composingComposer,
		composingComposer.draftText,
		'conversation-a',
	);
	const compositionResult = dispatchBrowserEnter(compositionState, composingSnapshot, {composingComposer});
	assert.equal(compositionResult.defaultPrevented, false);
	assert.equal(compositionResult.downstream, 1);
	assert.equal(compositionResult.outcome, 'ignored');
});

test('browser keydown routing protects a stale arm without consuming it', () => {
	const state = new AiComposerCommandState();
	const composer = {draftText: '/ai stale'};
	const snapshot = state.arm(composer, composer.draftText, 'conversation-a');

	assert.deepEqual(dispatchBrowserEnter(state, snapshot, {isCurrent: () => false}), {
		consumed: 0,
		defaultPrevented: true,
		downstream: 0,
		invalidated: 1,
		outcome: 'protected-stale',
	});
});

test('browser send routing dispatches pointer and click through composedPath safely', () => {
	for (const eventType of ['pointerdown', 'click']) {
		const state = new AiComposerCommandState();
		const composer = {draftText: '/ai send path'};
		const snapshot = state.arm(composer, composer.draftText, 'conversation-a');
		const target = new EventTarget();
		const sendControl = new EventTarget();
		const event = new RoutedEvent(eventType, [sendControl]);
		let consumed = 0;
		let downstream = 0;
		let outcome;
		target.addEventListener(eventType, candidate => {
			outcome = routeAiComposerBrowserSend(candidate, {
				...browserRouteOptions(state, snapshot, {
					onConsume() {
						consumed += 1;
					},
				}),
				fallbackComposer: undefined,
				isSendControl: candidateNode => candidateNode === sendControl,
			});
		}, {capture: true});
		target.addEventListener(eventType, () => {
			downstream += 1;
		}, {capture: true});
		target.dispatchEvent(event);

		assert.equal(outcome, 'protected-consumed');
		assert.equal(consumed, 1);
		assert.equal(event.defaultPrevented, true);
		assert.equal(downstream, 0);
	}
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

test('only an ordinary Enter key has command submission semantics', () => {
	assert.equal(isNormalAiComposerEnter(enterEvent), true);
	assert.equal(isNormalAiComposerEnter({...enterEvent, key: 'Tab'}), false);
	assert.equal(isNormalAiComposerEnter({...enterEvent, isComposing: true}), false);
	assert.equal(isNormalAiComposerEnter({...enterEvent, keyCode: 229}), false);
	assert.equal(isNormalAiComposerEnter({...enterEvent, shiftKey: true}), false);
});

test('localized send controls remain recognizable through their Enter hint', () => {
	assert.equal(isAiComposerSendControlDescription('Press Enter to send'), true);
	assert.equal(isAiComposerSendControlDescription('按 Enter 即可傳送'), true);
	assert.equal(isAiComposerSendControlDescription('Open more actions'), false);
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
