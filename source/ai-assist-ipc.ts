import {
	aiSessionInvalidationReasons,
	AiSessionState,
	ConversationBindingState,
	MessageAnchorData,
} from './ai-assist-state';
import {
	contextWindowSizes,
	ContextWindowSize,
	ReviewedContextItem,
} from './context-review';
import {
	conversationIdentityFailureReasons,
	ConversationIdentityFailureReason,
} from './conversation-identity';
import {
	conversationContextConfidenceLevels,
	conversationContextOmittedReasons,
	ConversationContextItem,
} from './messenger-context';
import {
	openAiAnswerCharacterLimit,
	openAiErrorCodes,
	OpenAiErrorCode,
	openAiPromptCharacterLimit,
} from './openai-client';
import {
	maximumMediaBytes,
	mediaKinds,
	MediaKind,
	mediaSourceTypes,
	MediaSourceType,
} from './media-contract';

export const aiAssistIpcChannels = {
	composerCommand: 'ai-assist:composer-command',
	messageAnchor: 'ai-assist:message-anchor',
	panelCommand: 'ai-assist:panel-command',
	panelStateChanged: 'ai-assist:panel-state-changed',
	messengerCommand: 'ai-assist:messenger-command',
	messengerEvent: 'ai-assist:messenger-event',
} as const;

export type AiAssistPanelState = {
	anchor?: MessageAnchorData & {sequence: number};
	conversation: ConversationBindingState;
	credentials: {
		configured: boolean;
		secureStorageAvailable: boolean;
	};
	enabled: boolean;
	invocation?: {
		prompt: string;
		sequence: number;
	};
	media: {
		candidates: MessengerMediaCandidate[];
		resolution?: MessengerMediaResolution;
	};
	review?: {
		actualCount: number;
		items: ReviewedContextItem[];
		newMessagesAvailable: boolean;
		question: string;
		requestedCount: ContextWindowSize;
		sequence: number;
	};
	request: {
		answer?: string;
		error?: {
			code: OpenAiErrorCode;
			message: string;
		};
		notice?: string;
	};
	session: AiSessionState;
};

export type AiComposerCommandRequest = {
	conversationId: string;
	prompt: string;
};

export type AiComposerCommandResult = {
	accepted: boolean;
};

export type AiMessageAnchorRequest = MessageAnchorData & {
	conversationId: string;
};

export type AiAssistPanelCommand =
	| {type: 'cancel'}
	| {type: 'close'}
	| {type: 'delete-api-key'}
	| {editedExcerpt: string; index: number; type: 'edit-context-item'}
	| {type: 'get-state'}
	| {index: number; type: 'remove-context-item'}
	| {type: 'refresh-conversation'}
	| {type: 'resolve-media'; kind: MediaKind; messageId: string}
	| {type: 'save-api-key'; apiKey: string}
	| {requestedCount: ContextWindowSize; type: 'set-context-window'}
	| {type: 'submit-prompt'; prompt: string}
	| {type: 'test-api-key'};

export type AiAssistMessengerCommand =
	| {
		anchorMessageId?: string;
		conversationId: string;
		requestId: string;
		requestedCount: ContextWindowSize;
		type: 'capture-context';
	}
	| {enabled: boolean; type: 'set-enabled'}
	| {requestId?: string; type: 'report-conversation'}
	| {kind: MediaKind; messageId: string; requestId: string; type: 'resolve-media'};

export type MessengerMediaCandidate = {
	durationSeconds?: number;
	kind: MediaKind;
	messageId: string;
};

export type MessengerMediaResolution = MessengerMediaCandidate & {
	byteLength?: number;
	handleId?: string;
	mimeType?: string;
	sourceType?: MediaSourceType;
	status: 'ready' | 'resolving' | 'unavailable' | 'unsupported';
};

