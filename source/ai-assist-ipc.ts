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
	draftInsertionFailureReasons,
	DraftInsertionAuthorizationView,
	DraftInsertionFailureReason,
} from './draft-insertion';
import {
	openAiErrorCodes,
	isOpenAiAnswer,
	OpenAiAnswer,
	openAiAnswerCharacterLimit,
	OpenAiErrorCode,
	openAiPromptCharacterLimit,
	WebSearchMode,
	webSearchModes,
} from './openai-client';
import {
	maximumMediaBytes,
	mediaKinds,
	MediaKind,
	mediaSourceTypes,
	MediaSourceType,
} from './media-contract';
import {AiHistoryChatView, maximumHistoryChats, maximumHistoryInteractionsPerChat} from './ai-history-workspace';
import {AiHistoryDeletionConfirmation, AiHistoryDeletionScope} from './ai-history-deletion';
import {ReviewedImageItem, ReviewedImageSelectionSummary} from './reviewed-images';
import {
	maximumReviewedTranscriptCharacters,
	ReviewedTranscriptItem,
	ReviewedTranscriptStatus,
} from './reviewed-transcripts';
import {
	MessengerImageCaptureFailureReason,
	MessengerImageCaptureTarget,
	validateMessengerImageCaptureRectangle,
} from './messenger-image-capture';

export const aiAssistIpcChannels = {
	composerCommand: 'ai-assist:composer-command',
	draftInsertionAuthorization: 'ai-assist:draft-insertion-authorization',
	messageAnchor: 'ai-assist:message-anchor',
	panelCommand: 'ai-assist:panel-command',
	panelStateChanged: 'ai-assist:panel-state-changed',
	messengerCommand: 'ai-assist:messenger-command',
	messengerEvent: 'ai-assist:messenger-event',
} as const;

export type DraftInsertionAuthorizationCheck = {
	answerGeneration: number;
	authorizationToken: string;
	conversationId: string;
	requestId: string;
};

export type AiAssistPanelState = {
	anchor?: MessageAnchorData & {sequence: number};
	conversation: ConversationBindingState;
	contextCapturePending: boolean;
	contextWindowSize: ContextWindowSize;
	webSearchMode: WebSearchMode;
	credentials: {
		configured: boolean;
		secureStorageAvailable: boolean;
	};
	enabled: boolean;
	history: {
		chats: AiHistoryChatView[];
		deletionConfirmation?: AiHistoryDeletionConfirmation;
		query: string;
		selectedChatId?: string;
		status: 'inactive' | 'ready' | 'unavailable';
	};
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
		imageSelection: ReviewedImageSelectionSummary;
		images: ReviewedImageItem[];
		items: ReviewedContextItem[];
		locked: boolean;
		browsingMode: WebSearchMode;
		contextSource: 'current' | 'historical-current' | 'historical-original';
		editable: boolean;
		newMessagesAvailable: boolean;
		question: string;
		requestedCount: ContextWindowSize;
		sequence: number;
		transcripts: ReviewedTranscriptItem[];
	};
	request: {
		answer?: OpenAiAnswer;
		error?: {
			code: OpenAiErrorCode;
			message: string;
		};
		notice?: string;
		insertion?: DraftInsertionAuthorizationView;
	};
	session: AiSessionState;
	videoAnalysis?: {
		coverage?: 'balanced' | 'sparse';
		focusedFrameCount?: number;
		frameCount: number;
		phase: 'extracting-focus' | 'pass-1' | 'pass-2' | 'preprocessing';
		status: 'analyzing' | 'canceled' | 'failed' | 'ready';
		transcriptAvailable: boolean;
	};
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
	| {authorizationToken: string; type: 'cancel-history-deletion'}
	| {type: 'close'}
	| {authorizationToken: string; type: 'confirm-history-deletion'}
	| {type: 'delete-api-key'}
	| {reviewSequence: number; transcriptId: string; type: 'cancel-transcription'}
	| {editedExcerpt: string; itemId: string; reviewSequence: number; type: 'edit-context-item'}
	| {reviewSequence: number; texts: string[]; transcriptId: string; type: 'edit-transcript'}
	| {type: 'get-state'}
	| {itemId: string; processedHandleId: string; reviewSequence: number; type: 'include-reviewed-image'}
	| {chatId: string; contextSource: 'current' | 'original'; interactionId: string; type: 'prepare-history-replay'}
	| {chatId?: string; scope: AiHistoryDeletionScope; type: 'prepare-history-deletion'}
	| {type: 'new-history-chat'}
	| {type: 'open-citation'; url: string}
	| {reviewSequence: number; transcriptId: string; type: 'prepare-transcript'}
	| {answerGeneration: number; authorizationToken: string; conversationId: string; type: 'insert-answer'}
	| {itemId: string; reviewSequence: number; type: 'remove-context-item'}
	| {itemId: string; processedHandleId: string; reviewSequence: number; type: 'remove-reviewed-image'}
	| {reviewSequence: number; transcriptId: string; type: 'remove-transcript'}
	| {type: 'refresh-context'}
	| {type: 'refresh-conversation'}
	| {type: 'resolve-media'; kind: MediaKind; messageId: string}
	| {type: 'save-api-key'; apiKey: string}
	| {chatId: string; type: 'select-history-chat'}
	| {query: string; type: 'search-history'}
	| {requestedCount: ContextWindowSize; type: 'set-context-window'}
	| {mode: WebSearchMode; type: 'set-web-search-mode'}
	| {type: 'submit-prompt'; prompt: string}
	| {type: 'test-api-key'}
	| {reviewSequence: number; transcriptId: string; type: 'transcribe-reviewed-media'};

