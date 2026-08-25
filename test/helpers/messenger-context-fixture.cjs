const {readFileSync} = require('node:fs');
const path = require('node:path');

function matchesSimpleSelector(element, selector) {
	const tagName = selector.match(/^[a-z]+/i)?.[0]?.toLowerCase();
	const attributeMatches = [...selector.matchAll(/\[([^\]]+)]/g)];
	const unparsed = selector
		.replace(/^[a-z]+/i, '')
		.replaceAll(/\[[^\]]+]/g, '')
		.trim();
	if (unparsed || (!tagName && attributeMatches.length === 0)) {
		return false;
	}

	if (tagName && element.localName !== tagName) {
		return false;
	}

	for (const match of attributeMatches) {
		const expression = match[1];
		const contains = expression.match(/^([^=*\s]+)\*="([^"]*)"\s+i$/i);
		if (contains) {
			const value = element.getAttribute(contains[1]);
			if (value === null || !value.toLowerCase().includes(contains[2].toLowerCase())) {
				return false;
			}

			continue;
		}

		const equality = expression.match(/^([^=\s]+)="([^"]*)"$/);
		if (equality) {
			if (element.getAttribute(equality[1]) !== equality[2]) {
				return false;
			}

			continue;
		}

		if (element.getAttribute(expression) === null) {
			return false;
		}
	}

	return true;
}

function matchesSelectorPart(element, selector) {
	for (const [ancestorSelector, descendantSelector] of [
		['[role="main"]', '[role="grid"]'],
		['[data-message-author]', 'img[alt]'],
	]) {
		if (selector === `${ancestorSelector} ${descendantSelector}`) {
			if (!matchesSimpleSelector(element, descendantSelector)) {
				return false;
			}

			for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
				if (matchesSimpleSelector(ancestor, ancestorSelector)) {
					return true;
				}
			}

			return false;
		}
	}

	return matchesSimpleSelector(element, selector);
}

class MessengerContextFixtureElement {
	constructor(fixture = {}, parentElement = null) {
		this.attributes = fixture.attributes ?? {};
		this.hidden = fixture.hidden ?? false;
		this.href = fixture.href;
		this.isConnected = fixture.isConnected ?? true;
		this.localName = fixture.tag ?? 'div';
		this.ownText = fixture.text ?? '';
		this.parentElement = parentElement;
		this.rectangle = fixture.rectangle ?? {
			height: 0, width: 0, x: 0, y: 0,
		};
		this.throwOnSelectors = fixture.throwOnSelectors ?? [];
		this.dataset = {
			messageId: this.attributes['data-message-id'],
			messageid: this.attributes['data-messageid'],
		};
		this.setChildren((fixture.children ?? []).map(child => new MessengerContextFixtureElement(child, this)));
	}

	closest(selector) {
		if (this.matches(selector)) {
			return this;
		}

		return this.parentElement?.closest(selector);
	}

	contains(target) {
		return target === this || this.children.some(child => child.contains(target));
	}

	get lastElementChild() {
		return this.children.at(-1) ?? null;
	}

	get textContent() {
		return this.ownText || this.children.map(child => child.textContent).join('');
	}

	getAttribute(name) {
		return this.attributes[name] ?? null;
	}

	getBoundingClientRect() {
		return {...this.rectangle};
	}

	getClientRects() {
		return this.hidden || this.rectangle.width <= 0 || this.rectangle.height <= 0
			? []
			: [{...this.rectangle}];
	}

	matches(selector) {
		return selector.split(',').some(part => matchesSelectorPart(this, part.trim()));
	}

	querySelector(selector) {
		return this.querySelectorAll(selector)[0];
	}

	querySelectorAll(selector) {
		if (this.throwOnSelectors.includes(selector)) {
			throw new Error(`Malformed fixture selector: ${selector}`);
		}

		const descendants = [];
		const visit = element => {
			for (const child of element.children) {
				descendants.push(child);
				visit(child);
			}
		};

		visit(this);
		return descendants.filter(element => element.matches(selector));
	}

	setChildren(children) {
		this.children = children;
		for (const [index, child] of children.entries()) {
			child.parentElement = this;
			child.previousElementSibling = children[index - 1] ?? null;
		}
	}
}

function loadMessengerContextFixture(filename) {
	const fixturePath = path.join(__dirname, '..', 'fixtures', 'messenger-context', filename);
	const source = readFileSync(fixturePath, 'utf8');
	const fixture = JSON.parse(source);
	const root = new MessengerContextFixtureElement(fixture.dom);

	return {
		...fixture,
		prependRows() {
			const conversation = root.querySelector('[role="main"] [role="grid"]');
			if (!conversation) {
				throw new Error('Fixture is missing its conversation grid');
			}

			const rows = (fixture.prependRows ?? [])
				.map(row => new MessengerContextFixtureElement(row, conversation));
			conversation.setChildren([...rows, ...conversation.children]);
		},
		root,
		source,
	};
}

module.exports = {loadMessengerContextFixture, MessengerContextFixtureElement};