export type AiAssistMessengerEvent =
	| {
		contextVersion: string;
		conversationId: string;
		items: ConversationContextItem[];
		requestId: string;
		requestedCount: ContextWindowSize;
		status: 'available';
		stopReason: 'complete' | 'no-more-history' | 'timeout';
		type: 'context-capture';
	}
	| {
		reason: 'conversation-changed' | 'empty-context' | 'missing-anchor';
		requestId: string;
		status: 'unavailable';
		type: 'context-capture';
	}
	| {
		conversationId: string;
		contextVersion?: string;
		displayName?: string;
		mediaCandidates?: MessengerMediaCandidate[];
		requestId?: string;
		status: 'available';
		type: 'conversation-state';
	}
	| {
		reason: ConversationIdentityFailureReason;
		requestId?: string;
		status: 'unavailable';
		type: 'conversation-state';
	}
	| {
		byteLength?: number;
		durationSeconds?: number;
		handleId?: string;
		kind: MediaKind;
		messageId: string;
		mimeType?: string;
		requestId: string;
		sourceType?: MediaSourceType;
		status: 'available' | 'unavailable' | 'unsupported';
		type: 'media-resolution';
	};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
	const actualKeys = Object.keys(value);
	return actualKeys.length === keys.length && keys.every(key => actualKeys.includes(key));
}

function isBoundedString(value: unknown, maximumLength: number): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= maximumLength;
}

function isBoundedHttpUrl(value: unknown): boolean {
	if (!isBoundedString(value, 2048)) {
		return false;
	}

	try {
		const url = new URL(value);
		return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
	} catch {
		return false;
	}
}

function isAnchorSender(value: unknown): boolean {
	if (!isRecord(value)) {
		return false;
	}

	const keys = ['role'];
	if (value.displayName !== undefined) {
		keys.push('displayName');
	}

	return hasExactKeys(value, keys)
		&& ['incoming', 'outgoing'].includes(value.role as string)
		&& (value.displayName === undefined || isBoundedString(value.displayName, 200));
}

function isContextSender(value: unknown): boolean {
	if (!isRecord(value)) {
		return false;
	}

	const keys = ['role'];
	if (value.displayName !== undefined) {
		keys.push('displayName');
	}

	return hasExactKeys(value, keys)
		&& ['incoming', 'outgoing', 'unknown'].includes(value.role as string)
		&& (value.displayName === undefined || isBoundedString(value.displayName, 200));
}

function isContextItem(value: unknown): value is ConversationContextItem {
	if (!isRecord(value)) {
		return false;
	}

	const optionalKeys = ['attachments', 'linkPreview', 'messageId', 'omittedReason', 'reactions', 'reply', 'text', 'timestamp'];
	const keys = ['confidence', 'sender'];
	for (const key of optionalKeys) {
		if (value[key] !== undefined) {
			keys.push(key);
		}
	}

	if (!hasExactKeys(value, keys)
		|| !conversationContextConfidenceLevels.includes(value.confidence as never)
		|| !isContextSender(value.sender)
		|| (value.messageId !== undefined && !isMessageId(value.messageId))
		|| (value.omittedReason !== undefined && !conversationContextOmittedReasons.includes(value.omittedReason as never))
		|| (value.text !== undefined && !isBoundedString(value.text, 20_000))
		|| (value.timestamp !== undefined && !isBoundedString(value.timestamp, 200))) {
		return false;
	}

	const anchorCompatible: Record<string, unknown> = {
		...value,
		confidence: 'high',
		messageId: value.messageId ?? 'context-item',
		sender: isRecord(value.sender) && value.sender.role === 'unknown'
			? {role: 'incoming'}
			: value.sender,
	};
	delete anchorCompatible.omittedReason;
	if (value.omittedReason !== undefined) {
		return value.attachments === undefined
			&& value.linkPreview === undefined
			&& value.reactions === undefined
			&& value.reply === undefined
			&& value.text === undefined;
	}

	return isAnchorItem(anchorCompatible);
}

