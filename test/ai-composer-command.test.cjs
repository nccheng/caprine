const assert = require('node:assert/strict');
const test = require('node:test');
const {
	consumeAiComposerCommand,
	parseAiComposerCommand,
	shouldInterceptAiComposerEnter,
	shouldInterceptAiComposerSend,
} = require('../dist-js/ai-composer-command.js');

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
	assert.equal(shouldInterceptAiComposerEnter({
		isComposing: false,
		key: 'Enter',
		keyCode: 13,
		shiftKey: false,
	}, command), true);
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
