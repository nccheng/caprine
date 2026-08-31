export const conversationContextConfidenceLevels = ['high', 'medium', 'low'] as const;
export type ConversationContextConfidence = typeof conversationContextConfidenceLevels[number];
// This bounds loaded DOM traversal only; AI context selection belongs to a later layer.
export const maximumMessengerDomExtractionItems = 500;
export const maximumMessengerTailTraversalElements = 128;

export const conversationContextOmittedReasons = [
	'ambiguous-message',
	'incomplete-message',
	'malformed-message',
	'no-supported-content',
	'non-message-ui',
	'unsupported-message',
	'virtualized-placeholder',
] as const;
export type ConversationContextOmittedReason = typeof conversationContextOmittedReasons[number];

export const messengerContextDiagnosticReasons = [
	'conversation-root-missing',
	'message-rows-missing',
	'supported-content-missing',
	'ambiguous-messages',
	'adapter-error',
] as const;
export type MessengerContextDiagnosticReason = typeof messengerContextDiagnosticReasons[number];

export type ConversationContextAttachment = {
	kind: 'audio' | 'image' | 'video';
};

export type ConversationContextItem = {
	attachments?: ConversationContextAttachment[];
	confidence: ConversationContextConfidence;
	linkPreview?: {
		description?: string;
		domain: string;
		title?: string;
		url: string;
	};
	messageId?: string;
	omittedReason?: ConversationContextOmittedReason;
	reactions?: Array<{
		count: number;
		emoji: string;
	}>;
	reply?: {
		quotedSender?: string;
		text: string;
	};
	sender: {
		displayName?: string;
		role: 'incoming' | 'outgoing' | 'unknown';
	};
	text?: string;
	timestamp?: string;
};

export type MessengerMessageAnchor = {
	item: ConversationContextItem;
	loadedCount: number;
	loadedIndex: number;
};

export type MessengerContextCandidate = {
	attachments?: Array<'audio' | 'image' | 'video'>;
	domOrder: number;
	linkPreview?: {
		description?: string;
		domain?: string;
		title?: string;
		url?: string;
	};
	malformed?: boolean;
	omittedReason?: ConversationContextOmittedReason;
	reactions?: Array<{
		count?: number;
		emoji?: string;
	}>;
	reply?: {
		quotedSender?: string;
		text?: string;
	};
	senderDisplayName?: string;
	senderRole?: 'incoming' | 'outgoing';
	stableId?: string;
	text?: string;
	timestamp?: string;
	unsupported?: boolean;
};

export const messengerContextSelectors = {
	conversation: '[role="main"] [role="grid"]',
	conversationFallback: '[role="main"]',
	message: '[role="row"], [data-message-id], [data-messageid]',
	messageIdentity: '[data-message-id], [data-messageid]',
	messageText: '[data-ad-preview="message"]',
	messageTextFallback: '[dir="auto"]',
	nonMessageUi: '[role="navigation"], [role="complementary"], [role="tablist"], [data-messenger-sidebar]',
	placeholder: '[aria-busy="true"], [data-virtualized-placeholder], [data-placeholder="true"]',
	reaction: '[aria-label*="reaction" i], [aria-label*="reacted" i]',
	reply: 'blockquote, [data-reply-to-message-id], [aria-label*="replied to" i], [aria-label="前往已回覆的訊息"]',
	senderAvatar: 'img[alt][data-message-author], [data-message-author] img[alt]',
	timestamp: 'time[datetime], abbr[data-utime]',
} as const;

export type MessengerContextInspection = {
	items: ConversationContextItem[];
	reason?: MessengerContextDiagnosticReason;
};

const maximumStringLengths = {
	description: 1000,
	displayName: 200,
	domain: 253,
	emoji: 32,
	messageId: 200,
	reply: 4000,
	text: 20_000,
	timestamp: 200,
	title: 500,
	url: 2048,
} as const;

function normalizedInline(value: unknown, maximumLength: number): string | undefined {
	if (typeof value !== 'string') {
		return;
	}

	const normalized = value.replaceAll(/\s+/g, ' ').trim();
	return normalized && normalized.length <= maximumLength ? normalized : undefined;
}

function normalizedMultiline(value: unknown, maximumLength: number): string | undefined {
	if (typeof value !== 'string') {
		return;
	}

	const normalized = value
		.replaceAll(/\r\n?/g, '\n')
		.split('\n')
		.map(line => line.replaceAll(/[\t ]+/g, ' ').trim())
		.join('\n')
		.replaceAll(/\n{3,}/g, '\n\n')
		.trim();
	return normalized && normalized.length <= maximumLength ? normalized : undefined;
}

function normalizedMessageId(value: unknown): string | undefined {
	const normalized = normalizedInline(value, maximumStringLengths.messageId);
	return normalized && /^[^\s\p{C}]{1,200}$/u.test(normalized) ? normalized : undefined;
}

function normalizedLinkPreview(value: MessengerContextCandidate['linkPreview']): ConversationContextItem['linkPreview'] {
	if (!value) {
		return;
	}

	const rawUrl = normalizedInline(value.url, maximumStringLengths.url);
	if (!rawUrl) {
		return;
	}

	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return;
	}

	if (!['http:', 'https:'].includes(url.protocol)) {
		return;
	}

	const visibleDomain = normalizedInline(value.domain, maximumStringLengths.domain);
	const result: NonNullable<ConversationContextItem['linkPreview']> = {
		domain: visibleDomain ?? url.hostname,
		url: url.href,
	};
	const title = normalizedInline(value.title, maximumStringLengths.title);
	const description = normalizedMultiline(value.description, maximumStringLengths.description);
	if (title) {
		result.title = title;
	}

	if (description) {
		result.description = description;
	}

	return result;
}

