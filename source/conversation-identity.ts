export const conversationIdentityFailureReasons = [
	'ambiguous-identity',
	'no-reliable-identity',
] as const;

export type ConversationIdentityFailureReason = typeof conversationIdentityFailureReasons[number];

export type ConversationIdentityCandidate = {
	displayName?: string;
	href: string;
};

export type ConversationIdentityResult =
	| {
		conversationId: string;
		displayName?: string;
		status: 'available';
	}
	| {
		reason: ConversationIdentityFailureReason;
		status: 'unavailable';
	};

const trustedMessengerHosts = new Set([
	'facebook.com',
	'www.facebook.com',
	'web.facebook.com',
]);

function normalizeDisplayName(value: string | undefined): string | undefined {
	const normalized = value?.replace(/\s+/g, ' ').trim();
	return normalized && normalized.length <= 200 ? normalized : undefined;
}

export function conversationIdFromMessengerUrl(value: string): string | undefined {
	let url: URL;
	try {
		url = new URL(value, 'https://www.facebook.com');
	} catch {
		return;
	}

	if (!trustedMessengerHosts.has(url.hostname.toLowerCase())) {
		return;
	}

	const match = /^\/messages\/(?:e2ee\/)?t\/([^/]+)\/?$/.exec(url.pathname);
	if (!match) {
		return;
	}

	let routeId: string;
	try {
		routeId = decodeURIComponent(match[1]);
	} catch {
		return;
	}

	if (!/^[\w.:-]{1,200}$/.test(routeId)) {
		return;
	}

	return `messenger-thread:${routeId}`;
}

export function deriveConversationIdentity(
	currentUrl: string,
	selectedCandidates: readonly ConversationIdentityCandidate[],
): ConversationIdentityResult {
	const routeConversationId = conversationIdFromMessengerUrl(currentUrl);
	const selectedById = new Map<string, string | undefined>();

	for (const candidate of selectedCandidates) {
		const conversationId = conversationIdFromMessengerUrl(candidate.href);
		if (conversationId) {
			selectedById.set(conversationId, normalizeDisplayName(candidate.displayName));
		}
	}

	if (selectedById.size > 1) {
		return {reason: 'ambiguous-identity', status: 'unavailable'};
	}

	const [selectedConversationId, displayName] = selectedById.entries().next().value ?? [];
	if (routeConversationId && selectedConversationId && routeConversationId !== selectedConversationId) {
		return {reason: 'ambiguous-identity', status: 'unavailable'};
	}

	const conversationId = routeConversationId ?? selectedConversationId;
	if (!conversationId) {
		return {reason: 'no-reliable-identity', status: 'unavailable'};
	}

	const result: ConversationIdentityResult = {
		conversationId,
		status: 'available',
	};
	if (displayName) {
		result.displayName = displayName;
	}

	return result;
}
