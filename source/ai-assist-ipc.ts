import {
	aiSessionInvalidationReasons,
	AiSessionState,
} from './ai-assist-state';
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
	| {type: 'save-api-key'; apiKey: string}
	| {type: 'submit-prompt'; prompt: string}
	| {type: 'test-api-key'};

export type AiAssistMessengerCommand = {
	enabled: boolean;
	type: 'set-enabled';
};

export type AiAssistMessengerEvent = {
	type: 'conversation-route-changed';
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

	if (['cancel', 'close', 'delete-api-key', 'get-state', 'test-api-key'].includes(value.type)) {
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
		&& hasExactKeys(value, ['credentials', 'enabled', 'request', 'session'])
		&& isCredentialsState(value.credentials)
		&& typeof value.enabled === 'boolean'
		&& isRequestState(value.request)
		&& isSessionState(value.session);
}

export function isAiAssistMessengerCommand(value: unknown): value is AiAssistMessengerCommand {
	return isRecord(value)
		&& hasExactKeys(value, ['enabled', 'type'])
		&& value.type === 'set-enabled'
		&& typeof value.enabled === 'boolean';
}

export function isAiAssistMessengerEvent(value: unknown): value is AiAssistMessengerEvent {
	return isRecord(value)
		&& hasExactKeys(value, ['type'])
		&& value.type === 'conversation-route-changed';
}