function normalizedReactions(value: MessengerContextCandidate['reactions']): ConversationContextItem['reactions'] {
	const reactions = new Map<string, number>();
	for (const reaction of Array.isArray(value) ? value.slice(0, 20) : []) {
		const emoji = normalizedInline(reaction?.emoji, maximumStringLengths.emoji);
		if (!emoji) {
			continue;
		}

		const count = Number.isSafeInteger(reaction.count) && (reaction.count ?? 0) > 0
			? Math.min(reaction.count!, 99_999)
			: 1;
		reactions.set(emoji, Math.max(reactions.get(emoji) ?? 0, count));
	}

	return reactions.size > 0
		? [...reactions].map(([emoji, count]) => ({count, emoji}))
		: undefined;
}

function normalizedAttachments(value: MessengerContextCandidate['attachments']): ConversationContextItem['attachments'] {
	if (!Array.isArray(value)) {
		return;
	}

	const kinds = [...new Set(value.filter(kind => ['audio', 'image', 'video'].includes(kind)))];
	return kinds.length > 0 ? kinds.map(kind => ({kind})) : undefined;
}

function normalizedReply(value: MessengerContextCandidate['reply']): ConversationContextItem['reply'] {
	const text = normalizedMultiline(value?.text, maximumStringLengths.reply);
	if (!text) {
		return;
	}

	const reply: NonNullable<ConversationContextItem['reply']> = {text};
	const quotedSender = normalizedInline(value?.quotedSender, maximumStringLengths.displayName);
	if (quotedSender) {
		reply.quotedSender = quotedSender;
	}

	return reply;
}

function stableMessageContentSignature(candidate: MessengerContextCandidate): string {
	return JSON.stringify({
		attachments: normalizedAttachments(candidate.attachments),
		linkPreview: normalizedLinkPreview(candidate.linkPreview),
		omittedReason: candidate.omittedReason
			?? (candidate.malformed ? 'malformed-message' : undefined)
			?? (candidate.unsupported ? 'unsupported-message' : undefined),
		reply: {
			quotedSender: normalizedInline(candidate.reply?.quotedSender, maximumStringLengths.displayName),
			text: normalizedMultiline(candidate.reply?.text, maximumStringLengths.reply),
		},
		senderDisplayName: normalizedInline(candidate.senderDisplayName, maximumStringLengths.displayName),
		senderRole: candidate.senderRole,
		text: normalizedMultiline(candidate.text, maximumStringLengths.text),
		timestamp: normalizedInline(candidate.timestamp, maximumStringLengths.timestamp),
	});
}

function candidateOmittedReason(
	candidate: MessengerContextCandidate,
	hasSupportedContent: boolean,
): ConversationContextOmittedReason | undefined {
	return candidate.omittedReason
		?? (candidate.malformed ? 'malformed-message' : undefined)
		?? (candidate.unsupported ? 'unsupported-message' : undefined)
		?? (hasSupportedContent ? undefined : 'no-supported-content');
}

function normalizedCandidate(candidate: MessengerContextCandidate): ConversationContextItem {
	const sender: ConversationContextItem['sender'] = {
		role: ['incoming', 'outgoing'].includes(candidate.senderRole ?? '')
			? candidate.senderRole!
			: 'unknown',
	};
	const displayName = normalizedInline(candidate.senderDisplayName, maximumStringLengths.displayName);
	if (displayName) {
		sender.displayName = displayName;
	}

	const item: ConversationContextItem = {
		confidence: 'low',
		sender,
	};
	const messageId = normalizedMessageId(candidate.stableId);
	const timestamp = normalizedInline(candidate.timestamp, maximumStringLengths.timestamp);
	const text = normalizedMultiline(candidate.text, maximumStringLengths.text);
	const reply = normalizedReply(candidate.reply);
	const reactions = normalizedReactions(candidate.reactions);
	const linkPreview = normalizedLinkPreview(candidate.linkPreview);
	const attachments = normalizedAttachments(candidate.attachments);

	if (messageId) {
		item.messageId = messageId;
	}

	if (timestamp) {
		item.timestamp = timestamp;
	}

	if (text) {
		item.text = text;
	}

	if (reply) {
		item.reply = reply;
	}

	if (reactions) {
		item.reactions = reactions;
	}

	if (linkPreview) {
		item.linkPreview = linkPreview;
	}

	if (attachments) {
		item.attachments = attachments;
	}

	const omittedReason = candidateOmittedReason(candidate, Boolean(text ?? reply ?? linkPreview ?? attachments));
	if (omittedReason) {
		item.omittedReason = omittedReason;
	}

	if (!item.omittedReason) {
		item.confidence = messageId && sender.role !== 'unknown' ? 'high' : 'medium';
	}

	return item;
}

