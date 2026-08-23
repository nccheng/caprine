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
	| {type: 'save-api-key'; apiKey: string}
	| {type: 'submit-prompt'; prompt: string}
	| {type: 'test-api-key'};

export type AiAssistMessengerCommand =
	| {enabled: boolean; type: 'set-enabled'}
	| {requestId?: string; type: 'report-conversation'};

export type AiAssistMessengerEvent =
	| {
		conversationId: string;
		displayName?: string;
		requestId?: string;
		status: 'available';
		type: 'conversation-state';
	}
	| {
		reason: ConversationIdentityFailureReason;
		requestId?: string;
		status: 'unavailable';
		type: 'conversation-state';
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
		&& hasExactKeys(value, ['conversation', 'credentials', 'enabled', 'request', 'session'])
		&& isConversationState(value.conversation)
		&& isCredentialsState(value.credentials)
		&& typeof value.enabled === 'boolean'
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

	return value.type === 'set-enabled'
		&& hasExactKeys(value, ['enabled', 'type'])
		&& typeof value.enabled === 'boolean';
}

export function isAiAssistMessengerEvent(value: unknown): value is AiAssistMessengerEvent {
	if (!isRecord(value) || value.type !== 'conversation-state') {
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

	if (value.requestId !== undefined) {
		expectedKeys.push('requestId');
	}

	return value.status === 'available'
		&& hasExactKeys(value, expectedKeys)
		&& typeof value.conversationId === 'string'
		&& /^messenger-thread:[\w.:-]{1,200}$/.test(value.conversationId)
		&& (value.requestId === undefined || isConversationRequestId(value.requestId))
		&& (value.displayName === undefined || (typeof value.displayName === 'string' && value.displayName.length <= 200));
}

function isConversationRequestId(value: unknown): value is string {
	return typeof value === 'string' && /^conversation-report-\d{1,12}$/.test(value);
}