export type AiAssistMessengerCommand =
	| {requestId: string; type: 'cancel-context-capture'}
	| {requestId: string; type: 'cancel-draft-insertion'}
	| {
		anchorMessageId?: string;
		conversationId: string;
		requestId: string;
		requestedCount: ContextWindowSize;
		type: 'capture-context';
	}
	| {enabled: boolean; type: 'set-enabled'}
	| {
		answerGeneration: number;
		authorizationToken: string;
		conversationId: string;
		requestId: string;
		text: string;
		type: 'insert-draft';
	}
	| {requestId?: string; type: 'report-conversation'}
	| {conversationId: string; messageId: string; requestId: string; type: 'resolve-image-target'}
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
		answerGeneration: number;
		authorizationToken: string;
		conversationId: string;
		requestId: string;
		status: 'inserted';
		type: 'draft-insertion';
	}
	| {
		answerGeneration: number;
		authorizationToken: string;
		conversationId: string;
		reason: DraftInsertionFailureReason;
		requestId: string;
		status: 'blocked';
		type: 'draft-insertion';
	}
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
		reason: MessengerImageCaptureFailureReason;
		requestId: string;
		status: 'unavailable';
		type: 'image-target-resolution';
	}
	| (MessengerImageCaptureTarget & {
		requestId: string;
		status: 'available';
		type: 'image-target-resolution';
	})
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