function isAnchorItem(value: unknown): boolean {
	if (!isRecord(value)) {
		return false;
	}

	const allowedOptionalKeys = ['attachments', 'linkPreview', 'messageId', 'reactions', 'reply', 'text', 'timestamp'];
	const keys = ['confidence', 'sender'];
	for (const key of allowedOptionalKeys) {
		if (value[key] !== undefined) {
			keys.push(key);
		}
	}

	if (
		!hasExactKeys(value, keys)
		|| value.confidence !== 'high'
		|| !isAnchorSender(value.sender)
		|| !isMessageId(value.messageId)
		|| (value.text !== undefined && !isBoundedString(value.text, 20_000))
		|| (value.timestamp !== undefined && !isBoundedString(value.timestamp, 200))
	) {
		return false;
	}

	if (value.attachments !== undefined && (
		!Array.isArray(value.attachments)
		|| value.attachments.length === 0
		|| value.attachments.length > 3
		|| !value.attachments.every(attachment => isRecord(attachment)
			&& hasExactKeys(attachment, ['kind'])
			&& ['audio', 'image', 'video'].includes(attachment.kind as string))
	)) {
		return false;
	}

	if (value.reply !== undefined && (
		!isRecord(value.reply)
		|| !isBoundedString(value.reply.text, 4000)
		|| !hasExactKeys(value.reply, value.reply.quotedSender === undefined ? ['text'] : ['quotedSender', 'text'])
		|| (value.reply.quotedSender !== undefined && !isBoundedString(value.reply.quotedSender, 200))
	)) {
		return false;
	}

	if (value.reactions !== undefined && (
		!Array.isArray(value.reactions)
		|| value.reactions.length === 0
		|| value.reactions.length > 20
		|| !value.reactions.every(reaction => isRecord(reaction)
			&& hasExactKeys(reaction, ['count', 'emoji'])
			&& Number.isSafeInteger(reaction.count)
			&& (reaction.count as number) > 0
			&& (reaction.count as number) <= 99_999
			&& isBoundedString(reaction.emoji, 32))
	)) {
		return false;
	}

	if (value.linkPreview !== undefined) {
		if (!isRecord(value.linkPreview)) {
			return false;
		}

		const linkKeys = ['domain', 'url'];
		for (const key of ['description', 'title']) {
			if (value.linkPreview[key] !== undefined) {
				linkKeys.push(key);
			}
		}

		if (
			!hasExactKeys(value.linkPreview, linkKeys)
			|| !isBoundedString(value.linkPreview.domain, 253)
			|| !isBoundedHttpUrl(value.linkPreview.url)
			|| (value.linkPreview.description !== undefined && !isBoundedString(value.linkPreview.description, 1000))
			|| (value.linkPreview.title !== undefined && !isBoundedString(value.linkPreview.title, 500))
		) {
			return false;
		}
	}

	return value.text !== undefined
		|| value.reply !== undefined
		|| value.linkPreview !== undefined
		|| value.attachments !== undefined;
}

export function isAiComposerCommandRequest(value: unknown): value is AiComposerCommandRequest {
	return isRecord(value)
		&& hasExactKeys(value, ['conversationId', 'prompt'])
		&& typeof value.conversationId === 'string'
		&& /^messenger-thread:[\w.:-]{1,200}$/.test(value.conversationId)
		&& typeof value.prompt === 'string'
		&& value.prompt.length <= openAiPromptCharacterLimit;
}

export function isAiComposerCommandResult(value: unknown): value is AiComposerCommandResult {
	return isRecord(value)
		&& hasExactKeys(value, ['accepted'])
		&& typeof value.accepted === 'boolean';
}

export function isAiMessageAnchorRequest(value: unknown): value is AiMessageAnchorRequest {
	return isRecord(value)
		&& hasExactKeys(value, ['conversationId', 'item', 'loadedCount', 'loadedIndex'])
		&& typeof value.conversationId === 'string'
		&& /^messenger-thread:[\w.:-]{1,200}$/.test(value.conversationId)
		&& Number.isSafeInteger(value.loadedCount)
		&& (value.loadedCount as number) > 0
		&& (value.loadedCount as number) <= 500
		&& Number.isSafeInteger(value.loadedIndex)
		&& (value.loadedIndex as number) >= 0
		&& (value.loadedIndex as number) < (value.loadedCount as number)
		&& isAnchorItem(value.item);
}