export function extractConversationContextCandidates(
	candidates: readonly MessengerContextCandidate[],
): ConversationContextItem[] {
	if (!Array.isArray(candidates)) {
		return [];
	}

	const ordered = candidates
		.filter(candidate => candidate && Number.isSafeInteger(candidate.domOrder) && candidate.domOrder >= 0)
		.map((candidate, insertionOrder) => ({candidate, insertionOrder}))
		.sort((left, right) => left.candidate.domOrder - right.candidate.domOrder || left.insertionOrder - right.insertionOrder)
		.slice(-maximumMessengerDomExtractionItems);
	const stableCandidates = new Map<string, {ambiguous: boolean; resultIndex: number; signature: string}>();
	const result: ConversationContextItem[] = [];

	for (const {candidate} of ordered) {
		const stableId = normalizedMessageId(candidate.stableId);
		if (!stableId) {
			result.push(normalizedCandidate(candidate));
			continue;
		}

		const signature = stableMessageContentSignature(candidate);
		const previous = stableCandidates.get(stableId);
		if (!previous) {
			stableCandidates.set(stableId, {ambiguous: false, resultIndex: result.length, signature});
			result.push(normalizedCandidate(candidate));
			continue;
		}

		if (previous.ambiguous) {
			continue;
		}

		if (previous.signature === signature) {
			result[previous.resultIndex] = normalizedCandidate(candidate);
		} else if (result[previous.resultIndex]) {
			previous.ambiguous = true;
			result[previous.resultIndex] = {
				confidence: 'low',
				messageId: stableId,
				omittedReason: 'ambiguous-message',
				sender: {role: 'unknown'},
			};
		}
	}

	return result;
}

export function captureMessengerMessageAnchor(
	candidates: readonly MessengerContextCandidate[],
	targetDomOrder: number,
): MessengerMessageAnchor | undefined {
	if (!Array.isArray(candidates) || !Number.isSafeInteger(targetDomOrder) || targetDomOrder < 0) {
		return;
	}

	const targetCandidates = candidates.filter(candidate => candidate?.domOrder === targetDomOrder);
	if (targetCandidates.length !== 1) {
		return;
	}

	const targetMessageId = normalizedMessageId(targetCandidates[0].stableId);
	if (!targetMessageId || !targetCandidates[0].senderRole) {
		return;
	}

	const items = extractConversationContextCandidates(candidates);
	const loadedIndex = items.findIndex(item => item.messageId === targetMessageId);
	if (loadedIndex < 0 || items.some((item, index) => index !== loadedIndex && item.messageId === targetMessageId)) {
		return;
	}

	const item = items[loadedIndex];
	if (
		item.confidence !== 'high'
		|| item.omittedReason !== undefined
		|| item.sender.role === 'unknown'
	) {
		return;
	}

	return {
		item,
		loadedCount: items.length,
		loadedIndex,
	};
}

type MessengerTraversalBudget = {
	exhausted: boolean;
	remainingNodes: number;
	remainingTextLength: number;
};

function messengerTraversalBudget(): MessengerTraversalBudget {
	return {
		exhausted: false,
		remainingNodes: maximumMessengerTailTraversalElements,
		remainingTextLength: maximumStringLengths.text,
	};
}

function consumeMessengerNode(budget: MessengerTraversalBudget): boolean {
	if (budget.remainingNodes <= 0) {
		budget.exhausted = true;
		return false;
	}

	budget.remainingNodes -= 1;
	return true;
}

function consumeMessengerText(budget: MessengerTraversalBudget, value: string): boolean {
	if (value.length > budget.remainingTextLength) {
		budget.exhausted = true;
		return false;
	}

	budget.remainingTextLength -= value.length;
	return true;
}

function visibleElementSelf(element: Element): boolean {
	if (element.matches('[aria-hidden="true"], [hidden]')) {
		return false;
	}

	let style: CSSStyleDeclaration | undefined;
	try {
		style = element.ownerDocument.defaultView?.getComputedStyle(element);
	} catch {}

	return style?.display !== 'none'
		&& !['collapse', 'hidden'].includes(style?.visibility ?? '')
		&& style?.opacity !== '0'
		&& style?.getPropertyValue('content-visibility') !== 'hidden';
}

function visibleElement(element: Element, budget?: MessengerTraversalBudget): boolean {
	if (!childNodesFromElement(element) && element.closest('[aria-hidden="true"], [hidden]')) {
		return false;
	}

	let visited = 0;
	for (let current: Element | undefined = element; current; current = current.parentElement ?? undefined) {
		visited += 1;
		const exhaustedBudget = budget ? !consumeMessengerNode(budget) : false;
		if (
			visited > maximumMessengerTailTraversalElements
			|| exhaustedBudget
			|| !visibleElementSelf(current)
		) {
			return false;
		}
	}

	return true;
}

function textFromElements(elements: readonly Element[], excludedSelector?: string): string | undefined {
	const fragments: string[] = [];
	const budget = excludedSelector ? messengerTraversalBudget() : undefined;
	for (const element of elements) {
		const isExcluded = excludedSelector
			? Boolean(element.closest(excludedSelector))
			: false;
		if (
			!visibleElement(element, budget)
			|| Boolean(element.querySelector(messengerContextSelectors.messageText))
			|| isExcluded
		) {
			if (budget?.exhausted) {
				return;
			}

			continue;
		}

		const text = excludedSelector
			? visibleSubtreeText(element, excludedSelector, budget!)
			: normalizedMultiline(element.textContent, maximumStringLengths.text);
		if (budget?.exhausted) {
			return;
		}

		if (text && !fragments.includes(text)) {
			fragments.push(text);
		}
	}

	return fragments.length > 0 ? fragments.join('\n') : undefined;
}

