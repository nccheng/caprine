import {
	extractNativeMessengerSender,
	maximumMessengerDomExtractionItems,
	messengerContextSelectors,
} from './messenger-context';
import {
	caprineAiShareAssistantLabel,
	caprineAiShareSharerLabel,
	parseCaprineAiShareText,
	ParsedCaprineAiShareText,
} from './share-text-protocol';

export const caprineAiShareDecorationAttribute = 'data-caprine-ai-share-decoration';

export type CaprineAiShareDecorationViewModel = {
	assistantLabel: string;
	modelLabel: string;
	protocolVersion: string;
	sharerLabel?: string;
	sources: ParsedCaprineAiShareText['sources'];
};

function decorationFingerprint(viewModel: CaprineAiShareDecorationViewModel): string {
	return JSON.stringify(viewModel);
}

export function createCaprineAiShareDecorationViewModel(
	value: unknown,
	senderRole: 'incoming' | 'outgoing' | 'unknown',
): CaprineAiShareDecorationViewModel | undefined {
	if (!['incoming', 'outgoing'].includes(senderRole)) {
		return;
	}

	const parsed = parseCaprineAiShareText(value);
	if (!parsed) {
		return;
	}

	return {
		assistantLabel: caprineAiShareAssistantLabel,
		modelLabel: parsed.displayMetadata.modelLabel,
		protocolVersion: parsed.protocolVersion,
		...(senderRole === 'outgoing' ? {sharerLabel: caprineAiShareSharerLabel} : {}),
		sources: parsed.sources,
	};
}

function appendTextElement(parent: Element | ShadowRoot, tagName: string, text: string): HTMLElement {
	const element = parent.ownerDocument.createElement(tagName);
	element.textContent = text;
	parent.append(element);
	return element;
}

function createDecorationHost(document: Document, viewModel: CaprineAiShareDecorationViewModel): HTMLElement {
	const host = document.createElement('div');
	host.setAttribute(caprineAiShareDecorationAttribute, decorationFingerprint(viewModel));
	const shadow = host.attachShadow({mode: 'closed'});
	const style = document.createElement('style');
	style.textContent = `
		:host { display: block; margin: 4px 12px 0; color: #65676b; font: 12px/1.35 -apple-system, BlinkMacSystemFont, sans-serif; }
		section { display: flex; flex-wrap: wrap; gap: 3px 7px; align-items: baseline; }
		strong { color: inherit; font-weight: 600; }
		details { flex-basis: 100%; }
		summary { cursor: pointer; width: max-content; max-width: 100%; }
		summary:focus-visible { outline: 2px solid currentcolor; outline-offset: 2px; }
		ol { margin: 4px 0 0; padding-inline-start: 20px; }
		li { overflow-wrap: anywhere; }
		@media (prefers-reduced-motion: reduce) {
			*, *::before, *::after { scroll-behavior: auto !important; animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; }
		}
	`;
	shadow.append(style);
	const section = document.createElement('section');
	section.setAttribute('role', 'note');
	section.setAttribute('aria-label', 'Caprine AI Assist shared response metadata');
	appendTextElement(section, 'strong', viewModel.assistantLabel);
	appendTextElement(section, 'span', `Model: ${viewModel.modelLabel}`);
	if (viewModel.sharerLabel) {
		appendTextElement(section, 'span', viewModel.sharerLabel);
	}

	appendTextElement(section, 'span', 'Not an authenticated Messenger bot');
	if (viewModel.sources.length > 0) {
		const details = document.createElement('details');
		const summary = appendTextElement(details, 'summary', `Sources (${viewModel.sources.length})`);
		summary.setAttribute('aria-label', `${viewModel.sources.length} cited sources`);
		const list = document.createElement('ol');
		for (const source of viewModel.sources) {
			appendTextElement(list, 'li', source.title ? `${source.title} — ${source.url}` : source.url);
		}

		details.append(list);
		section.append(details);
	}

	shadow.append(section);
	return host;
}

function directMessageText(row: Element): string | undefined {
	const elements = [...row.querySelectorAll(messengerContextSelectors.messageText)]
		.filter(element => !element.closest(`[${caprineAiShareDecorationAttribute}]`));
	return elements.length === 1 ? elements[0].textContent ?? undefined : undefined;
}