export function isAiAssistPanelCommand(value: unknown): value is AiAssistPanelCommand {
	if (!isRecord(value) || typeof value.type !== 'string') {
		return false;
	}

	if (['cancel', 'close', 'delete-api-key', 'get-state', 'refresh-conversation', 'test-api-key'].includes(value.type)) {
		return hasExactKeys(value, ['type']);
	}

	if (value.type === 'save-api-key') {
		return hasExactKeys(value, ['apiKey', 'type'])
			&& typeof value.apiKey === 'string'
			&& value.apiKey.length >= 10
			&& value.apiKey.length <= 512;
	}

	if (value.type === 'resolve-media') {
		return hasExactKeys(value, ['kind', 'messageId', 'type'])
			&& mediaKinds.includes(value.kind as never)
			&& isMessageId(value.messageId);
	}

	if (value.type === 'set-context-window') {
		return hasExactKeys(value, ['requestedCount', 'type'])
			&& contextWindowSizes.includes(value.requestedCount as never);
	}

	if (value.type === 'remove-context-item') {
		return hasExactKeys(value, ['index', 'type'])
			&& Number.isSafeInteger(value.index)
			&& (value.index as number) >= 0
			&& (value.index as number) < 50;
	}

	if (value.type === 'edit-context-item') {
		return hasExactKeys(value, ['editedExcerpt', 'index', 'type'])
			&& Number.isSafeInteger(value.index)
			&& (value.index as number) >= 0
			&& (value.index as number) < 50
			&& isBoundedString(value.editedExcerpt, 20_000);
	}

	return value.type === 'submit-prompt'
		&& hasExactKeys(value, ['prompt', 'type'])
		&& typeof value.prompt === 'string'
		&& value.prompt.trim().length > 0
		&& value.prompt.length <= openAiPromptCharacterLimit;
}

function isCredentialsState(value: unknown): boolean {
	return isRecord(value)
		&& hasExactKeys(value, ['configured', 'secureStorageAvailable'])
		&& typeof value.configured === 'boolean'
		&& typeof value.secureStorageAvailable === 'boolean';
}

function isRequestError(value: unknown): boolean {
	return isRecord(value)
		&& hasExactKeys(value, ['code', 'message'])
		&& openAiErrorCodes.includes(value.code as never)
		&& typeof value.message === 'string';
}

function isConversationState(value: unknown): boolean {
	if (!isRecord(value)) {
		return false;
	}

	const expectedKeys = ['captureGeneration', 'status'];
	if (value.displayName !== undefined) {
		expectedKeys.push('displayName');
	}

	return hasExactKeys(value, expectedKeys)
		&& Number.isSafeInteger(value.captureGeneration)
		&& (value.captureGeneration as number) >= 0
		&& ['changed', 'ready', 'unavailable'].includes(value.status as string)
		&& (value.displayName === undefined || (typeof value.displayName === 'string' && value.displayName.length <= 200));
}

function isRequestState(value: unknown): boolean {
	if (!isRecord(value)) {
		return false;
	}

	const requestKeys: string[] = [];
	if (value.answer !== undefined) {
		requestKeys.push('answer');
	}

	if (value.error !== undefined) {
		requestKeys.push('error');
	}

	if (value.notice !== undefined) {
		requestKeys.push('notice');
	}

	return hasExactKeys(value, requestKeys)
		&& (value.answer === undefined || (typeof value.answer === 'string' && value.answer.length <= openAiAnswerCharacterLimit))
		&& (value.notice === undefined || typeof value.notice === 'string')
		&& (value.error === undefined || isRequestError(value.error));
}

function isInvocationState(value: unknown): boolean {
	return isRecord(value)
		&& hasExactKeys(value, ['prompt', 'sequence'])
		&& typeof value.prompt === 'string'
		&& value.prompt.length <= openAiPromptCharacterLimit
		&& Number.isSafeInteger(value.sequence)
		&& (value.sequence as number) > 0;
}

function isReviewedContextItem(value: unknown): boolean {
	if (!isRecord(value)) {
		return false;
	}

	const keys = ['item'];
	if (value.editedExcerpt !== undefined) {
		keys.push('editedExcerpt');
	}

	return hasExactKeys(value, keys)
		&& isContextItem(value.item)
		&& (value.editedExcerpt === undefined || isBoundedString(value.editedExcerpt, 20_000));
}