type MessageBodyTextResult =
	| {status: 'ambiguous' | 'empty'}
	| {status: 'found'; text: string};

type ChildNodeCollection = ArrayLike<Node> & Iterable<Node>;

function childNodesFromElement(element: Element): ChildNodeCollection | undefined {
	const {childNodes} = element as Element & {childNodes?: NodeListOf<ChildNode>};
	return childNodes as ChildNodeCollection | undefined;
}

function enterVisibleSubtree(
	element: Element,
	excludedSelector: string,
	budget: MessengerTraversalBudget,
	rootAlreadyConsumed: boolean,
): boolean {
	if (!rootAlreadyConsumed && !consumeMessengerNode(budget)) {
		return false;
	}

	return visibleElementSelf(element) && !element.matches(excludedSelector);
}

function visibleSubtreeText(
	element: Element,
	excludedSelector: string,
	budget: MessengerTraversalBudget,
	rootAlreadyConsumed = false,
): string | undefined {
	if (!enterVisibleSubtree(element, excludedSelector, budget, rootAlreadyConsumed)) {
		return;
	}

	const childNodes = childNodesFromElement(element);
	if (!childNodes) {
		if (element.querySelector(excludedSelector)) {
			return;
		}

		const value = element.textContent ?? '';
		return consumeMessengerText(budget, value)
			? normalizedMultiline(value, maximumStringLengths.text)
			: undefined;
	}

	const pending: Array<{index: number; nodes: ArrayLike<Node>}> = [{index: 0, nodes: childNodes}];
	const fragments: string[] = [];
	while (pending.length > 0) {
		const frame = pending.at(-1)!;
		if (frame.index >= frame.nodes.length) {
			pending.pop();
			continue;
		}

		const current = frame.nodes[frame.index];
		frame.index += 1;
		if (!consumeMessengerNode(budget)) {
			return;
		}

		if (current.nodeType === 3) {
			const value = current.textContent ?? '';
			if (!consumeMessengerText(budget, value)) {
				return;
			}

			fragments.push(value);
			continue;
		}

		if (current.nodeType !== 1) {
			continue;
		}

		const currentElement = current as Element;
		if (!visibleElementSelf(currentElement) || currentElement.matches(excludedSelector)) {
			continue;
		}

		if (currentElement.localName === 'br') {
			if (!consumeMessengerText(budget, '\n')) {
				return;
			}

			fragments.push('\n');
		}

		const currentChildNodes = childNodesFromElement(currentElement);
		if (currentChildNodes) {
			pending.push({index: 0, nodes: currentChildNodes});
		}
	}

	const distinctFragments = [...new Set(
		fragments
			.map(fragment => normalizedMultiline(fragment, maximumStringLengths.text))
			.filter((fragment): fragment is string => fragment !== undefined),
	)];
	return distinctFragments.length === 1
		? distinctFragments[0]
		: normalizedMultiline(fragments.join(''), maximumStringLengths.text);
}

function singleVisibleBodyText(
	element: Element,
	excludedSelector: string,
	budget: MessengerTraversalBudget,
): MessageBodyTextResult {
	if (!visibleElement(element, budget)) {
		return {status: budget.exhausted ? 'ambiguous' : 'empty'};
	}

	const childNodes = childNodesFromElement(element);
	if (!childNodes) {
		const text = visibleSubtreeText(element, excludedSelector, budget, true);
		return budget.exhausted
			? {status: 'ambiguous'}
			: (text ? {status: 'found', text} : {status: 'empty'});
	}

	const candidates: string[] = [];
	const addCandidate = (text: string | undefined): boolean => {
		if (text && !candidates.includes(text)) {
			candidates.push(text);
		}

		return candidates.length <= 1;
	};

	const directFragments: string[] = [];
	for (const child of childNodes) {
		if (!consumeMessengerNode(budget)) {
			return {status: 'ambiguous'};
		}

		if (child.nodeType === 3) {
			const value = child.textContent ?? '';
			if (!consumeMessengerText(budget, value)) {
				return {status: 'ambiguous'};
			}

			directFragments.push(value);
			continue;
		}

		if (child.nodeType !== 1) {
			continue;
		}

		const childElement = child as Element;
		if (!visibleElementSelf(childElement) || childElement.matches(excludedSelector)) {
			continue;
		}

		if (childElement.localName === 'br') {
			if (!consumeMessengerText(budget, '\n')) {
				return {status: 'ambiguous'};
			}

			directFragments.push('\n');
			continue;
		}

		const text = visibleSubtreeText(childElement, excludedSelector, budget, true);
		if (budget.exhausted || !addCandidate(text)) {
			return {status: 'ambiguous'};
		}
	}

	const directText = normalizedMultiline(directFragments.join(''), maximumStringLengths.text);
	if (!addCandidate(directText)) {
		return {status: 'ambiguous'};
	}

	return candidates.length === 1
		? {status: 'found', text: candidates[0]}
		: {status: 'empty'};
}

function isMessageEvidenceElement(element: Element): boolean {
	const {dataset} = element as HTMLElement;
	return element.getAttribute('role') === 'row'
		|| dataset.messageId !== undefined
		|| dataset.messageid !== undefined;
}

