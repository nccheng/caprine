const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
	extractLoadedMessengerMediaCandidates,
	messengerMediaSelectors,
	resolveMessengerMediaDomCandidate,
} = require('../dist-js/messenger-media-dom.js');

class FixtureElement {
	constructor(fixture, parentElement) {
		this.attributes = fixture.attributes ?? {};
		this.children = (fixture.children ?? []).map(child => new FixtureElement(child, this));
		this.currentSrc = fixture.currentSrc ?? '';
		this.dataset = {
			messageId: this.attributes['data-message-id'],
			messageid: this.attributes['data-messageid'],
		};
		this.duration = fixture.duration ?? Number.NaN;
		this.localName = fixture.tag;
		this.parentElement = parentElement;
		this.src = fixture.src ?? '';
	}

	closest(selector) {
		if (this.matches(selector)) {
			return this;
		}

		let ancestor = this.parentElement;
		while (ancestor) {
			if (ancestor.matches(selector)) {
				return ancestor;
			}

			ancestor = ancestor.parentElement;
		}
	}

	getAttribute(name) {
		if (name === 'src' && this.src) {
			return this.src;
		}

		return this.attributes[name] ?? null;
	}

	matches(selector) {
		return selector.split(',').some(part => {
			const normalized = part.trim();
			if (normalized === 'audio' || normalized === 'video') {
				return this.localName === normalized;
			}

			if (normalized === 'source[type]') {
				return this.localName === 'source' && this.attributes.type !== undefined;
			}

			if (normalized === '[data-message-id]') {
				return this.attributes['data-message-id'] !== undefined;
			}

			return normalized === '[data-messageid]'
				&& this.attributes['data-messageid'] !== undefined;
		});
	}

	querySelector(selector) {
		return this.querySelectorAll(selector)[0];
	}

	querySelectorAll(selector) {
		const descendants = [];
		const visit = element => {
			for (const child of element.children) {
				descendants.push(child);
				visit(child);
			}
		};

		visit(this);

		if (selector === messengerMediaSelectors.loadedMedia) {
			return descendants.filter(element => {
				if (!['audio', 'video'].includes(element.localName)) {
					return false;
				}

				let sawGrid = false;
				for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
					sawGrid ||= ancestor.attributes.role === 'grid';
					if (sawGrid && ancestor.attributes.role === 'main') {
						return true;
					}
				}

				return false;
			});
		}

		return descendants.filter(element => element.matches(selector));
	}
}

function loadFixture(filename) {
	const fixturePath = path.join(__dirname, 'fixtures', 'messenger-media', filename);
	const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
	return {...fixture, root: new FixtureElement(fixture.dom)};
}

for (const filename of [
	'voice-message.json',
	'video-message.json',
	'segmented-media-source.json',
]) {
	test(`Messenger media DOM fixture ${filename} reaches its expected resolver request`, () => {
		const fixture = loadFixture(filename);
		assert.deepEqual(extractLoadedMessengerMediaCandidates(fixture.root), [fixture.expectedCandidate]);
		assert.deepEqual(
			resolveMessengerMediaDomCandidate(
				fixture.root,
				fixture.expectedCandidate.messageId,
				fixture.expectedCandidate.kind,
			),
			fixture.expectedResolution,
		);
	});
}