function isReviewState(value: unknown): boolean {
	return isRecord(value)
		&& hasExactKeys(value, ['actualCount', 'items', 'newMessagesAvailable', 'question', 'requestedCount', 'sequence'])
		&& Number.isSafeInteger(value.actualCount)
		&& (value.actualCount as number) >= 0
		&& (value.actualCount as number) <= 50
		&& Array.isArray(value.items)
		&& value.items.length <= (value.actualCount as number)
		&& value.items.every(item => isReviewedContextItem(item))
		&& typeof value.newMessagesAvailable === 'boolean'
		&& typeof value.question === 'string'
		&& value.question.length <= openAiPromptCharacterLimit
		&& contextWindowSizes.includes(value.requestedCount as never)
		&& Number.isSafeInteger(value.sequence)
		&& (value.sequence as number) > 0;
}

function isMediaCandidate(value: unknown): value is MessengerMediaCandidate {
	if (!isRecord(value)) {
		return false;
	}

	const keys = ['kind', 'messageId'];
	if (value.durationSeconds !== undefined) {
		keys.push('durationSeconds');
	}

	return hasExactKeys(value, keys)
		&& mediaKinds.includes(value.kind as never)
		&& isMessageId(value.messageId)
		&& isDuration(value.durationSeconds);
}

function isMediaState(value: unknown): boolean {
	if (!isRecord(value)) {
		return false;
	}

	const keys = ['candidates'];
	if (value.resolution !== undefined) {
		keys.push('resolution');
	}

	if (!hasExactKeys(value, keys)
		|| !Array.isArray(value.candidates)
		|| value.candidates.length > 100
		|| !value.candidates.every(candidate => isMediaCandidate(candidate))) {
		return false;
	}

	if (value.resolution === undefined || !isRecord(value.resolution)) {
		return value.resolution === undefined;
	}

	const resolutionKeys = ['kind', 'messageId', 'status'];
	for (const key of ['byteLength', 'durationSeconds', 'handleId', 'mimeType', 'sourceType']) {
		if (value.resolution[key] !== undefined) {
			resolutionKeys.push(key);
		}
	}

	if (!(hasExactKeys(value.resolution, resolutionKeys)
		&& mediaKinds.includes(value.resolution.kind as never)
		&& isMessageId(value.resolution.messageId)
		&& ['ready', 'resolving', 'unavailable', 'unsupported'].includes(value.resolution.status as string)
		&& isDuration(value.resolution.durationSeconds)
		&& (value.resolution.byteLength === undefined
			|| (Number.isSafeInteger(value.resolution.byteLength) && (value.resolution.byteLength as number) >= 0))
		&& (value.resolution.handleId === undefined || isMediaHandleId(value.resolution.handleId))
		&& (value.resolution.mimeType === undefined || isMimeType(value.resolution.mimeType))
		&& (value.resolution.sourceType === undefined || mediaSourceTypes.includes(value.resolution.sourceType as never)))) {
		return false;
	}

	if (value.resolution.status === 'ready') {
		return (value.resolution.byteLength as number) > 0
			&& isMediaHandleId(value.resolution.handleId)
			&& isMimeType(value.resolution.mimeType)
			&& ['blob', 'https'].includes(value.resolution.sourceType as string);
	}

	return value.resolution.byteLength === undefined
		&& value.resolution.handleId === undefined
		&& value.resolution.mimeType === undefined;
}

function isSessionState(value: unknown): boolean {
	if (!isRecord(value)) {
		return false;
	}

	const validStatuses = ['cancelled', 'closed', 'invalidated', 'open', 'requesting'];
	const expectedKeys = ['generation', 'status'];
	if (value.sessionId !== undefined) {
		expectedKeys.push('sessionId');
	}

	if (value.invalidationReason !== undefined) {
		expectedKeys.push('invalidationReason');
	}

	return hasExactKeys(value, expectedKeys)
		&& Number.isSafeInteger(value.generation)
		&& (value.generation as number) >= 0
		&& validStatuses.includes(value.status as string)
		&& (value.sessionId === undefined || typeof value.sessionId === 'string')
		&& (
			value.invalidationReason === undefined
			|| aiSessionInvalidationReasons.includes(value.invalidationReason as never)
		);
}