function viewModelForRow(row: Element): CaprineAiShareDecorationViewModel | undefined {
	const sender = extractNativeMessengerSender(row);
	return createCaprineAiShareDecorationViewModel(directMessageText(row), sender?.role ?? 'unknown');
}

function stableMessageId(row: Element): string | undefined {
	const identity = row.matches(messengerContextSelectors.messageIdentity)
		? row
		: row.querySelector(messengerContextSelectors.messageIdentity);
	const value = identity?.getAttribute('data-message-id') ?? identity?.getAttribute('data-messageid');
	return value && value.length <= 200 && /^[\w.:-]+$/.test(value) ? value : undefined;
}

function reconcileResolvedDecoration(
	row: Element,
	viewModel: CaprineAiShareDecorationViewModel | undefined,
): boolean {
	const existing = [...row.querySelectorAll<HTMLElement>(`[${caprineAiShareDecorationAttribute}]`)]
		.filter(element => element.closest(messengerContextSelectors.message) === row);
	const fingerprint = viewModel ? decorationFingerprint(viewModel) : undefined;
	const retained = existing.find(element => element.getAttribute(caprineAiShareDecorationAttribute) === fingerprint);
	for (const element of existing) {
		if (element !== retained) {
			element.remove();
		}
	}

	if (!viewModel || retained) {
		return Boolean(retained);
	}

	row.append(createDecorationHost(row.ownerDocument, viewModel));
	return true;
}

export function reconcileCaprineAiShareDecoration(row: Element): boolean {
	return reconcileResolvedDecoration(row, viewModelForRow(row));
}

export function reconcileLoadedCaprineAiShareDecorations(root: ParentNode = document): number {
	try {
		const conversation = root.querySelector(messengerContextSelectors.conversation);
		if (!conversation) {
			return 0;
		}

		const allRows: Element[] = [];
		for (const row of conversation.querySelectorAll(messengerContextSelectors.message)) {
			try {
				if (!row.querySelector(messengerContextSelectors.message)) {
					allRows.push(row);
				}
			} catch {
				try {
					reconcileResolvedDecoration(row, undefined);
				} catch {}
			}
		}

		const rows = allRows.slice(-maximumMessengerDomExtractionItems);
		for (const row of allRows.slice(0, -maximumMessengerDomExtractionItems)) {
			try {
				reconcileResolvedDecoration(row, undefined);
			} catch {}
		}

		const viewModels = new Map<Element, CaprineAiShareDecorationViewModel | undefined>();
		for (const row of rows) {
			try {
				viewModels.set(row, viewModelForRow(row));
			} catch {
				viewModels.set(row, undefined);
			}
		}

		const identityGroups = new Map<string, Element[]>();
		for (const row of rows) {
			try {
				const identity = stableMessageId(row);
				if (identity) {
					identityGroups.set(identity, [...(identityGroups.get(identity) ?? []), row]);
				}
			} catch {}
		}

		const suppressedRows = new Set<Element>();
		for (const group of identityGroups.values()) {
			if (group.length < 2) {
				continue;
			}

			const fingerprints = group.map(row => {
				const viewModel = viewModels.get(row);
				return viewModel ? decorationFingerprint(viewModel) : undefined;
			});
			const isConsistent = fingerprints[0] !== undefined
				&& fingerprints.every(fingerprint => fingerprint === fingerprints[0]);
			for (const row of isConsistent ? group.slice(0, -1) : group) {
				suppressedRows.add(row);
			}
		}

		let decoratedCount = 0;
		for (const row of rows) {
			try {
				if (reconcileResolvedDecoration(row, suppressedRows.has(row) ? undefined : viewModels.get(row))) {
					decoratedCount += 1;
				}
			} catch {}
		}

		return decoratedCount;
	} catch {
		return 0;
	}
}

export function removeLoadedCaprineAiShareDecorations(root: ParentNode = document): void {
	try {
		for (const element of root.querySelectorAll(`[${caprineAiShareDecorationAttribute}]`)) {
			element.remove();
		}
	} catch {}
}