type OwnedMessageIdentity =
	| {status: 'invalid' | 'none'}
	| {stableId: string; status: 'valid'};

function messageIdentityOwnedByElement(element: Element): OwnedMessageIdentity {
	const {dataset} = element as HTMLElement;
	let stableId: string | undefined;
	for (const value of [dataset.messageId, dataset.messageid]) {
		if (value === undefined) {
			continue;
		}

		const identifier = normalizedMessageId(value);
		if (!identifier || (stableId !== undefined && stableId !== identifier)) {
			return {status: 'invalid'};
		}

		stableId = identifier;
	}

	return stableId ? {stableId, status: 'valid'} : {status: 'none'};
}

function stableIdOwnedByElement(element: Element): string | undefined {
	const identity = messageIdentityOwnedByElement(element);
	return identity.status === 'valid' ? identity.stableId : undefined;
}

function stableIdFromElement(element: Element): string | undefined {
	for (const candidate of [
		element,
		element.closest(messengerContextSelectors.messageIdentity),
		element.querySelector(messengerContextSelectors.messageIdentity),
	]) {
		const identifier = candidate ? stableIdOwnedByElement(candidate) : undefined;
		if (identifier) {
			return identifier;
		}
	}

	return undefined;
}

function hasSemanticMessageEvidence(element: Element): boolean {
	const label = normalizedInline(element.getAttribute('aria-label'), 500);
	return (element as HTMLElement).dataset.scope === 'messages_table'
		|| element.getAttribute('aria-roledescription') === 'message'
		|| /^(?:at\s+.+?,\s+.+?|you sent\b|.+? sent a message\b)/i.test(label ?? '');
}

function subtreeContainsForeignMessageElement(
	element: Element,
	canonicalStableId: string,
	budget: MessengerTraversalBudget,
): boolean | undefined {
	const pending: Array<{element: Element; index: number}> = [{element, index: 0}];
	while (pending.length > 0) {
		const frame = pending.at(-1)!;
		if (frame.index === 0) {
			if (!consumeMessengerNode(budget)) {
				return;
			}

			const identity = messageIdentityOwnedByElement(frame.element);
			if (identity.status === 'invalid' || (identity.status === 'valid' && identity.stableId !== canonicalStableId)) {
				return true;
			}

			if (
				identity.status === 'none'
				&& frame.element.getAttribute('role') === 'row'
				&& hasSemanticMessageEvidence(frame.element)
			) {
				return true;
			}
		}

		if (frame.index >= frame.element.children.length) {
			pending.pop();
			continue;
		}

		const child = frame.element.children[frame.index];
		frame.index += 1;
		pending.push({element: child, index: 0});
	}

	return false;
}

function hasForeignMessageSibling(
	parent: Element,
	branch: Element,
	canonicalStableId: string,
	budget: MessengerTraversalBudget,
): boolean | undefined {
	for (const sibling of parent.children) {
		if (sibling === branch) {
			continue;
		}

		const containsMessage = subtreeContainsForeignMessageElement(sibling, canonicalStableId, budget);
		if (containsMessage === true || budget.exhausted) {
			return containsMessage;
		}
	}

	return false;
}

function messageEvidenceElements(element: Element, canonicalStableId?: string): Element[] | undefined {
	const elementIdentity = messageIdentityOwnedByElement(element);
	if (
		elementIdentity.status === 'invalid'
		|| (elementIdentity.status === 'valid' && elementIdentity.stableId !== canonicalStableId)
	) {
		return;
	}

	if (!canonicalStableId || !childNodesFromElement(element)) {
		return [element];
	}

	const elements = [element];
	if (element.getAttribute('role') === 'row') {
		return elements;
	}

	const budget = messengerTraversalBudget();
	if (!consumeMessengerNode(budget)) {
		return;
	}

	let branch = element;
	let current = element.parentElement;
	for (let visited = 0; current && visited < 16; visited += 1) {
		if (current.getAttribute('role') === 'main') {
			break;
		}

		if (!consumeMessengerNode(budget)) {
			return;
		}

		const currentIdentity = messageIdentityOwnedByElement(current);
		if (
			currentIdentity.status === 'invalid'
			|| (currentIdentity.status === 'valid' && currentIdentity.stableId !== canonicalStableId)
		) {
			return;
		}

		const hasForeignMessage = hasForeignMessageSibling(current, branch, canonicalStableId, budget);
		if (budget.exhausted) {
			return;
		}

		if (hasForeignMessage === true) {
			if (elements.length === 1 && hasSemanticMessageEvidence(element)) {
				break;
			}

			return;
		}

		if (isMessageEvidenceElement(current)) {
			elements.push(current);
		}

		if (current.getAttribute('role') === 'row') {
			break;
		}

		branch = current;
		current = current.parentElement;
	}

	return elements;
}

function textFromMessageEvidence(
	elements: readonly Element[],
	excludedSelector: string,
): string | undefined {
	const budget = messengerTraversalBudget();
	for (const evidence of elements) {
		const result = singleVisibleBodyText(evidence, excludedSelector, budget);
		if (result.status === 'found') {
			return result.text;
		}

		if (result.status === 'ambiguous') {
			return;
		}
	}

	return undefined;
}

type SenderEvidence = Pick<MessengerContextCandidate, 'senderDisplayName' | 'senderRole'> & {
	confident: boolean;
};