export function isAiAssistPanelState(value: unknown): value is AiAssistPanelState {
	if (!isRecord(value)) {
		return false;
	}

	const keys = ['conversation', 'credentials', 'enabled', 'media', 'request', 'session'];
	if (value.anchor !== undefined) {
		keys.push('anchor');
	}

	if (value.invocation !== undefined) {
		keys.push('invocation');
	}

	if (value.review !== undefined) {
		keys.push('review');
	}

	return hasExactKeys(value, keys)
		&& isConversationState(value.conversation)
		&& (value.anchor === undefined || (
			isRecord(value.anchor)
			&& Number.isSafeInteger(value.anchor.sequence)
			&& (value.anchor.sequence as number) > 0
			&& isAiMessageAnchorRequest({
				conversationId: 'messenger-thread:validated',
				item: value.anchor.item,
				loadedCount: value.anchor.loadedCount,
				loadedIndex: value.anchor.loadedIndex,
			})
			&& hasExactKeys(value.anchor, ['item', 'loadedCount', 'loadedIndex', 'sequence'])
		))
		&& isCredentialsState(value.credentials)
		&& typeof value.enabled === 'boolean'
		&& (value.invocation === undefined || isInvocationState(value.invocation))
		&& isMediaState(value.media)
		&& (value.review === undefined || isReviewState(value.review))
		&& isRequestState(value.request)
		&& isSessionState(value.session);
}

export function isAiAssistMessengerCommand(value: unknown): value is AiAssistMessengerCommand {
	if (!isRecord(value) || typeof value.type !== 'string') {
		return false;
	}

	if (value.type === 'capture-context') {
		const keys = ['conversationId', 'requestId', 'requestedCount', 'type'];
		if (value.anchorMessageId !== undefined) {
			keys.push('anchorMessageId');
		}

		return hasExactKeys(value, keys)
			&& typeof value.conversationId === 'string'
			&& /^messenger-thread:[\w.:-]{1,200}$/.test(value.conversationId)
			&& /^context-capture-\d+$/.test(value.requestId as string)
			&& contextWindowSizes.includes(value.requestedCount as never)
			&& (value.anchorMessageId === undefined || isMessageId(value.anchorMessageId));
	}

	if (value.type === 'report-conversation') {
		const expectedKeys = ['type'];
		if (value.requestId !== undefined) {
			expectedKeys.push('requestId');
		}

		return hasExactKeys(value, expectedKeys)
			&& (value.requestId === undefined || isConversationRequestId(value.requestId));
	}

	if (value.type === 'resolve-media') {
		return hasExactKeys(value, ['kind', 'messageId', 'requestId', 'type'])
			&& mediaKinds.includes(value.kind as never)
			&& isMessageId(value.messageId)
			&& isMediaRequestId(value.requestId);
	}

	return value.type === 'set-enabled'
		&& hasExactKeys(value, ['enabled', 'type'])
		&& typeof value.enabled === 'boolean';
}