function isImageTargetResolution(value: Record<string, unknown>): boolean {
	if (!/^image-target-request-\d+$/.test(value.requestId as string)) {
		return false;
	}

	if (value.status === 'unavailable') {
		return hasExactKeys(value, ['reason', 'requestId', 'status', 'type'])
			&& [
				'aborted',
				'ambiguous-target',
				'capture-failed',
				'conversation-changed',
				'detached-target',
				'hidden-target',
				'invalid-message',
				'missing-target',
				'out-of-bounds',
				'oversized-target',
				'replaced-target',
			].includes(value.reason as string);
	}

	if (
		value.status !== 'available'
		|| !hasExactKeys(value, [
			'conversationId',
			'messageId',
			'rectangle',
			'requestId',
			'status',
			'targetToken',
			'type',
			'viewport',
		])
		|| !isConversationId(value.conversationId)
		|| !isMessageId(value.messageId)
		|| !isRecord(value.rectangle)
		|| !hasExactKeys(value.rectangle, ['height', 'width', 'x', 'y'])
		|| !isRecord(value.viewport)
		|| !hasExactKeys(value.viewport, ['height', 'width'])
		|| !isBoundedString(value.targetToken, 200)
	) {
		return false;
	}

	const rectangle = value.rectangle as Record<'height' | 'width' | 'x' | 'y', number>;
	const viewport = value.viewport as Record<'height' | 'width', number>;
	const validated = validateMessengerImageCaptureRectangle(rectangle, viewport);
	return validated.status === 'available'
		&& validated.rectangle.height === rectangle.height
		&& validated.rectangle.width === rectangle.width
		&& validated.rectangle.x === rectangle.x
		&& validated.rectangle.y === rectangle.y;
}

function isConversationId(value: unknown): value is string {
	return typeof value === 'string' && /^messenger-thread:[\w.:-]{1,200}$/.test(value);
}