type SemanticMessageLabel = SenderEvidence & {
	text?: string;
	timestamp?: string;
};

function semanticMessageLabelFromElement(
	element: Element,
	canonicalStableId?: string,
): SemanticMessageLabel | undefined {
	const stableId = stableIdOwnedByElement(element);
	const hasSemanticMessageRole = (element as HTMLElement).dataset.scope === 'messages_table'
		|| element.getAttribute('aria-roledescription') === 'message';
	if (
		!stableId
		|| (canonicalStableId !== undefined && stableId !== canonicalStableId)
		|| !hasSemanticMessageRole
	) {
		return;
	}

	const accessibleText = normalizedInline(
		element.getAttribute('aria-label'),
		maximumStringLengths.text + maximumStringLengths.displayName + maximumStringLengths.timestamp + 16,
	);
	const parts = accessibleText?.match(/^at\s+(.+?),\s+(.+?)(?::\s*(.*))?$/i)
		?? accessibleText?.match(/^(.+?)，([^：]+)：\s*(.*)$/);
	const senderDisplayName = normalizedInline(parts?.[2], maximumStringLengths.displayName);
	if (!senderDisplayName) {
		return;
	}

	return {
		confident: true,
		senderDisplayName,
		senderRole: /^(?:you|你)$/i.test(senderDisplayName) ? 'outgoing' : 'incoming',
		text: normalizedMultiline(parts?.[3], maximumStringLengths.text),
		timestamp: normalizedInline(parts?.[1], maximumStringLengths.timestamp),
	};
}

function senderFromElement(element: Element, canonicalStableId?: string): SenderEvidence {
	const semanticMessage = semanticMessageLabelFromElement(element, canonicalStableId);
	if (semanticMessage) {
		return semanticMessage;
	}

	const accessibleText = normalizedInline(element.getAttribute('aria-label'), 500);
	if (/^you sent\b/i.test(accessibleText ?? '')) {
		return {confident: true, senderDisplayName: 'You', senderRole: 'outgoing'};
	}

	const incomingSender = accessibleText?.match(/^(.+?) sent\b/i)?.[1];
	if (incomingSender) {
		return {confident: true, senderDisplayName: incomingSender, senderRole: 'incoming'};
	}

	const avatarName = [...element.querySelectorAll(messengerContextSelectors.senderAvatar)]
		.map(image => normalizedInline(image.getAttribute('alt'), maximumStringLengths.displayName))
		.find(value => value && !/^(image|photo|sticker|gif)$/i.test(value));
	return avatarName
		? {confident: true, senderDisplayName: avatarName, senderRole: 'incoming'}
		: {confident: false};
}

function senderFromMessageEvidence(
	elements: readonly Element[],
	canonicalStableId?: string,
): SenderEvidence {
	let resolved: SenderEvidence | undefined;
	for (const evidence of elements) {
		const sender = senderFromElement(evidence, canonicalStableId);
		if (!sender.confident || !sender.senderRole) {
			continue;
		}

		if (
			resolved
			&& (
				resolved.senderRole !== sender.senderRole
				|| resolved.senderDisplayName !== sender.senderDisplayName
			)
		) {
			return {confident: false};
		}

		resolved = sender;
	}

	return resolved ?? {confident: false};
}

function semanticMessageLabelFromEvidence(
	elements: readonly Element[],
	canonicalStableId?: string,
): SemanticMessageLabel | undefined {
	if (!canonicalStableId) {
		return;
	}

	let resolved: SemanticMessageLabel | undefined;
	for (const evidence of elements) {
		const semanticMessage = semanticMessageLabelFromElement(evidence, canonicalStableId);
		if (!semanticMessage) {
			continue;
		}

		if (
			resolved
			&& (
				resolved.senderRole !== semanticMessage.senderRole
				|| resolved.senderDisplayName !== semanticMessage.senderDisplayName
				|| resolved.text !== semanticMessage.text
				|| resolved.timestamp !== semanticMessage.timestamp
			)
		) {
			return;
		}

		resolved = semanticMessage;
	}

	return resolved;
}

export function extractNativeMessengerSender(element: Element): ConversationContextItem['sender'] | undefined {
	try {
		const stableId = stableIdFromElement(element);
		const evidence = messageEvidenceElements(element, stableId);
		if (!evidence) {
			return;
		}

		const sender = senderFromMessageEvidence(evidence, stableId);
		if (!sender.confident || !sender.senderRole) {
			return;
		}

		return {
			...(sender.senderDisplayName ? {displayName: sender.senderDisplayName} : {}),
			role: sender.senderRole,
		};
	} catch {}

	return undefined;
}

function timestampFromElement(element: Element): string | undefined {
	const timestamp = element.querySelector(messengerContextSelectors.timestamp);
	return normalizedInline(
		timestamp?.getAttribute('datetime')
		?? timestamp?.getAttribute('data-utime')
		?? timestamp?.textContent,
		maximumStringLengths.timestamp,
	);
}

function reactionFromElement(element: Element): MessengerContextCandidate['reactions'] {
	const reactions: NonNullable<MessengerContextCandidate['reactions']> = [];
	for (const reaction of element.querySelectorAll(messengerContextSelectors.reaction)) {
		const label = normalizedInline(reaction.getAttribute('aria-label'), 500);
		const emoji = normalizedInline(reaction.textContent, maximumStringLengths.emoji)
			?? label?.match(/\p{Extended_Pictographic}/u)?.[0];
		const countValue = label?.match(/\b(\d{1,5})\b/)?.[1];
		if (emoji) {
			reactions.push({count: countValue ? Number(countValue) : 1, emoji});
		}
	}

	return reactions.length > 0 ? reactions : undefined;
}