export function isAiAssistMessengerEvent(value: unknown): value is AiAssistMessengerEvent {
	if (!isRecord(value)) {
		return false;
	}

	if (value.type === 'context-capture') {
		if (!/^context-capture-\d+$/.test(value.requestId as string)) {
			return false;
		}

		if (value.status === 'unavailable') {
			return hasExactKeys(value, ['reason', 'requestId', 'status', 'type'])
				&& ['conversation-changed', 'empty-context', 'missing-anchor'].includes(value.reason as string);
		}

		return value.status === 'available'
			&& hasExactKeys(value, ['contextVersion', 'conversationId', 'items', 'requestId', 'requestedCount', 'status', 'stopReason', 'type'])
			&& isBoundedString(value.contextVersion, 500)
			&& typeof value.conversationId === 'string'
			&& /^messenger-thread:[\w.:-]{1,200}$/.test(value.conversationId)
			&& Array.isArray(value.items)
			&& value.items.length > 0
			&& value.items.length <= 50
			&& value.items.every(item => isContextItem(item))
			&& contextWindowSizes.includes(value.requestedCount as never)
			&& ['complete', 'no-more-history', 'timeout'].includes(value.stopReason as string);
	}

	if (value.type === 'media-resolution') {
		return isMessengerMediaEvent(value);
	}

	if (value.type !== 'conversation-state') {
		return false;
	}

	if (value.status === 'unavailable') {
		const expectedKeys = ['reason', 'status', 'type'];
		if (value.requestId !== undefined) {
			expectedKeys.push('requestId');
		}

		return hasExactKeys(value, expectedKeys)
			&& (value.requestId === undefined || isConversationRequestId(value.requestId))
			&& conversationIdentityFailureReasons.includes(value.reason as never);
	}

	const expectedKeys = ['conversationId', 'status', 'type'];
	if (value.displayName !== undefined) {
		expectedKeys.push('displayName');
	}

	if (value.mediaCandidates !== undefined) {
		expectedKeys.push('mediaCandidates');
	}

	if (value.contextVersion !== undefined) {
		expectedKeys.push('contextVersion');
	}

	if (value.requestId !== undefined) {
		expectedKeys.push('requestId');
	}

	return value.status === 'available'
		&& hasExactKeys(value, expectedKeys)
		&& typeof value.conversationId === 'string'
		&& /^messenger-thread:[\w.:-]{1,200}$/.test(value.conversationId)
		&& (value.contextVersion === undefined || isBoundedString(value.contextVersion, 500))
		&& (value.requestId === undefined || isConversationRequestId(value.requestId))
		&& (value.displayName === undefined || (typeof value.displayName === 'string' && value.displayName.length <= 200))
		&& (value.mediaCandidates === undefined || (
			Array.isArray(value.mediaCandidates)
			&& value.mediaCandidates.length <= 100
			&& value.mediaCandidates.every(candidate => isMediaCandidate(candidate))
		));
}

function isConversationRequestId(value: unknown): value is string {
	return typeof value === 'string' && /^conversation-report-\d{1,12}$/.test(value);
}

function isMediaRequestId(value: unknown): value is string {
	return typeof value === 'string' && /^media-request-\d{1,12}$/.test(value);
}

function isMessageId(value: unknown): value is string {
	return typeof value === 'string' && value.length <= 200 && /^[\w.:-]+$/.test(value);
}

function isMediaHandleId(value: unknown): value is string {
	return typeof value === 'string' && /^[\da-f-]{36}$/.test(value);
}

function isMimeType(value: unknown): value is string {
	return typeof value === 'string' && value.length <= 100 && /^(?:audio|video)\/[a-z\d.+-]+$/i.test(value);
}

function isDuration(value: unknown): boolean {
	return value === undefined || (
		typeof value === 'number'
		&& Number.isFinite(value)
		&& value >= 0
		&& value <= 7 * 24 * 60 * 60
	);
}

function isMessengerMediaEvent(value: Record<string, unknown>): boolean {
	const keys = ['kind', 'messageId', 'requestId', 'status', 'type'];
	for (const key of ['byteLength', 'durationSeconds', 'handleId', 'mimeType', 'sourceType']) {
		if (value[key] !== undefined) {
			keys.push(key);
		}
	}

	if (!hasExactKeys(value, keys)
		|| !mediaKinds.includes(value.kind as never)
		|| !isMessageId(value.messageId)
		|| !isMediaRequestId(value.requestId)
		|| !['available', 'unavailable', 'unsupported'].includes(value.status as string)
		|| !isDuration(value.durationSeconds)) {
		return false;
	}

	if (value.status !== 'available') {
		return (value.status === 'unsupported'
			? value.sourceType === 'segmented'
			: value.sourceType === undefined || value.sourceType === 'blob' || value.sourceType === 'https')
			&& value.handleId === undefined
			&& value.byteLength === undefined
			&& value.mimeType === undefined;
	}

	if (!mediaSourceTypes.includes(value.sourceType as never) || value.sourceType === 'segmented') {
		return false;
	}

	return isMediaHandleId(value.handleId)
		&& Number.isSafeInteger(value.byteLength)
		&& (value.byteLength as number) > 0
		&& (value.byteLength as number) <= maximumMediaBytes[value.kind as MediaKind]
		&& isMimeType(value.mimeType);
}