function isDraftInsertionToken(value: unknown): value is string {
	return typeof value === 'string'
		&& /^draft-insertion-token:[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(value);
}

function isDraftInsertionRequestId(value: unknown): value is string {
	return typeof value === 'string' && /^draft-insertion-request-\d+$/.test(value);
}

function isAnswerGeneration(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}

export function isDraftInsertionAuthorizationCheck(value: unknown): value is DraftInsertionAuthorizationCheck {
	return isRecord(value)
		&& hasExactKeys(value, ['answerGeneration', 'authorizationToken', 'conversationId', 'requestId'])
		&& isAnswerGeneration(value.answerGeneration)
		&& isDraftInsertionToken(value.authorizationToken)
		&& isConversationId(value.conversationId)
		&& isDraftInsertionRequestId(value.requestId);
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

	if (['cancel', 'close', 'delete-api-key', 'get-state', 'new-history-chat', 'refresh-context', 'refresh-conversation', 'test-api-key'].includes(value.type)) {
		return hasExactKeys(value, ['type']);
	}

	if (value.type === 'select-history-chat') {
		return hasExactKeys(value, ['chatId', 'type']) && isBoundedString(value.chatId, 512);
	}

	if (['cancel-history-deletion', 'confirm-history-deletion'].includes(value.type)) {
		return hasExactKeys(value, ['authorizationToken', 'type'])
			&& isBoundedString(value.authorizationToken, 200)
			&& value.authorizationToken.startsWith('history-deletion-token:');
	}

	if (value.type === 'prepare-history-deletion') {
		const keys = ['scope', 'type'];
		if (value.chatId !== undefined) {
			keys.push('chatId');
		}

		return hasExactKeys(value, keys)
			&& ['all', 'chat', 'conversation'].includes(value.scope as string)
			&& (value.scope === 'chat'
				? isBoundedString(value.chatId, 512)
				: value.chatId === undefined);
	}

	if (value.type === 'prepare-history-replay') {
		return hasExactKeys(value, ['chatId', 'contextSource', 'interactionId', 'type'])
			&& isBoundedString(value.chatId, 512)
			&& ['current', 'original'].includes(value.contextSource as string)
			&& isBoundedString(value.interactionId, 512);
	}

	if (value.type === 'open-citation') {
		return hasExactKeys(value, ['type', 'url'])
			&& typeof value.url === 'string'
			&& value.url.length <= 8192;
	}

	if (value.type === 'search-history') {
		return hasExactKeys(value, ['query', 'type'])
			&& typeof value.query === 'string'
			&& value.query.length <= 200;
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

	if (value.type === 'set-web-search-mode') {
		return hasExactKeys(value, ['mode', 'type'])
			&& webSearchModes.includes(value.mode as never);
	}

	if (value.type === 'insert-answer') {
		return hasExactKeys(value, ['answerGeneration', 'authorizationToken', 'conversationId', 'type'])
			&& isAnswerGeneration(value.answerGeneration)
			&& isDraftInsertionToken(value.authorizationToken)
			&& isConversationId(value.conversationId);
	}

	if (value.type === 'remove-context-item') {
		return hasExactKeys(value, ['itemId', 'reviewSequence', 'type'])
			&& isBoundedString(value.itemId, 200)
			&& Number.isSafeInteger(value.reviewSequence)
			&& (value.reviewSequence as number) > 0;
	}

	if (['cancel-transcription', 'prepare-transcript', 'remove-transcript', 'transcribe-reviewed-media'].includes(value.type)) {
		return hasExactKeys(value, ['reviewSequence', 'transcriptId', 'type'])
			&& isBoundedString(value.transcriptId, 200)
			&& Number.isSafeInteger(value.reviewSequence)
			&& (value.reviewSequence as number) > 0;
	}

	if (value.type === 'edit-transcript') {
		return hasExactKeys(value, ['reviewSequence', 'texts', 'transcriptId', 'type'])
			&& isBoundedString(value.transcriptId, 200)
			&& Number.isSafeInteger(value.reviewSequence)
			&& (value.reviewSequence as number) > 0
			&& Array.isArray(value.texts)
			&& value.texts.length > 0
			&& value.texts.length <= 1000
			&& value.texts.every(text => isBoundedString(text, 20_000))
			&& (value.texts as string[]).reduce((total, text) => total + text.length, 0) <= maximumReviewedTranscriptCharacters;
	}

	if (value.type === 'include-reviewed-image' || value.type === 'remove-reviewed-image') {
		return hasExactKeys(value, ['itemId', 'processedHandleId', 'reviewSequence', 'type'])
			&& isBoundedString(value.itemId, 200)
			&& /^processed-image-\d+$/.test(value.processedHandleId as string)
			&& Number.isSafeInteger(value.reviewSequence)
			&& (value.reviewSequence as number) > 0;
	}

	if (value.type === 'edit-context-item') {
		return hasExactKeys(value, ['editedExcerpt', 'itemId', 'reviewSequence', 'type'])
			&& isBoundedString(value.itemId, 200)
			&& Number.isSafeInteger(value.reviewSequence)
			&& (value.reviewSequence as number) > 0
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

	if (value.insertion !== undefined) {
		requestKeys.push('insertion');
	}

	return hasExactKeys(value, requestKeys)
		&& (value.answer === undefined || isOpenAiAnswer(value.answer))
		&& (value.notice === undefined || typeof value.notice === 'string')
		&& (value.insertion === undefined || value.answer !== undefined)
		&& (value.insertion === undefined || (
			isRecord(value.insertion)
			&& hasExactKeys(value.insertion, ['answerGeneration', 'authorizationToken', 'conversationId'])
			&& isAnswerGeneration(value.insertion.answerGeneration)
			&& isDraftInsertionToken(value.insertion.authorizationToken)
			&& isConversationId(value.insertion.conversationId)
		))
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

	const keys = ['id', 'item'];
	if (value.editedExcerpt !== undefined) {
		keys.push('editedExcerpt');
	}

	return hasExactKeys(value, keys)
		&& isBoundedString(value.id, 200)
		&& isContextItem(value.item)
		&& (value.editedExcerpt === undefined || isBoundedString(value.editedExcerpt, 20_000));
}

function isReviewedImageItem(value: unknown): boolean {
	if (!isRecord(value)) {
		return false;
	}

	const commonKeys = ['id', 'messageContext', 'messageId', 'senderLabel', 'status'];
	if (value.status === 'capture-failed' || value.status === 'normalization-failed') {
		return hasExactKeys(value, [...commonKeys, 'failureReason'])
			&& isBoundedString(value.id, 200)
			&& isMessageId(value.messageId)
			&& typeof value.messageContext === 'string'
			&& value.messageContext.length <= 1000
			&& isBoundedString(value.senderLabel, 200)
			&& isBoundedString(value.failureReason, 500);
	}

	return ['available', 'removed', 'selected'].includes(value.status as string)
		&& hasExactKeys(value, [
			...commonKeys,
			'byteLength',
			'height',
			'mimeType',
			'processedHandleId',
			'thumbnailDataUrl',
			'width',
		])
		&& isBoundedString(value.id, 200)
		&& isMessageId(value.messageId)
		&& typeof value.messageContext === 'string'
		&& value.messageContext.length <= 1000
		&& isBoundedString(value.senderLabel, 200)
		&& value.mimeType === 'image/png'
		&& /^processed-image-\d+$/.test(value.processedHandleId as string)
		&& Number.isSafeInteger(value.byteLength)
		&& (value.byteLength as number) > 0
		&& (value.byteLength as number) <= 20 * 1024 * 1024
		&& Number.isSafeInteger(value.width)
		&& (value.width as number) > 0
		&& (value.width as number) <= 2048
		&& Number.isSafeInteger(value.height)
		&& (value.height as number) > 0
		&& (value.height as number) <= 2048
		&& typeof value.thumbnailDataUrl === 'string'
		&& value.thumbnailDataUrl.startsWith('data:image/png;base64,')
		&& value.thumbnailDataUrl.length <= 28 * 1024 * 1024;
}

function isTranscriptSegment(value: unknown): boolean {
	return isRecord(value)
		&& hasExactKeys(value, ['endSeconds', 'startSeconds', 'text'])
		&& typeof value.startSeconds === 'number'
		&& Number.isFinite(value.startSeconds)
		&& value.startSeconds >= 0
		&& typeof value.endSeconds === 'number'
		&& Number.isFinite(value.endSeconds)
		&& value.endSeconds > value.startSeconds
		&& isBoundedString(value.text, 20_000);
}

function isTranscriptSegments(value: unknown): value is Array<{endSeconds: number; startSeconds: number; text: string}> {
	return Array.isArray(value)
		&& value.length > 0
		&& value.length <= 1000
		&& value.every(segment => isTranscriptSegment(segment))
		&& (value as Array<{text: string}>).reduce((total, segment) => total + segment.text.length, 0) <= maximumReviewedTranscriptCharacters;
}

function isReviewedTranscriptItem(value: unknown): value is ReviewedTranscriptItem {
	if (!isRecord(value)) {
		return false;
	}

	const keys = ['contextItemId', 'id', 'kind', 'messageId', 'senderLabel', 'status'];
	for (const key of ['byteLength', 'durationSeconds', 'editedSegments', 'mimeType', 'notice', 'originalSegments']) {
		if (value[key] !== undefined) {
			keys.push(key);
		}
	}

	const validStatuses: ReviewedTranscriptStatus[] = [
		'available',
		'preparing',
		'ready',
		'extracting',
		'transcribing',
		'completed',
		'no-audio',
		'canceled',
		'oversized',
		'unsupported',
		'timed-out',
		'failed',
		'removed',
	];
	if (!hasExactKeys(value, keys)
		|| !isBoundedString(value.contextItemId, 200)
		|| !isBoundedString(value.id, 200)
		|| !['audio', 'video'].includes(value.kind as string)
		|| !isMessageId(value.messageId)
		|| !isBoundedString(value.senderLabel, 200)
		|| !validStatuses.includes(value.status as ReviewedTranscriptStatus)
		|| (value.byteLength !== undefined && (!Number.isSafeInteger(value.byteLength) || (value.byteLength as number) <= 0))
		|| !isDuration(value.durationSeconds)
		|| (value.mimeType !== undefined && !isMimeType(value.mimeType))
		|| (value.notice !== undefined && !isBoundedString(value.notice, 1000))) {
		return false;
	}

	for (const key of ['originalSegments', 'editedSegments']) {
		const segments = value[key];
		if (segments !== undefined && !isTranscriptSegments(segments)) {
			return false;
		}
	}

	const {editedSegments, originalSegments} = value;
	return (value.status !== 'completed' || isTranscriptSegments(originalSegments))
		&& (editedSegments === undefined || (
			isTranscriptSegments(originalSegments)
			&& isTranscriptSegments(editedSegments)
			&& editedSegments.length === originalSegments.length
			&& editedSegments.every((segment, index) => (
				segment.startSeconds === originalSegments[index].startSeconds
				&& segment.endSeconds === originalSegments[index].endSeconds
			))
		));
}

function isImageSelectionSummary(value: unknown): boolean {
	if (!isRecord(value)) {
		return false;
	}

	const keys = ['aggregateBytes', 'selectedCount'];
	if (value.blockingNotice !== undefined) {
		keys.push('blockingNotice');
	}

	return hasExactKeys(value, keys)
		&& Number.isSafeInteger(value.aggregateBytes)
		&& (value.aggregateBytes as number) >= 0
		&& Number.isSafeInteger(value.selectedCount)
		&& (value.selectedCount as number) >= 0
		&& (value.selectedCount as number) <= 50
		&& (value.blockingNotice === undefined || isBoundedString(value.blockingNotice, 500));
}

function isReviewState(value: unknown): boolean {
	if (!isRecord(value)) {
		return false;
	}

	const keys = ['actualCount', 'browsingMode', 'contextSource', 'editable', 'items', 'locked', 'newMessagesAvailable', 'question', 'requestedCount', 'sequence', 'transcripts'];
	if (value.images !== undefined || value.imageSelection !== undefined) {
		keys.push('imageSelection', 'images');
	}

	return isRecord(value)
		&& hasExactKeys(value, keys)
		&& Number.isSafeInteger(value.actualCount)
		&& (value.actualCount as number) >= 0
		&& (value.actualCount as number) <= 50
		&& webSearchModes.includes(value.browsingMode as never)
		&& ['current', 'historical-current', 'historical-original'].includes(value.contextSource as string)
		&& typeof value.editable === 'boolean'
		&& Array.isArray(value.items)
		&& value.items.length <= (value.actualCount as number)
		&& value.items.every(item => isReviewedContextItem(item))
		&& Array.isArray(value.transcripts)
		&& value.transcripts.length <= 50
		&& value.transcripts.every(item => isReviewedTranscriptItem(item))
		&& (value.images === undefined || (
			Array.isArray(value.images)
			&& value.images.length <= 50
			&& value.images.every(item => isReviewedImageItem(item))
			&& isImageSelectionSummary(value.imageSelection)
		))
		&& typeof value.locked === 'boolean'
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

function isHistoryInteraction(value: unknown): boolean {
	return isRecord(value)
		&& hasExactKeys(value, [
			'answer',
			'artifacts',
			'browsingMode',
			'citations',
			'completedAt',
			'context',
			'draftStatus',
			'id',
			'model',
			'originalReplay',
			'question',
			'shareStatus',
			'webSearchRan',
		])
		&& typeof value.answer === 'string'
		&& value.answer.length <= 20_000
		&& Array.isArray(value.artifacts)
		&& value.artifacts.length <= 100
		&& value.artifacts.every(artifact => isRecord(artifact)
			&& hasExactKeys(artifact, ['id', 'kind'])
			&& isBoundedString(artifact.id, 512)
			&& ['keyframe', 'timeline', 'transcript'].includes(artifact.kind as string))
		&& webSearchModes.includes(value.browsingMode as never)
		&& Array.isArray(value.citations)
		&& value.citations.length <= 100
		&& value.citations.every(citation => isRecord(citation)
			&& hasExactKeys(citation, ['title', 'url'])
			&& typeof citation.title === 'string'
			&& citation.title.length <= 500
			&& typeof citation.url === 'string'
			&& citation.url.length <= 2048)
		&& Number.isSafeInteger(value.completedAt)
		&& Array.isArray(value.context)
		&& value.context.length <= 50
		&& value.context.every(item => isRecord(item)
			&& hasExactKeys(item, ['excerpt', 'id', 'metadata'])
			&& typeof item.excerpt === 'string'
			&& item.excerpt.length <= 20_000
			&& isBoundedString(item.id, 512)
			&& typeof item.metadata === 'string'
			&& item.metadata.length <= 500)
		&& ['inserted', 'not-inserted'].includes(value.draftStatus as string)
		&& isBoundedString(value.id, 512)
		&& isBoundedString(value.model, 200)
		&& isRecord(value.originalReplay)
		&& (
			(hasExactKeys(value.originalReplay, ['available']) && value.originalReplay.available === true)
			|| (
				hasExactKeys(value.originalReplay, ['available', 'reason'])
				&& value.originalReplay.available === false
				&& ['missing-artifacts', 'unsupported-metadata'].includes(value.originalReplay.reason as string)
			)
		)
		&& typeof value.question === 'string'
		&& value.question.length <= 20_000
		&& ['private', 'shared'].includes(value.shareStatus as string)
		&& typeof value.webSearchRan === 'boolean';
}

function isHistoryState(value: unknown): boolean {
	if (!isRecord(value)) {
		return false;
	}

	const keys = ['chats', 'query', 'status'];
	if (value.selectedChatId !== undefined) {
		keys.push('selectedChatId');
	}

	if (value.deletionConfirmation !== undefined) {
		keys.push('deletionConfirmation');
	}

	return hasExactKeys(value, keys)
		&& ['inactive', 'ready', 'unavailable'].includes(value.status as string)
		&& typeof value.query === 'string'
		&& value.query.length <= 200
		&& (value.selectedChatId === undefined || isBoundedString(value.selectedChatId, 512))
		&& (value.deletionConfirmation === undefined || isHistoryDeletionConfirmation(value.deletionConfirmation))
		&& Array.isArray(value.chats)
		&& value.chats.length <= maximumHistoryChats
		&& value.chats.every(chat => isRecord(chat)
			&& hasExactKeys(chat, ['badges', 'contextCount', 'createdAt', 'id', 'interactionCount', 'interactions', 'lastActivityAt', 'preview', 'title'])
			&& Array.isArray(chat.badges)
			&& chat.badges.length <= 4
			&& chat.badges.every(badge => ['Audio', 'Image', 'Video', 'Web'].includes(badge as string))
			&& Number.isSafeInteger(chat.contextCount)
			&& Number.isSafeInteger(chat.createdAt)
			&& isBoundedString(chat.id, 512)
			&& Number.isSafeInteger(chat.interactionCount)
			&& Array.isArray(chat.interactions)
			&& chat.interactions.length <= maximumHistoryInteractionsPerChat
			&& chat.interactions.every(interaction => isHistoryInteraction(interaction))
			&& Number.isSafeInteger(chat.lastActivityAt)
			&& typeof chat.preview === 'string'
			&& chat.preview.length <= 240
			&& isBoundedString(chat.title, 120));
}

function isHistoryDeletionConfirmation(value: unknown): value is AiHistoryDeletionConfirmation {
	return isRecord(value)
		&& hasExactKeys(value, ['authorizationToken', 'confirmLabel', 'message', 'scope', 'title'])
		&& isBoundedString(value.authorizationToken, 200)
		&& value.authorizationToken.startsWith('history-deletion-token:')
		&& isBoundedString(value.confirmLabel, 80)
		&& isBoundedString(value.message, 1000)
		&& ['all', 'chat', 'conversation'].includes(value.scope as string)
		&& isBoundedString(value.title, 200);
}

export function isAiAssistPanelState(value: unknown): value is AiAssistPanelState {
	if (!isRecord(value)) {
		return false;
	}

	const keys = ['contextCapturePending', 'contextWindowSize', 'conversation', 'credentials', 'enabled', 'history', 'media', 'request', 'session', 'webSearchMode'];
	if (value.anchor !== undefined) {
		keys.push('anchor');
	}

	if (value.invocation !== undefined) {
		keys.push('invocation');
	}

	if (value.review !== undefined) {
		keys.push('review');
	}

	if (value.videoAnalysis !== undefined) {
		keys.push('videoAnalysis');
	}

	return hasExactKeys(value, keys)
		&& typeof value.contextCapturePending === 'boolean'
		&& contextWindowSizes.includes(value.contextWindowSize as never)
		&& webSearchModes.includes(value.webSearchMode as never)
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
		&& isHistoryState(value.history)
		&& (value.invocation === undefined || isInvocationState(value.invocation))
		&& isMediaState(value.media)
		&& (value.review === undefined || isReviewState(value.review))
		&& (value.videoAnalysis === undefined || (
			isRecord(value.videoAnalysis)
			&& hasExactKeys(value.videoAnalysis, [
				'frameCount',
				'phase',
				'status',
				'transcriptAvailable',
				...(value.videoAnalysis.coverage === undefined ? [] : ['coverage']),
				...(value.videoAnalysis.focusedFrameCount === undefined ? [] : ['focusedFrameCount']),
			])
			&& Number.isSafeInteger(value.videoAnalysis.frameCount)
			&& (value.videoAnalysis.frameCount as number) >= 0
			&& (value.videoAnalysis.frameCount as number) <= 180
			&& ['extracting-focus', 'pass-1', 'pass-2', 'preprocessing'].includes(value.videoAnalysis.phase as string)
			&& ['analyzing', 'canceled', 'failed', 'ready'].includes(value.videoAnalysis.status as string)
			&& typeof value.videoAnalysis.transcriptAvailable === 'boolean'
			&& (value.videoAnalysis.coverage === undefined || ['balanced', 'sparse'].includes(value.videoAnalysis.coverage as string))
			&& (value.videoAnalysis.focusedFrameCount === undefined || (
				Number.isSafeInteger(value.videoAnalysis.focusedFrameCount)
				&& (value.videoAnalysis.focusedFrameCount as number) >= 0
				&& (value.videoAnalysis.focusedFrameCount as number) <= 48
			))
		))
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

	if (value.type === 'cancel-context-capture') {
		return hasExactKeys(value, ['requestId', 'type'])
			&& /^context-capture-\d+$/.test(value.requestId as string);
	}

	if (value.type === 'cancel-draft-insertion') {
		return hasExactKeys(value, ['requestId', 'type'])
			&& isDraftInsertionRequestId(value.requestId);
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

	if (value.type === 'resolve-image-target') {
		return hasExactKeys(value, ['conversationId', 'messageId', 'requestId', 'type'])
			&& isConversationId(value.conversationId)
			&& isMessageId(value.messageId)
			&& /^image-target-request-\d+$/.test(value.requestId as string);
	}

	if (value.type === 'insert-draft') {
		return hasExactKeys(value, ['answerGeneration', 'authorizationToken', 'conversationId', 'requestId', 'text', 'type'])
			&& isAnswerGeneration(value.answerGeneration)
			&& isDraftInsertionToken(value.authorizationToken)
			&& isConversationId(value.conversationId)
			&& isDraftInsertionRequestId(value.requestId)
			&& isBoundedString(value.text, openAiAnswerCharacterLimit);
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

	if (value.type === 'image-target-resolution') {
		return isImageTargetResolution(value);
	}

	if (value.type === 'draft-insertion') {
		const expectedKeys = ['answerGeneration', 'authorizationToken', 'conversationId', 'requestId', 'status', 'type'];
		if (value.status === 'blocked') {
			expectedKeys.push('reason');
		}

		return hasExactKeys(value, expectedKeys)
			&& isAnswerGeneration(value.answerGeneration)
			&& isDraftInsertionToken(value.authorizationToken)
			&& isConversationId(value.conversationId)
			&& isDraftInsertionRequestId(value.requestId)
			&& (
				value.status === 'inserted'
				|| (value.status === 'blocked' && draftInsertionFailureReasons.includes(value.reason as never))
			);
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
