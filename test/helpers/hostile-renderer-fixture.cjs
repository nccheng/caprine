'use strict';

function documentFixture() {
	const elements = new Map();
	return {
		add(id, textContent) {
			const element = {id, textContent};
			elements.set(id, element);
			return element;
		},
		querySelector(selector) {
			return selector.startsWith('#') ? elements.get(selector.slice(1)) : undefined;
		},
		textContents() {
			return [...elements.values()].map(element => element.textContent);
		},
		remove(selector) {
			if (selector.startsWith('#')) {
				elements.delete(selector.slice(1));
			}
		},
	};
}

function createHostileRendererFixture(panelUrl = 'file:///caprine/static/ai-assist/index.html') {
	const messengerMainFrame = {
		origin: 'https://www.facebook.com',
		url: 'https://www.facebook.com/messages/t/thread-alpha',
	};
	const messengerWebContents = {mainFrame: messengerMainFrame};
	const panelMainFrame = {origin: 'file://', url: panelUrl};
	const panelWebContents = {mainFrame: panelMainFrame};
	const panelWindow = {
		destroyed: false,
		isDestroyed() {
			return this.destroyed;
		},
		webContents: panelWebContents,
	};
	const messengerDocument = documentFixture();
	const panelDocument = documentFixture();
	const mainOnly = {
		apiKey: 'fixture-key-kept-in-main',
		privateAnswer: 'fixture-answer-kept-in-panel',
	};
	panelDocument.add('answer-text', mainOnly.privateAnswer);

	return {
		mainOnly,
		messengerDocument,
		messengerMainEvent: {sender: messengerWebContents, senderFrame: messengerMainFrame},
		messengerSubframeEvent: {
			sender: messengerWebContents,
			senderFrame: {
				origin: messengerMainFrame.origin,
				url: `${messengerMainFrame.url}/embedded`,
			},
		},
		missingFrameEvent: {sender: messengerWebContents, senderFrame: undefined},
		panelDocument,
		panelEvent: {sender: panelWebContents, senderFrame: panelMainFrame},
		panelUrl,
		panelWindow,
		untrustedOriginEvent: {
			sender: messengerWebContents,
			senderFrame: {
				origin: 'https://attacker.example',
				url: 'https://attacker.example/messages',
			},
		},
		wrongWindowEvent: {
			sender: {mainFrame: messengerMainFrame},
			senderFrame: messengerMainFrame,
		},
	};
}

module.exports = {createHostileRendererFixture};
