const assert = require('node:assert/strict');
const test = require('node:test');
const {
	AiComposerCommandState,
	consumeAiComposerCommand,
	parseAiComposerCommand,
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
