'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
	isExpectedLocalPanelSender,
	isExpectedMessengerSender,
} = require('../dist-js/ai-renderer-trust.js');
const {DraftInsertionAuthorizationState} = require('../dist-js/draft-insertion.js');
const {createHostileRendererFixture} = require('./helpers/hostile-renderer-fixture.cjs');

const fixture = createHostileRendererFixture();

test('hostile renderer cannot cross the Messenger or local-panel sender boundaries', () => {
	assert.equal(isExpectedMessengerSender(fixture.messengerMainEvent, fixture.messengerMainEvent.sender), true);
	assert.equal(isExpectedMessengerSender(fixture.messengerSubframeEvent, fixture.messengerMainEvent.sender), false);
	assert.equal(isExpectedMessengerSender(fixture.missingFrameEvent, fixture.messengerMainEvent.sender), false);
	assert.equal(isExpectedMessengerSender(fixture.untrustedOriginEvent, fixture.messengerMainEvent.sender), false);
	assert.equal(isExpectedMessengerSender(fixture.wrongWindowEvent, fixture.messengerMainEvent.sender), false);

	assert.equal(isExpectedLocalPanelSender(fixture.panelEvent, fixture.panelWindow, fixture.panelUrl), true);
	assert.equal(isExpectedLocalPanelSender(fixture.messengerMainEvent, fixture.panelWindow, fixture.panelUrl), false);
	assert.equal(isExpectedLocalPanelSender(fixture.messengerSubframeEvent, fixture.panelWindow, fixture.panelUrl), false);
	assert.equal(isExpectedLocalPanelSender(fixture.panelEvent, fixture.panelWindow, 'file:///wrong-panel.html'), false);

	fixture.panelWindow.destroyed = true;
	assert.equal(isExpectedLocalPanelSender(fixture.panelEvent, fixture.panelWindow, fixture.panelUrl), false);
	fixture.panelWindow.destroyed = false;
});

test('hostile Messenger document cannot read, spoof, or remove Caprine-owned private state', () => {
	assert.equal(fixture.messengerDocument.querySelector('#answer-text'), undefined);
	assert.equal(fixture.messengerDocument.textContents().includes(fixture.mainOnly.apiKey), false);
	assert.equal(fixture.messengerDocument.textContents().includes(fixture.mainOnly.privateAnswer), false);

	fixture.messengerDocument.add('answer-text', 'spoofed remote answer');
	assert.equal(fixture.messengerDocument.querySelector('#answer-text').textContent, 'spoofed remote answer');
	assert.equal(fixture.panelDocument.querySelector('#answer-text').textContent, fixture.mainOnly.privateAnswer);
	fixture.messengerDocument.remove('#answer-text');
	assert.equal(fixture.panelDocument.querySelector('#answer-text').textContent, fixture.mainOnly.privateAnswer);
});

test('replayed or stale one-shot insertion authority remains unusable after hostile attempts', () => {
	const state = new DraftInsertionAuthorizationState();
	const snapshot = {
		captureGeneration: 2,
		conversationId: 'fixture-thread-alpha',
		messengerWebContentsId: 7,
		sessionId: 'fixture-session',
	};
	const authorization = {
		answerGeneration: 3,
		authorizationToken: 'fixture-one-shot-token',
		conversationId: snapshot.conversationId,
		snapshot,
		text: 'fixture private answer',
	};
	state.issue(authorization);

	assert.equal(state.consume({...authorization, authorizationToken: 'hostile-replay-token'}, snapshot), undefined);
	assert.deepEqual(state.consume(authorization, snapshot), authorization);
	assert.equal(state.consume(authorization, snapshot), undefined);

	state.issue(authorization);
	assert.equal(state.consume(authorization, {...snapshot, conversationId: 'fixture-thread-beta'}), undefined);
	assert.equal(state.read(snapshot), undefined);
});

test('focused AI Assist command retains every regression group in one deterministic command', () => {
	const root = path.join(__dirname, '..');
	const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/ai-assist-regression-manifest.json'), 'utf8'));
	const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
	const command = packageJson.scripts['test:ai-assist'];

	for (const group of manifest.groups) {
		assert.ok(group.files.length > 0, `${group.name} must name focused evidence`);
		for (const file of group.files) {
			assert.equal(fs.existsSync(path.join(__dirname, file)), true, `${group.name}: missing ${file}`);
			assert.equal(command.includes(`test/${file}`), true, `${group.name}: ${file} is outside test:ai-assist`);
		}
	}
});