function linkPreviewFromElement(element: Element): MessengerContextCandidate['linkPreview'] {
	let preview: MessengerContextCandidate['linkPreview'];
	for (const anchor of element.querySelectorAll<HTMLAnchorElement>('a[href]')) {
		let url: URL;
		try {
			url = new URL(anchor.href, window.location.href);
		} catch {
			continue;
		}

		if (/^(?:l\.)?facebook\.com$/i.test(url.hostname) && url.pathname === '/l.php') {
			try {
				url = new URL(url.searchParams.get('u') ?? '');
			} catch {
				continue;
			}
		}

		if (!['http:', 'https:'].includes(url.protocol) || /(^|\.)facebook\.com$/i.test(url.hostname)) {
			continue;
		}

		const visibleText = [...anchor.querySelectorAll('[dir="auto"]')]
			.filter(node => visibleElement(node))
			.map(node => normalizedMultiline(node.textContent, maximumStringLengths.description))
			.flatMap(value => value ? [value] : []);
		preview = {
			description: visibleText.slice(1).join('\n') || undefined,
			domain: url.hostname,
			title: visibleText[0],
			url: url.href,
		};
		break;
	}

	return preview;
}

function attachmentsFromElement(element: Element): MessengerContextCandidate['attachments'] {
	const kinds = new Set<'audio' | 'image' | 'video'>();
	if (element.querySelector('audio')) {
		kinds.add('audio');
	}

	if (element.querySelector('video')) {
		kinds.add('video');
	}

	for (const image of element.querySelectorAll('img[alt]')) {
		const alt = image.getAttribute('alt') ?? '';
		if (/\b(gif|image|photo|sticker)\b/i.test(alt) && !image.closest('[role="button"]')) {
			kinds.add('image');
		}
	}

	return kinds.size > 0 ? [...kinds] : undefined;
}

function isObviousNonMessageUi(element: Element): boolean {
	const label = normalizedInline(element.getAttribute('aria-label'), 500);
	return Boolean(element.closest(messengerContextSelectors.nonMessageUi))
		|| Boolean(label && /^(?:chats?|contacts?|menu|navigation|search|sidebar)\b/i.test(label));
}

function isVirtualizedPlaceholder(element: Element): boolean {
	return Boolean(element.closest(messengerContextSelectors.placeholder));
}

function candidateFromElement(element: Element, domOrder: number): MessengerContextCandidate {
	if (isObviousNonMessageUi(element)) {
		return {domOrder, omittedReason: 'non-message-ui'};
	}

	if (isVirtualizedPlaceholder(element)) {
		return {domOrder, omittedReason: 'virtualized-placeholder'};
	}

	const stableId = stableIdFromElement(element);
	const evidence = messageEvidenceElements(element, stableId);
	if (!evidence) {
		return {domOrder, omittedReason: 'ambiguous-message', stableId};
	}

	const replyElement = element.querySelector(messengerContextSelectors.reply);
	const linkPreview = linkPreviewFromElement(element);
	const semanticMessage = semanticMessageLabelFromEvidence(evidence, stableId);
	const sender = senderFromMessageEvidence(evidence, stableId);
	const excludedText = [
		messengerContextSelectors.reaction,
		messengerContextSelectors.reply,
		messengerContextSelectors.timestamp,
		'a[href]',
		'button',
		'input',
		'label',
		'option',
		'select',
		'textarea',
		'form',
		'[contenteditable="true"]',
		'[role="button"]',
		'[role="textbox"]',
	].join(',');
	const fallbackExcludedText = [
		excludedText,
		messengerContextSelectors.nonMessageUi,
		messengerContextSelectors.placeholder,
	].join(',');
	const primaryMessageText = [...element.querySelectorAll(messengerContextSelectors.messageText)];
	const fallbackMessageText = [...element.querySelectorAll(messengerContextSelectors.messageTextFallback)]
		.filter(candidate => !candidate.querySelector(messengerContextSelectors.messageTextFallback));
	const supportedText = textFromElements(primaryMessageText, excludedText)
		?? textFromElements(fallbackMessageText, excludedText);
	const candidate: MessengerContextCandidate = {
		attachments: attachmentsFromElement(element),
		domOrder,
		linkPreview,
		reactions: reactionFromElement(element),
		stableId,
		text: supportedText
			?? (sender.confident ? semanticMessage?.text : undefined)
			?? (stableId && sender.confident && !linkPreview
				? textFromMessageEvidence([evidence[0]], fallbackExcludedText)
				: undefined),
		timestamp: timestampFromElement(element) ?? semanticMessage?.timestamp,
		senderDisplayName: sender.senderDisplayName,
		senderRole: sender.senderRole,
	};
	if (replyElement) {
		const quotedSender = senderFromElement(replyElement).senderDisplayName;
		candidate.reply = {
			quotedSender,
			text: textFromElements([replyElement]),
		};
	}

	const hasSupportedContent = Boolean(
		candidate.text
		?? candidate.reply?.text
		?? candidate.linkPreview
		?? candidate.attachments?.length,
	);
	const hasMessageIdentity = Boolean(candidate.stableId ?? candidate.timestamp) || sender.confident;
	if (hasSupportedContent && !hasMessageIdentity) {
		candidate.omittedReason = 'incomplete-message';
	}

	return candidate;
}

