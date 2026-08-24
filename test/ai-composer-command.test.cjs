const assert = require('node:assert/strict');
const test = require('node:test');
const {
	AiComposerCommandState,
	AiComposerCompositionState,
	AiComposerSendGestureGuard,
	armAiComposerFromBrowserEvent,
	consumeAiComposerCommand,
	isAiComposerCompositionConfirmation,
	isAiComposerImeParagraphInputType,
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
			compositionActive: options.compositionActive ?? false,
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

function dispatchImeBeforeInput(inputType, protectedCommand = true) {
	const target = new EventTarget();
	const event = new Event('beforeinput', {bubbles: true, cancelable: true});
	Object.defineProperty(event, 'inputType', {value: inputType});
	let downstream = 0;
	target.addEventListener('beforeinput', candidate => {
		if (protectedCommand && isAiComposerImeParagraphInputType(candidate.inputType)) {
			candidate.preventDefault();
			candidate.stopImmediatePropagation();
		}
	}, {capture: true});
	target.addEventListener('beforeinput', () => {
		downstream += 1;
	}, {capture: true});
	target.dispatchEvent(event);
	return {defaultPrevented: event.defaultPrevented, downstream};
}

function browserRouteOptions(state, snapshot, overrides = {}) {
	const conversationId = Object.hasOwn(overrides, 'conversationId')
		? overrides.conversationId
		: 'conversation-a';
	return {
		activeElement: overrides.activeElement,
		armCurrent: overrides.armCurrent
			?? (composer => {
				overrides.onArm?.(composer);
				return state.arm(composer, composer.draftText, conversationId);
			}),
		blocksArmedFallback: overrides.blocksArmedFallback ?? (() => false),
		commandFromComposer: overrides.commandFromComposer
			?? (composer => parseAiComposerCommand(composer.draftText)),
		composerFromNode: overrides.composerFromNode ?? (() => undefined),
		compositionActive: overrides.compositionActive ?? false,
		consume(candidate) {
			overrides.onConsume?.(candidate);
		},
		invalidate() {
			overrides.onInvalidate?.();
			state.invalidate();
		},
		isCurrent: overrides.isCurrent
			?? (candidate => state.matches(candidate, snapshotState(candidate))),
		fallbackComposer: overrides.fallbackComposer,
		snapshot,
	};
}

function dispatchBrowserEnter(state, snapshot, overrides = {}) {
	const target = overrides.target ?? new EventTarget();
	const event = new RoutedEvent('keydown', overrides.routePath, overrides.event);
	let consumed = 0;
	let downstream = 0;
	let invalidated = 0;
	let prompt;
	let outcome;
	target.addEventListener('keydown', candidate => {
		outcome = routeAiComposerBrowserEnter(candidate, browserRouteOptions(state, snapshot, {
			...overrides,
			onConsume(candidate) {
				consumed += 1;
				prompt = candidate.command.prompt;
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
		...(overrides.capturePrompt && prompt !== undefined ? {prompt} : {}),
	};
}

function dispatchBrowserSend(state, snapshot, overrides = {}) {
	const eventType = overrides.eventType ?? 'click';
	const target = overrides.target ?? new EventTarget();
	const event = new RoutedEvent(eventType, overrides.routePath);
	let armed = 0;
	let consumed = 0;
	let downstream = 0;
	let invalidated = 0;
	let prompt;
	let outcome;
	target.addEventListener(eventType, candidate => {
		const routeOptions = browserRouteOptions(state, snapshot, {
			...overrides,
			onArm(composer) {
				armed += 1;
				overrides.onArm?.(composer);
			},
			onConsume(candidateSnapshot) {
				consumed += 1;
				prompt = candidateSnapshot.command.prompt;
				overrides.onConsume?.(candidateSnapshot);
			},
			onInvalidate() {
				invalidated += 1;
				overrides.onInvalidate?.();
			},
		});
		outcome = routeAiComposerBrowserSend(candidate, {
			armCurrent: routeOptions.armCurrent,
			commandFromComposer: routeOptions.commandFromComposer,
			compositionActive: routeOptions.compositionActive,
			consume: routeOptions.consume,
			invalidate: routeOptions.invalidate,
			isCurrent: routeOptions.isCurrent,
			liveComposer: overrides.liveComposer,
			ownership: overrides.ownership ?? (overrides.liveComposer ? 'unique' : 'unresolved'),
			protectEvent: overrides.protectEvent ?? false,
			snapshot,
		});
	}, {capture: true});
	target.addEventListener(eventType, () => {
		downstream += 1;
	}, {capture: true});
	target.dispatchEvent(event);
	return {
		armed,
		consumed,
		defaultPrevented: event.defaultPrevented,
		downstream,
		invalidated,
		outcome,
		...(overrides.capturePrompt && prompt !== undefined ? {prompt} : {}),
	};
}

function preflightHandledImeSend(state, composition, markers, options) {
	const {liveComposer, ownership = 'unique'} = options;
	if (
		ownership === 'unique'
		&& liveComposer
		&& markers.handled === liveComposer
		&& composition.current() === liveComposer
		&& parseAiComposerCommand(liveComposer.draftText)
	) {
		composition.finish();
		markers.pending = undefined;
		markers.handled = undefined;
		state.arm(liveComposer, liveComposer.draftText, 'conversation-a');
	}

	return state.current();
}

function isImeEnterKeyup(event) {
	return event.key === 'Enter'
		|| event.code === 'Enter'
		|| event.keyCode === 13
		|| event.keyCode === 229;
}

function completeCapsLockComposition(composition, authoritativeComposer, event) {
	const compositionComposer = composition.current();
	if (
		(event.key !== 'CapsLock' && event.code !== 'CapsLock')
		|| event.isComposing
		|| !compositionComposer
		|| authoritativeComposer !== compositionComposer
		|| compositionComposer.isConnected === false
		|| compositionComposer.matchesComposer === false
	) {
		return;
	}

	return composition.finish();
}

test('browser keydown routing consumes an arm when the dispatched target cannot resolve', () => {
	const state = new AiComposerCommandState();
	const composer = {draftText: '/ai dispatched'};
	const snapshot = state.arm(composer, composer.draftText, 'conversation-a');

	assert.deepEqual(dispatchBrowserEnter(state, snapshot, {fallbackComposer: composer}), {
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

test('browser keydown routing leaves normal messages and Shift Enter untouched but contains AI IME confirmation', () => {
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

	for (const event of [{isComposing: true}, {keyCode: 229}]) {
		const state = new AiComposerCommandState();
		const composer = {draftText: '/ai composing'};
		const snapshot = state.arm(composer, composer.draftText, 'conversation-a');
		const result = dispatchBrowserEnter(state, snapshot, {event, fallbackComposer: composer});
		assert.equal(result.defaultPrevented, false);
		assert.equal(result.downstream, 0);
		assert.equal(result.consumed, 0);
		assert.equal(result.invalidated, 0);
		assert.equal(result.outcome, 'protected-stale');
		assert.equal(composer.draftText, '/ai composing');
	}

	const shiftState = new AiComposerCommandState();
	const shiftComposer = {draftText: '/ai multiline'};
	const shiftSnapshot = shiftState.arm(shiftComposer, shiftComposer.draftText, 'conversation-a');
	assert.deepEqual(dispatchBrowserEnter(shiftState, shiftSnapshot, {
		event: {shiftKey: true},
		fallbackComposer: shiftComposer,
	}), {
		consumed: 0,
		defaultPrevented: false,
		downstream: 1,
		invalidated: 0,
		outcome: 'ignored',
	});

	const compositionCommandState = new AiComposerCommandState();
	const composingComposer = {draftText: '/ai composition guard'};
	const composingSnapshot = compositionCommandState.arm(
		composingComposer,
		composingComposer.draftText,
		'conversation-a',
	);
	const compositionResult = dispatchBrowserEnter(compositionCommandState, composingSnapshot, {
		compositionActive: true,
		fallbackComposer: composingComposer,
	});
	assert.equal(compositionResult.defaultPrevented, true);
	assert.equal(compositionResult.downstream, 0);
	assert.equal(compositionResult.consumed, 1);
	assert.equal(compositionResult.outcome, 'protected-consumed');

	const chineseState = new AiComposerCommandState();
	const chineseComposer = {draftText: '一般中文訊息'};
	const chineseResult = dispatchBrowserEnter(chineseState, undefined, {
		compositionActive: true,
		event: {isComposing: true},
		fallbackComposer: chineseComposer,
	});
	assert.equal(chineseResult.defaultPrevented, false);
	assert.equal(chineseResult.downstream, 1);
	assert.equal(chineseResult.consumed, 0);
	assert.equal(chineseResult.outcome, 'ignored');
});

test('IME paragraph input is suppressed without blocking composition text or normal Chinese messages', () => {
	for (const inputType of ['insertParagraph', 'insertLineBreak']) {
		assert.deepEqual(dispatchImeBeforeInput(inputType), {
			defaultPrevented: true,
			downstream: 0,
		});
	}

	assert.deepEqual(dispatchImeBeforeInput('insertCompositionText'), {
		defaultPrevented: false,
		downstream: 1,
	});
	assert.deepEqual(dispatchImeBeforeInput('insertFromComposition'), {
		defaultPrevented: false,
		downstream: 1,
	});
	assert.deepEqual(dispatchImeBeforeInput('insertParagraph', false), {
		defaultPrevented: false,
		downstream: 1,
	});
});

test('stale composition state recovers in the same normal Enter while genuine IME Enter stays protected', () => {
	assert.equal(isAiComposerCompositionConfirmation(enterEvent), false);
	assert.equal(isAiComposerCompositionConfirmation({...enterEvent, isComposing: true}), true);
	assert.equal(isAiComposerCompositionConfirmation({...enterEvent, keyCode: 229}), true);

	const state = new AiComposerCommandState();
	const composition = new AiComposerCompositionState();
	const composer = {draftText: '/ai 你好'};
	composition.start(composer);
	let pendingImeEnter;
	if (
		!isAiComposerCompositionConfirmation(enterEvent)
		&& parseAiComposerCommand(composer.draftText)
		&& composition.isActive()
	) {
		composition.finish();
		pendingImeEnter = undefined;
	}

	const snapshot = state.arm(composer, composer.draftText, 'conversation-a');
	assert.equal(composition.isActive(), false);
	assert.deepEqual(dispatchBrowserEnter(state, snapshot, {
		capturePrompt: true,
		compositionActive: composition.isActive(),
		fallbackComposer: composer,
	}), {
		consumed: 1,
		defaultPrevented: true,
		downstream: 0,
		invalidated: 0,
		outcome: 'protected-consumed',
		prompt: '你好',
	});
	assert.equal(pendingImeEnter, undefined);

	for (const event of [{...enterEvent, isComposing: true}, {...enterEvent, keyCode: 229}]) {
		const protectedState = new AiComposerCommandState();
		const protectedComposition = new AiComposerCompositionState();
		const protectedComposer = {draftText: '/ai 你好'};
		const protectedSnapshot = protectedState.arm(
			protectedComposer,
			protectedComposer.draftText,
			'conversation-a',
		);
		protectedComposition.start(protectedComposer);
		const protectedPending = isAiComposerCompositionConfirmation(event)
			? protectedComposer
			: undefined;
		const result = dispatchBrowserEnter(protectedState, protectedSnapshot, {
			compositionActive: protectedComposition.isActive(),
			event,
			fallbackComposer: protectedComposer,
		});
		assert.equal(result.defaultPrevented, false);
		assert.equal(result.downstream, 0);
		assert.equal(result.consumed, 0);
		assert.equal(result.outcome, 'protected-stale');
		assert.equal(protectedComposition.isActive(), true);
		assert.equal(protectedPending, protectedComposer);
		assert.equal(protectedComposer.draftText, '/ai 你好');
	}
});

test('paragraph suppression hands IME completion to keyup and leaves Send and later commands usable', async () => {
	const state = new AiComposerCommandState();
	const composition = new AiComposerCompositionState();
	const composer = {draftText: '/ai 你好'};
	composition.start(composer);
	let pendingImeEnter = composer;
	let handledImeEnter;

	assert.deepEqual(dispatchImeBeforeInput('insertParagraph'), {
		defaultPrevented: true,
		downstream: 0,
	});
	handledImeEnter = pendingImeEnter;
	pendingImeEnter = undefined;
	assert.equal(composition.isActive(), true);

	const keyup = {code: 'Enter', key: 'Process', keyCode: 229};
	if (isImeEnterKeyup(keyup)) {
		const keyupComposer = pendingImeEnter ?? handledImeEnter;
		pendingImeEnter = undefined;
		handledImeEnter = undefined;
		if (composition.current() === keyupComposer) {
			composition.finish();
		}
	}

	await Promise.resolve();
	const committedSnapshot = state.arm(composer, composer.draftText, 'conversation-a');
	assert.equal(pendingImeEnter, undefined);
	assert.equal(handledImeEnter, undefined);
	assert.equal(composition.isActive(), false);
	assert.equal(composer.draftText, '/ai 你好');
	assert.equal(state.current(), committedSnapshot);

	assert.deepEqual(dispatchBrowserSend(state, committedSnapshot, {
		capturePrompt: true,
		compositionActive: composition.isActive(),
		liveComposer: composer,
	}), {
		armed: 0,
		consumed: 1,
		defaultPrevented: true,
		downstream: 0,
		invalidated: 0,
		outcome: 'protected-consumed',
		prompt: '你好',
	});

	composer.draftText = '/ai hello';
	const laterSnapshot = state.arm(composer, composer.draftText, 'conversation-a');
	assert.deepEqual(dispatchBrowserEnter(state, laterSnapshot, {
		capturePrompt: true,
		fallbackComposer: composer,
	}), {
		consumed: 1,
		defaultPrevented: true,
		downstream: 0,
		invalidated: 0,
		outcome: 'protected-consumed',
		prompt: 'hello',
	});
});

test('handled IME Send preflight consumes once for pointer and keyboard activation', () => {
	for (const eventType of ['pointerdown', 'click']) {
		const state = new AiComposerCommandState();
		const composition = new AiComposerCompositionState();
		const composer = {draftText: '/ai 你好'};
		const oldSnapshot = state.arm(composer, composer.draftText, 'conversation-a');
		const markers = {handled: composer, pending: composer};
		composition.start(composer);

		const snapshot = preflightHandledImeSend(state, composition, markers, {liveComposer: composer});
		assert.notEqual(snapshot, oldSnapshot);
		assert.equal(snapshot.composer, composer);
		assert.equal(composition.isActive(), false);
		assert.equal(markers.pending, undefined);
		assert.equal(markers.handled, undefined);

		let actualConsumes = 0;
		const result = dispatchBrowserSend(state, snapshot, {
			capturePrompt: true,
			compositionActive: composition.isActive(),
			eventType,
			liveComposer: composer,
			onConsume() {
				actualConsumes += 1;
			},
		});
		assert.deepEqual(result, {
			armed: 0,
			consumed: 1,
			defaultPrevented: true,
			downstream: 0,
			invalidated: 0,
			outcome: 'protected-consumed',
			prompt: '你好',
		});

		if (eventType === 'pointerdown') {
			const guard = new AiComposerSendGestureGuard();
			const sendControl = new EventTarget();
			guard.arm(sendControl);
			const clickTarget = new EventTarget();
			const click = new RoutedEvent('click', [sendControl]);
			let downstream = 0;
			clickTarget.addEventListener('click', event => {
				if (guard.protectsClick(sendControl)) {
					event.preventDefault();
					event.stopImmediatePropagation();
				}
			}, {capture: true});
			clickTarget.addEventListener('click', () => {
				downstream += 1;
			}, {capture: true});
			clickTarget.dispatchEvent(click);
			assert.equal(click.defaultPrevented, true);
			assert.equal(downstream, 0);
		}

		assert.equal(actualConsumes, 1);
	}
});

test('Send preflight requires the handled marker to match the authoritative composer', () => {
	for (const scenario of ['missing', 'different-composer']) {
		const state = new AiComposerCommandState();
		const composition = new AiComposerCompositionState();
		const composerA = {draftText: '/ai stale'};
		const composerB = scenario === 'missing' ? composerA : {draftText: '/ai current'};
		const snapshot = state.arm(composerB, composerB.draftText, 'conversation-a');
		const markers = {
			handled: scenario === 'missing' ? undefined : composerA,
			pending: undefined,
		};
		composition.start(composerA);

		assert.equal(preflightHandledImeSend(state, composition, markers, {liveComposer: composerB}), snapshot);
		assert.equal(composition.isActive(), true);
		assert.deepEqual(dispatchBrowserSend(state, snapshot, {
			compositionActive: composition.isActive(),
			liveComposer: composerB,
		}), {
			armed: 0,
			consumed: 0,
			defaultPrevented: true,
			downstream: 0,
			invalidated: 0,
			outcome: 'protected-stale',
		});
		assert.equal(composerB.draftText, scenario === 'missing' ? '/ai stale' : '/ai current');
	}
});

test('Caps Lock keyup representations finish and rearm without intercepting the key event', async () => {
	await Promise.all([
		{code: 'CapsLock', isComposing: false, key: 'CapsLock'},
		{code: 'CapsLock', isComposing: false, key: 'Process'},
	].map(async keyup => {
		const state = new AiComposerCommandState();
		const composition = new AiComposerCompositionState();
		const composer = {draftText: '/ai 你好', isConnected: true, matchesComposer: true};
		const {calls, event} = protectedEnterEvent(keyup);
		composition.start(composer);

		assert.equal(completeCapsLockComposition(composition, composer, event), composer);
		assert.equal(composition.isActive(), false);
		assert.equal(calls.prevented, 0);
		assert.equal(calls.stopped, 0);
		assert.equal(composer.draftText, '/ai 你好');
		assert.equal(state.current(), undefined);

		await Promise.resolve();
		const snapshot = state.arm(composer, composer.draftText, 'conversation-a');
		assert.equal(snapshot.composer, composer);
		assert.equal(snapshot.command.prompt, '你好');
	}));
});

test('Caps Lock completion allows one Send action and guards its paired click', async () => {
	const state = new AiComposerCommandState();
	const composition = new AiComposerCompositionState();
	const composer = {draftText: '/ai 你好', isConnected: true, matchesComposer: true};
	composition.start(composer);
	assert.equal(completeCapsLockComposition(composition, composer, {
		code: 'CapsLock',
		isComposing: false,
		key: 'CapsLock',
	}), composer);

	await Promise.resolve();
	const snapshot = state.arm(composer, composer.draftText, 'conversation-a');
	let consumes = 0;
	const pointerResult = dispatchBrowserSend(state, snapshot, {
		capturePrompt: true,
		eventType: 'pointerdown',
		liveComposer: composer,
		onConsume() {
			consumes += 1;
		},
	});
	assert.deepEqual(pointerResult, {
		armed: 0,
		consumed: 1,
		defaultPrevented: true,
		downstream: 0,
		invalidated: 0,
		outcome: 'protected-consumed',
		prompt: '你好',
	});

	const guard = new AiComposerSendGestureGuard();
	const sendControl = new EventTarget();
	guard.arm(sendControl);
	const clickTarget = new EventTarget();
	const click = new RoutedEvent('click', [sendControl]);
	let downstream = 0;
	clickTarget.addEventListener('click', event => {
		if (guard.protectsClick(sendControl)) {
			event.preventDefault();
			event.stopImmediatePropagation();
		}
	}, {capture: true});
	clickTarget.addEventListener('click', () => {
		downstream += 1;
	}, {capture: true});
	clickTarget.dispatchEvent(click);
	assert.equal(consumes, 1);
	assert.equal(click.defaultPrevented, true);
	assert.equal(downstream, 0);
});

test('Caps Lock completion allows ordinary Enter and leaves the session unpoisoned', async () => {
	const state = new AiComposerCommandState();
	const composition = new AiComposerCompositionState();
	const composer = {draftText: '/ai 你好', isConnected: true, matchesComposer: true};
	composition.start(composer);
	completeCapsLockComposition(composition, composer, {
		code: 'CapsLock',
		isComposing: false,
		key: 'Process',
	});
	await Promise.resolve();
	const snapshot = state.arm(composer, composer.draftText, 'conversation-a');
	assert.equal(dispatchBrowserEnter(state, snapshot, {
		capturePrompt: true,
		fallbackComposer: composer,
	}).prompt, '你好');

	composer.draftText = '/ai hello';
	const laterSnapshot = state.arm(composer, composer.draftText, 'conversation-a');
	assert.equal(dispatchBrowserEnter(state, laterSnapshot, {
		capturePrompt: true,
		fallbackComposer: composer,
	}).prompt, 'hello');
});

test('Caps Lock completion ignores active or foreign composition and preserves normal Chinese text', async () => {
	const composition = new AiComposerCompositionState();
	const composerA = {draftText: '/ai partial', isConnected: true, matchesComposer: true};
	const composerB = {draftText: '/ai other', isConnected: true, matchesComposer: true};
	composition.start(composerA);
	assert.equal(completeCapsLockComposition(composition, composerA, {
		code: 'CapsLock',
		isComposing: true,
		key: 'CapsLock',
	}), undefined);
	assert.equal(composition.current(), composerA);
	assert.equal(completeCapsLockComposition(composition, composerB, {
		code: 'CapsLock',
		isComposing: false,
		key: 'CapsLock',
	}), undefined);
	assert.equal(composition.current(), composerA);

	const normalState = new AiComposerCommandState();
	const normalComposition = new AiComposerCompositionState();
	const normalComposer = {draftText: '一般中文訊息', isConnected: true, matchesComposer: true};
	normalComposition.start(normalComposer);
	assert.equal(completeCapsLockComposition(normalComposition, normalComposer, {
		code: 'CapsLock',
		isComposing: false,
		key: 'CapsLock',
	}), normalComposer);
	await Promise.resolve();
	assert.equal(parseAiComposerCommand(normalComposer.draftText), undefined);
	assert.equal(normalState.current(), undefined);
	assert.equal(dispatchBrowserSend(normalState, undefined, {
		liveComposer: normalComposer,
	}).outcome, 'ignored');
});

test('non-composing input can finish the focused composition owner without trusting unrelated input', () => {
	const state = new AiComposerCommandState();
	const composition = new AiComposerCompositionState();
	const composer = {draftText: '/ai 你好'};
	composition.start(composer);

	const unresolvedInput = resolveAiComposerFromEventSignals({
		activeElement: undefined,
		armedComposer: undefined,
		composedPath: [],
		target: new EventTarget(),
	}, () => undefined, () => false);
	const authoritativeComposer = composer;
	if (
		composition.current()
		&& !unresolvedInput.blockedArmedFallback
		&& authoritativeComposer === composition.current()
	) {
		composition.finish();
	}

	const snapshot = state.arm(authoritativeComposer, authoritativeComposer.draftText, 'conversation-a');
	assert.equal(composition.isActive(), false);
	assert.equal(dispatchBrowserEnter(state, snapshot, {
		fallbackComposer: authoritativeComposer,
	}).outcome, 'protected-consumed');

	const unrelatedComposition = new AiComposerCompositionState();
	unrelatedComposition.start(composer);
	const unrelatedInput = resolveAiComposerFromEventSignals({
		activeElement: undefined,
		armedComposer: undefined,
		composedPath: [],
		target: new EventTarget(),
	}, () => undefined, () => true);
	if (
		unrelatedComposition.current()
		&& !unrelatedInput.blockedArmedFallback
		&& authoritativeComposer === unrelatedComposition.current()
	) {
		unrelatedComposition.finish();
	}

	assert.equal(unrelatedComposition.isActive(), true);
});

test('composition end clears a retargeted session and rearms a replacement composer', () => {
	const state = new AiComposerCommandState();
	const composition = new AiComposerCompositionState();
	const composerA = {draftText: '/ai 測'};
	const oldSnapshot = state.arm(composerA, composerA.draftText, 'conversation-a');
	composition.start(composerA);

	const commitEnter = dispatchBrowserEnter(state, oldSnapshot, {
		compositionActive: composition.isActive(),
		event: {isComposing: true},
		fallbackComposer: composerA,
	});
	assert.equal(commitEnter.defaultPrevented, false);
	assert.equal(commitEnter.consumed, 0);
	assert.equal(commitEnter.downstream, 0);

	const composerB = {draftText: '/ai 測試'};
	const composerBNode = new EventTarget();
	const retargetedEnd = resolveAiComposerFromEventSignals({
		activeElement: composerBNode,
		armedComposer: composerA,
		composedPath: [],
		target: new EventTarget(),
	}, node => node === composerBNode ? composerB : undefined, () => false);
	assert.equal(retargetedEnd.composer, composerB);
	assert.equal(composition.finish(), composerA);
	assert.equal(composition.isActive(), false);

	const replacementSnapshot = state.arm(composerB, composerB.draftText, 'conversation-a');
	assert.equal(state.matches(oldSnapshot, snapshotState(oldSnapshot)), false);
	assert.deepEqual(dispatchBrowserEnter(state, replacementSnapshot, {
		capturePrompt: true,
		composerFromNode: node => node === composerBNode ? composerB : undefined,
		routePath: [composerBNode],
	}), {
		consumed: 1,
		defaultPrevented: true,
		downstream: 0,
		invalidated: 0,
		outcome: 'protected-consumed',
		prompt: '測試',
	});

	const sendState = new AiComposerCommandState();
	const sendSnapshot = sendState.arm(composerB, composerB.draftText, 'conversation-a');
	const sendResult = dispatchBrowserSend(sendState, sendSnapshot, {
		capturePrompt: true,
		liveComposer: composerB,
	});
	assert.equal(sendResult.consumed, 1);
	assert.equal(sendResult.downstream, 0);
	assert.equal(sendResult.outcome, 'protected-consumed');
	assert.equal(sendResult.prompt, '測試');
});

test('committed non-composing input clears composition and the next Enter consumes once', () => {
	const state = new AiComposerCommandState();
	const composition = new AiComposerCompositionState();
	const composer = {draftText: '/ai 測試'};
	const snapshot = state.arm(composer, composer.draftText, 'conversation-a');
	composition.start(composer);

	const commitEnter = dispatchBrowserEnter(state, snapshot, {
		compositionActive: composition.isActive(),
		event: {keyCode: 229},
		fallbackComposer: composer,
	});
	assert.equal(commitEnter.defaultPrevented, false);
	assert.equal(commitEnter.consumed, 0);
	assert.equal(commitEnter.downstream, 0);
	assert.equal(composer.draftText, '/ai 測試');

	// Mirrors the trusted, non-composing InputEvent fail-safe before rearming.
	composition.finish();
	const committedSnapshot = state.arm(composer, composer.draftText, 'conversation-a');
	assert.equal(composition.isActive(), false);
	assert.deepEqual(dispatchBrowserEnter(state, committedSnapshot, {
		capturePrompt: true,
		fallbackComposer: composer,
	}), {
		consumed: 1,
		defaultPrevented: true,
		downstream: 0,
		invalidated: 0,
		outcome: 'protected-consumed',
		prompt: '測試',
	});
});

test('lost conversation authority clears only the owning composition guard', () => {
	const state = new AiComposerCommandState();
	const composition = new AiComposerCompositionState();
	const composer = {draftText: '/ai 你好', isConnected: true};
	let pendingImeEnter = composer;
	composition.start(composer);
	state.arm(composer, composer.draftText, 'conversation-a');
	const revalidate = conversationId => {
		const snapshot = state.current();
		const current = {
			composer,
			conversationId,
			draftText: composer.draftText,
			isConnected: composer.isConnected,
		};
		if (snapshot && !state.matches(snapshot, current)) {
			const lostAuthority = conversationId === undefined
				|| conversationId !== snapshot.conversationId
				|| !current.isConnected;
			if (composition.current() === snapshot.composer && lostAuthority) {
				composition.finish();
				pendingImeEnter = undefined;
			}

			state.invalidate();
		}
	};

	composer.draftText = '/ai 你好啊';
	revalidate('conversation-a');
	assert.equal(state.current(), undefined);
	assert.equal(composition.isActive(), true);
	assert.equal(pendingImeEnter, composer);

	composer.draftText = '/ai hello';
	state.arm(composer, composer.draftText, 'conversation-a');
	revalidate(undefined);
	assert.equal(state.current(), undefined);
	assert.equal(composition.isActive(), false);
	assert.equal(pendingImeEnter, undefined);
	assert.equal(composer.draftText, '/ai hello');

	const recommitted = state.arm(composer, composer.draftText, 'conversation-a');
	assert.deepEqual(dispatchBrowserEnter(state, recommitted, {
		capturePrompt: true,
		fallbackComposer: composer,
	}), {
		consumed: 1,
		defaultPrevented: true,
		downstream: 0,
		invalidated: 0,
		outcome: 'protected-consumed',
		prompt: 'hello',
	});
});

test('removed or unexpectedly cleared composition owners cannot poison the next AI command', () => {
	for (const failure of ['cleared', 'disconnected']) {
		const state = new AiComposerCommandState();
		const composition = new AiComposerCompositionState();
		const composerA = {draftText: '/ai old', isConnected: true};
		composition.start(composerA);
		composerA[failure === 'cleared' ? 'draftText' : 'isConnected'] = failure === 'cleared' ? '' : false;

		const owner = composition.current();
		if (owner && (!owner.isConnected || owner.draftText === '')) {
			composition.finish();
		}

		const composerB = {draftText: '/ai replacement'};
		const snapshot = state.arm(composerB, composerB.draftText, 'conversation-a');
		assert.equal(composition.isActive(), false);
		const result = dispatchBrowserEnter(state, snapshot, {
			capturePrompt: true,
			fallbackComposer: composerB,
		});
		assert.equal(result.consumed, 1);
		assert.equal(result.outcome, 'protected-consumed');
		assert.equal(result.prompt, 'replacement');
	}
});

test('paste-visible Enter freshly arms and consumes when no input snapshot exists yet', () => {
	const state = new AiComposerCommandState();
	const composer = {draftText: '/ai pasted question'};
	const target = new EventTarget();

	assert.deepEqual(dispatchBrowserEnter(state, undefined, {
		capturePrompt: true,
		composerFromNode: node => node === target ? composer : undefined,
		target,
	}), {
		consumed: 1,
		defaultPrevented: true,
		downstream: 0,
		invalidated: 0,
		outcome: 'protected-consumed',
		prompt: 'pasted question',
	});
	assert.equal(state.current().composer, composer);
});

test('paste-visible Enter without a stable conversation protects without consuming', () => {
	const state = new AiComposerCommandState();
	const composer = {draftText: '/ai no conversation'};
	const target = new EventTarget();

	assert.deepEqual(dispatchBrowserEnter(state, undefined, {
		composerFromNode: node => node === target ? composer : undefined,
		conversationId: undefined,
		target,
	}), {
		consumed: 0,
		defaultPrevented: true,
		downstream: 0,
		invalidated: 1,
		outcome: 'protected-stale',
	});
	assert.equal(state.current(), undefined);
});

test('input routing arms through composedPath or activeElement when target is unhelpful', () => {
	for (const resolutionSource of ['composedPath', 'activeElement']) {
		const state = new AiComposerCommandState();
		const composer = {draftText: '/ai input route'};
		const composerNode = new EventTarget();
		const target = new EventTarget();
		const event = new RoutedEvent('input', resolutionSource === 'composedPath' ? [composerNode] : []);
		let snapshot;
		target.addEventListener('input', candidate => {
			snapshot = armAiComposerFromBrowserEvent(candidate, {
				activeElement: resolutionSource === 'activeElement' ? composerNode : undefined,
				armedComposer: undefined,
				armCurrent: current => state.arm(current, current.draftText, 'conversation-a'),
				blocksArmedFallback: () => false,
				composerFromNode: node => node === composerNode ? composer : undefined,
			});
		}, {capture: true});
		target.dispatchEvent(event);

		assert.equal(snapshot.composer, composer);
		assert.equal(state.current(), snapshot);
	}
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

test('browser send routing dispatches pointer and click for the authoritative composer', () => {
	for (const eventType of ['pointerdown', 'click']) {
		const state = new AiComposerCommandState();
		const composer = {draftText: '/ai send path'};
		const snapshot = state.arm(composer, composer.draftText, 'conversation-a');

		assert.deepEqual(dispatchBrowserSend(state, snapshot, {
			eventType,
			liveComposer: composer,
		}), {
			armed: 0,
			consumed: 1,
			defaultPrevented: true,
			downstream: 0,
			invalidated: 0,
			outcome: 'protected-consumed',
		});
	}
});

test('armed send controls stay protected without mutation during active composition', () => {
	for (const eventType of ['pointerdown', 'click']) {
		const state = new AiComposerCommandState();
		const composition = new AiComposerCompositionState();
		const composer = {draftText: '/ai composing'};
		const snapshot = state.arm(composer, composer.draftText, 'conversation-a');
		composition.start(composer);

		assert.deepEqual(dispatchBrowserSend(state, snapshot, {
			compositionActive: composition.isActive(),
			eventType,
			liveComposer: composer,
		}), {
			armed: 0,
			consumed: 0,
			defaultPrevented: true,
			downstream: 0,
			invalidated: 0,
			outcome: 'protected-stale',
		});
		assert.equal(state.current(), snapshot);
		assert.equal(composer.draftText, '/ai composing');
		assert.equal(composition.isActive(), true);
	}
});

test('visible no-snapshot send stays protected and unarmed during active composition', () => {
	const state = new AiComposerCommandState();
	const composer = {draftText: '/ai composing'};

	assert.deepEqual(dispatchBrowserSend(state, undefined, {
		compositionActive: true,
		liveComposer: composer,
	}), {
		armed: 0,
		consumed: 0,
		defaultPrevented: true,
		downstream: 0,
		invalidated: 0,
		outcome: 'protected-stale',
	});
	assert.equal(state.current(), undefined);
	assert.equal(composer.draftText, '/ai composing');
});

test('stale composer send fresh-arms and consumes the live composer in one action', () => {
	for (const eventType of ['pointerdown', 'click']) {
		const state = new AiComposerCommandState();
		const composerA = {draftText: '/ai stale'};
		const composerB = {draftText: '/ai current question'};
		const snapshotA = state.arm(composerA, composerA.draftText, 'conversation-a');

		assert.deepEqual(dispatchBrowserSend(state, snapshotA, {
			capturePrompt: true,
			eventType,
			liveComposer: composerB,
		}), {
			armed: 1,
			consumed: 1,
			defaultPrevented: true,
			downstream: 0,
			invalidated: 1,
			outcome: 'protected-consumed',
			prompt: 'current question',
		});
		assert.equal(state.current().composer, composerB);
	}
});

test('unique focused composer wins when multiple structural candidates match the send control', () => {
	for (const eventType of ['pointerdown', 'click']) {
		const state = new AiComposerCommandState();
		const composerA = {draftText: '/ai stale A'};
		const composerB = {draftText: '/ai current B'};
		const snapshotA = state.arm(composerA, composerA.draftText, 'conversation-a');
		composerA.draftText = 'normal A';
		let consumedSnapshot;

		const result = dispatchBrowserSend(state, snapshotA, {
			capturePrompt: true,
			conversationId: 'conversation-b',
			eventType,
			liveComposer: composerB,
			onConsume(candidate) {
				consumedSnapshot = candidate;
			},
		});

		assert.equal(result.outcome, 'protected-consumed');
		assert.equal(result.defaultPrevented, true);
		assert.equal(result.downstream, 0);
		assert.equal(result.prompt, 'current B');
		assert.equal(consumedSnapshot.composer, composerB);
		assert.equal(consumedSnapshot.conversationId, 'conversation-b');
	}
});

test('normal authoritative composer passes through and invalidates another stale AI snapshot', () => {
	for (const eventType of ['pointerdown', 'click']) {
		const state = new AiComposerCommandState();
		const composerA = {draftText: '/ai stale A'};
		const composerB = {draftText: 'normal B'};
		const snapshotA = state.arm(composerA, composerA.draftText, 'conversation-a');

		assert.deepEqual(dispatchBrowserSend(state, snapshotA, {
			eventType,
			liveComposer: composerB,
		}), {
			armed: 0,
			consumed: 0,
			defaultPrevented: false,
			downstream: 1,
			invalidated: 1,
			outcome: 'ignored',
		});
	}
});

test('ambiguous visible ownership protects AI text without arming or consuming', () => {
	const state = new AiComposerCommandState();
	const composerA = {draftText: '/ai visible'};
	const composerB = {draftText: 'normal'};
	const snapshot = state.arm(composerA, composerA.draftText, 'conversation-a');

	assert.deepEqual(dispatchBrowserSend(state, snapshot, {
		ownership: 'ambiguous',
		protectEvent: true,
	}), {
		armed: 0,
		consumed: 0,
		defaultPrevented: true,
		downstream: 0,
		invalidated: 1,
		outcome: 'protected-stale',
	});
	assert.equal(state.current(), undefined);
	assert.equal(composerA.draftText, '/ai visible');
	assert.equal(composerB.draftText, 'normal');
});

test('stale composer Enter fresh-arms and consumes the live composer in one action', () => {
	const state = new AiComposerCommandState();
	const composerA = {draftText: '/ai stale'};
	const composerB = {draftText: '/ai replacement'};
	const snapshotA = state.arm(composerA, composerA.draftText, 'conversation-a');
	const composerBNode = new EventTarget();

	assert.deepEqual(dispatchBrowserEnter(state, snapshotA, {
		capturePrompt: true,
		composerFromNode: node => node === composerBNode ? composerB : undefined,
		routePath: [composerBNode],
	}), {
		consumed: 1,
		defaultPrevented: true,
		downstream: 0,
		invalidated: 1,
		outcome: 'protected-consumed',
		prompt: 'replacement',
	});
	assert.equal(state.current().composer, composerB);
});

test('authoritative live composer outranks the snapshot but stale same-composer authority cannot rearm', () => {
	const liveState = new AiComposerCommandState();
	const composerA = {draftText: '/ai stale'};
	const composerB = {draftText: '/ai current'};
	const snapshotA = liveState.arm(composerA, composerA.draftText, 'conversation-a');
	assert.equal(dispatchBrowserSend(liveState, snapshotA, {
		capturePrompt: true,
		liveComposer: composerB,
	}).prompt, 'current');
	assert.equal(liveState.current().composer, composerB);

	const armedOnlyState = new AiComposerCommandState();
	const armedOnlyComposer = {draftText: '/ai stale only'};
	const armedOnlySnapshot = armedOnlyState.arm(
		armedOnlyComposer,
		armedOnlyComposer.draftText,
		'conversation-a',
	);
	assert.deepEqual(dispatchBrowserSend(armedOnlyState, armedOnlySnapshot, {
		isCurrent: () => false,
		liveComposer: armedOnlyComposer,
	}), {
		armed: 0,
		consumed: 0,
		defaultPrevented: true,
		downstream: 0,
		invalidated: 1,
		outcome: 'protected-stale',
	});
});

test('same composer reused by another conversation cannot consume stale authority', () => {
	const composer = {draftText: '/ai changed conversation'};
	const sendState = new AiComposerCommandState();
	const sendSnapshot = sendState.arm(composer, composer.draftText, 'conversation-a');
	assert.deepEqual(dispatchBrowserSend(sendState, sendSnapshot, {
		conversationId: 'conversation-b',
		isCurrent: () => false,
		liveComposer: composer,
	}), {
		armed: 0,
		consumed: 0,
		defaultPrevented: true,
		downstream: 0,
		invalidated: 1,
		outcome: 'protected-stale',
	});

	const enterState = new AiComposerCommandState();
	const enterSnapshot = enterState.arm(composer, composer.draftText, 'conversation-a');
	const composerNode = new EventTarget();
	assert.deepEqual(dispatchBrowserEnter(enterState, enterSnapshot, {
		composerFromNode: node => node === composerNode ? composer : undefined,
		conversationId: 'conversation-b',
		isCurrent: () => false,
		routePath: [composerNode],
	}), {
		consumed: 0,
		defaultPrevented: true,
		downstream: 0,
		invalidated: 1,
		outcome: 'protected-stale',
	});
});

test('stale recovery without a stable conversation protects but cannot consume live text', () => {
	const composerA = {draftText: '/ai stale'};
	const composerB = {draftText: '/ai current'};
	const sendState = new AiComposerCommandState();
	const sendSnapshotA = sendState.arm(composerA, composerA.draftText, 'conversation-a');

	assert.deepEqual(dispatchBrowserSend(sendState, sendSnapshotA, {
		conversationId: undefined,
		liveComposer: composerB,
	}), {
		armed: 1,
		consumed: 0,
		defaultPrevented: true,
		downstream: 0,
		invalidated: 1,
		outcome: 'protected-stale',
	});
	assert.equal(sendState.current(), undefined);

	const enterState = new AiComposerCommandState();
	const enterSnapshotA = enterState.arm(composerA, composerA.draftText, 'conversation-a');
	const composerBNode = new EventTarget();
	assert.deepEqual(dispatchBrowserEnter(enterState, enterSnapshotA, {
		composerFromNode: node => node === composerBNode ? composerB : undefined,
		conversationId: undefined,
		routePath: [composerBNode],
	}), {
		consumed: 0,
		defaultPrevented: true,
		downstream: 0,
		invalidated: 1,
		outcome: 'protected-stale',
	});
	assert.equal(enterState.current(), undefined);
});

test('normal live messages remain untouched even when another composer has stale authority', () => {
	const composerB = {draftText: 'normal message'};
	const composerBNode = new EventTarget();
	const enterState = new AiComposerCommandState();
	const enterComposerA = {draftText: '/ai stale'};
	const enterSnapshotA = enterState.arm(enterComposerA, enterComposerA.draftText, 'conversation-a');
	assert.deepEqual(dispatchBrowserEnter(enterState, enterSnapshotA, {
		composerFromNode: node => node === composerBNode ? composerB : undefined,
		routePath: [composerBNode],
	}), {
		consumed: 0,
		defaultPrevented: false,
		downstream: 1,
		invalidated: 1,
		outcome: 'ignored',
	});

	const sendState = new AiComposerCommandState();
	const sendComposerA = {draftText: '/ai stale'};
	const sendSnapshotA = sendState.arm(sendComposerA, sendComposerA.draftText, 'conversation-a');
	assert.deepEqual(dispatchBrowserSend(sendState, sendSnapshotA, {
		liveComposer: composerB,
	}), {
		armed: 0,
		consumed: 0,
		defaultPrevented: false,
		downstream: 1,
		invalidated: 1,
		outcome: 'ignored',
	});
});

test('protected pointerdown guards its paired click after the command clears', () => {
	const state = new AiComposerCommandState();
	const composer = {draftText: '/ai once'};
	const snapshot = state.arm(composer, composer.draftText, 'conversation-a');
	const sendControl = new EventTarget();
	const gestureGuard = new AiComposerSendGestureGuard();
	let actualConsumes = 0;
	const pointerResult = dispatchBrowserSend(state, snapshot, {
		eventType: 'pointerdown',
		liveComposer: composer,
		onConsume() {
			actualConsumes += 1;
			composer.draftText = '';
			state.invalidate();
		},
		routePath: [sendControl],
	});
	assert.equal(pointerResult.defaultPrevented, true);
	assert.equal(pointerResult.downstream, 0);
	assert.equal(pointerResult.outcome, 'protected-consumed');
	gestureGuard.arm(sendControl);

	const clickTarget = new EventTarget();
	const click = new RoutedEvent('click', [sendControl]);
	let clickDownstream = 0;
	clickTarget.addEventListener('click', event => {
		if (gestureGuard.protectsClick(sendControl)) {
			event.preventDefault();
			event.stopImmediatePropagation();
		}
	}, {capture: true});
	clickTarget.addEventListener('click', () => {
		clickDownstream += 1;
	}, {capture: true});
	clickTarget.dispatchEvent(click);

	assert.equal(actualConsumes, 1);
	assert.equal(click.defaultPrevented, true);
	assert.equal(clickDownstream, 0);
	assert.equal(gestureGuard.protectsClick(sendControl), false);
});

test('unrelated editable event signals reject the armed composer fallback', () => {
	const editable = {};
	const resolution = resolveAiComposerFromEventSignals({
		activeElement: editable,
		armedComposer: createComposer(),
		composedPath: [],
		target: {},
	}, () => undefined, node => node === editable);

	assert.deepEqual(resolution, {
		blockedArmedFallback: true,
		composer: undefined,
	});
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
