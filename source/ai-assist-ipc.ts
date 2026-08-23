import {
	aiSessionInvalidationReasons,
	AiSessionState,
	ConversationBindingState,
} from './ai-assist-state';
import {
	conversationIdentityFailureReasons,
	ConversationIdentityFailureReason,
} from './conversation-identity';
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
	panelCommand: 'ai-assist:panel-command',
	panelStateChanged: 'ai-assist:panel-state-changed',
	messengerCommand: 'ai-assist:messenger-command',
	messengerEvent: 'ai-assist:messenger-event',
} as const;

export type AiAssistPanelState = {
	conversation: ConversationBindingState;
	credentials: {
		configured: boolean;
		secureStorageAvailable: boolean;
	};
	enabled: boolean;
	media: {
		candidates: MessengerMediaCandidate[];
		resolution?: MessengerMediaResolution;
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

export type AiAssistPanelCommand =
	| {type: 'cancel'}
	| {type: 'close'}
	| {type: 'delete-api-key'}
	| {type: 'get-state'}
	| {type: 'refresh-conversation'}
	| {type: 'resolve-media'; kind: MediaKind; messageId: string}
	| {type: 'save-api-key'; apiKey: string}
	| {type: 'submit-prompt'; prompt: string}
	| {type: 'test-api-key'};

export type AiAssistMessengerCommand =
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
		conversationId: string;
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
	return isRecord(value)
		&& hasExactKeys(value, ['conversation', 'credentials', 'enabled', 'media', 'request', 'session'])
		&& isConversationState(value.conversation)
		&& isCredentialsState(value.credentials)
		&& typeof value.enabled === 'boolean'
		&& isMediaState(value.media)
		&& isRequestState(value.request)
		&& isSessionState(value.session);
}

export function isAiAssistMessengerCommand(value: unknown): value is AiAssistMessengerCommand {
	if (!isRecord(value) || typeof value.type !== 'string') {
		return false;
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

	if (value.requestId !== undefined) {
		expectedKeys.push('requestId');
	}

	return value.status === 'available'
		&& hasExactKeys(value, expectedKeys)
		&& typeof value.conversationId === 'string'
		&& /^messenger-thread:[\w.:-]{1,200}$/.test(value.conversationId)
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