export function resolveLoadedMessengerConversationRoot(root: ParentNode = document): Element | undefined {
	return root.querySelector(messengerContextSelectors.conversation)
		?? root.querySelector(messengerContextSelectors.conversationFallback)
		?? undefined;
}

export function resolveLoadedMessengerMessageRow(
	target: Element,
	root: ParentNode = document,
): HTMLElement | undefined {
	try {
		const conversation = resolveLoadedMessengerConversationRoot(root);
		const row = target.closest<HTMLElement>(messengerContextSelectors.message);
		return conversation && row && conversation.contains(row) ? row : undefined;
	} catch {
		return undefined;
	}
}

function loadedMessengerMessageRows(conversation: Element): Element[] {
	return [...conversation.querySelectorAll(messengerContextSelectors.message)]
		.filter(row => visibleElement(row) && !row.querySelector(messengerContextSelectors.message))
		.slice(-maximumMessengerDomExtractionItems);
}

export function inspectLoadedMessengerConversationContext(root: ParentNode = document): MessengerContextInspection {
	try {
		const conversation = resolveLoadedMessengerConversationRoot(root);
		if (!conversation) {
			return {items: [], reason: 'conversation-root-missing'};
		}

		const rows = loadedMessengerMessageRows(conversation);
		if (rows.length === 0) {
			return {items: [], reason: 'message-rows-missing'};
		}

		const items = extractConversationContextCandidates(rows.map((row, domOrder) => {
			try {
				return candidateFromElement(row, domOrder);
			} catch {
				return {domOrder, malformed: true};
			}
		}));
		if (items.some(item => item.omittedReason === undefined)) {
			return {items};
		}

		return {
			items,
			reason: items.some(item => item.omittedReason === 'ambiguous-message')
				? 'ambiguous-messages'
				: 'supported-content-missing',
		};
	} catch {
		return {items: [], reason: 'adapter-error'};
	}
}

export function extractLoadedMessengerConversationContext(root: ParentNode = document): ConversationContextItem[] {
	return inspectLoadedMessengerConversationContext(root).items;
}

function recordMessengerTailVisit(visited: Set<Element>, element: Element): boolean {
	if (visited.has(element)) {
		return true;
	}

	if (visited.size >= maximumMessengerTailTraversalElements) {
		return false;
	}

	visited.add(element);
	return true;
}

function deepestMessengerTailElement(element: Element, visited: Set<Element>): Element | undefined {
	let deepest = element;
	for (let child = deepest.lastElementChild; child; child = deepest.lastElementChild) {
		if (!recordMessengerTailVisit(visited, deepest)) {
			return;
		}

		deepest = child;
	}

	return deepest;
}

export function extractLoadedMessengerConversationTail(root: ParentNode = document): ConversationContextItem | undefined {
	try {
		const conversation = resolveLoadedMessengerConversationRoot(root);
		if (!conversation) {
			return;
		}

		const visited = new Set<Element>();
		const elementsWithMessageDescendants = new Set<Element>();
		let current: Element | undefined = conversation.lastElementChild ?? undefined;
		let shouldDescend = true;
		while (current && current !== conversation) {
			if (shouldDescend) {
				const deepest = deepestMessengerTailElement(current, visited);
				if (!deepest) {
					return;
				}

				current = deepest;
			}

			if (!recordMessengerTailVisit(visited, current)) {
				return;
			}

			const hasMessageDescendant = elementsWithMessageDescendants.has(current);
			const isMessage = current.matches(messengerContextSelectors.message);
			const parent = current.parentElement;
			if ((isMessage || hasMessageDescendant) && parent) {
				elementsWithMessageDescendants.add(parent);
			}

			if (isMessage && !hasMessageDescendant && visibleElement(current)) {
				try {
					return extractConversationContextCandidates([candidateFromElement(current, 0)])[0];
				} catch {
					return extractConversationContextCandidates([{domOrder: 0, malformed: true}])[0];
				}
			}

			if (current.previousElementSibling) {
				current = current.previousElementSibling;
				shouldDescend = true;
			} else {
				current = parent ?? undefined;
				shouldDescend = false;
			}
		}
	} catch {}

	return undefined;
}

export function captureLoadedMessengerMessageAnchor(
	target: Element,
	root: ParentNode = document,
): MessengerMessageAnchor | undefined {
	let anchor: MessengerMessageAnchor | undefined;
	try {
		const conversation = resolveLoadedMessengerConversationRoot(root);
		const targetRow = resolveLoadedMessengerMessageRow(target, root);
		if (!conversation || !targetRow || !conversation.contains(targetRow)) {
			return;
		}

		const rows = loadedMessengerMessageRows(conversation);
		const targetDomOrder = rows.indexOf(targetRow);
		if (targetDomOrder < 0) {
			return;
		}

		const candidates = rows.map((row, domOrder) => {
			try {
				return candidateFromElement(row, domOrder);
			} catch {
				return {domOrder, malformed: true};
			}
		});
		anchor = captureMessengerMessageAnchor(candidates, targetDomOrder);
	} catch {}

	return anchor;
}
