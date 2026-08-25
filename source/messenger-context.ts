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
	message: '[role="row"]',
	messageIdentity: '[data-message-id], [data-messageid]',
	messageText: '[data-ad-preview="message"]',
	nonMessageUi: '[role="navigation"], [role="complementary"], [role="tablist"], [data-messenger-sidebar]',
	placeholder: '[aria-busy="true"], [data-virtualized-placeholder], [data-placeholder="true"]',
	reaction: '[aria-label*="reaction" i], [aria-label*="reacted" i]',
	reply: 'blockquote, [data-reply-to-message-id], [aria-label*="replied to" i]',
	senderAvatar: 'img[alt][data-message-author], [data-message-author] img[alt]',
	timestamp: 'time[datetime], abbr[data-utime]',
} as const;

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
	return normalized && /^[\w.:-]+$/.test(normalized) ? normalized : undefined;
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

function visibleElement(element: Element): boolean {
	return !element.closest('[aria-hidden="true"], [hidden]');
}

function textFromElements(elements: readonly Element[], excludedSelector?: string): string | undefined {
	const fragments: string[] = [];
	for (const element of elements) {
		const isExcluded = excludedSelector
			? Boolean(element.closest(excludedSelector) ?? element.querySelector(excludedSelector))
			: false;
		if (
			!visibleElement(element)
			|| Boolean(element.querySelector(messengerContextSelectors.messageText))
			|| isExcluded
		) {
			continue;
		}

		const text = normalizedMultiline(element.textContent, maximumStringLengths.text);
		if (text && !fragments.includes(text)) {
			fragments.push(text);
		}
	}

	return fragments.length > 0 ? fragments.join('\n') : undefined;
}

function stableIdFromElement(element: Element): string | undefined {
	let stableId: string | undefined;
	for (const candidate of [
		element,
		element.closest(messengerContextSelectors.messageIdentity),
		element.querySelector(messengerContextSelectors.messageIdentity),
	]) {
		const identifier = candidate
			? normalizedMessageId(
				(candidate as HTMLElement).dataset.messageId
					?? (candidate as HTMLElement).dataset.messageid,
			)
			: undefined;
		if (identifier) {
			stableId = identifier;
			break;
		}
	}

	return stableId;
}

type SenderEvidence = Pick<MessengerContextCandidate, 'senderDisplayName' | 'senderRole'> & {
	confident: boolean;
};

function senderFromElement(element: Element): SenderEvidence {
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

	const replyElement = element.querySelector(messengerContextSelectors.reply);
	const linkPreview = linkPreviewFromElement(element);
	const sender = senderFromElement(element);
	const excludedText = [
		messengerContextSelectors.reaction,
		messengerContextSelectors.reply,
		messengerContextSelectors.timestamp,
		'a[href]',
		'[role="button"]',
	].join(',');
	const candidate: MessengerContextCandidate = {
		attachments: attachmentsFromElement(element),
		domOrder,
		linkPreview,
		reactions: reactionFromElement(element),
		stableId: stableIdFromElement(element),
		text: textFromElements(
			[...element.querySelectorAll(messengerContextSelectors.messageText)],
			excludedText,
		),
		timestamp: timestampFromElement(element),
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

export function extractLoadedMessengerConversationContext(root: ParentNode = document): ConversationContextItem[] {
	try {
		const conversation = root.querySelector(messengerContextSelectors.conversation);
		if (!conversation) {
			return [];
		}

		const rows = [...conversation.querySelectorAll(messengerContextSelectors.message)]
			.filter(row => visibleElement(row) && !row.querySelector(messengerContextSelectors.message))
			.slice(-maximumMessengerDomExtractionItems);
		return extractConversationContextCandidates(rows.map((row, domOrder) => {
			try {
				return candidateFromElement(row, domOrder);
			} catch {
				return {domOrder, malformed: true};
			}
		}));
	} catch {
		return [];
	}
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
		const conversation = root.querySelector(messengerContextSelectors.conversation);
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
		const conversation = root.querySelector(messengerContextSelectors.conversation);
		const targetRow = target.closest(messengerContextSelectors.message);
		if (!conversation || !targetRow || !conversation.contains(targetRow)) {
			return;
		}

		const rows = [...conversation.querySelectorAll(messengerContextSelectors.message)]
			.filter(row => visibleElement(row) && !row.querySelector(messengerContextSelectors.message))
			.slice(-maximumMessengerDomExtractionItems);
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
