import {
	aiSessionInvalidationReasons,
	AiSessionState,
} from './ai-assist-state';

export const aiAssistIpcChannels = {
	panelCommand: 'ai-assist:panel-command',
	panelStateChanged: 'ai-assist:panel-state-changed',
	messengerCommand: 'ai-assist:messenger-command',
	messengerEvent: 'ai-assist:messenger-event',
} as const;

export type AiAssistPanelState = {
	enabled: boolean;
	session: AiSessionState;
};

export type AiAssistPanelCommand =
	| {type: 'cancel'}
	| {type: 'close'}
	| {type: 'get-state'};

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
	return isRecord(value)
		&& hasExactKeys(value, ['type'])
		&& ['cancel', 'close', 'get-state'].includes(value.type as string);
}

export function isAiAssistPanelState(value: unknown): value is AiAssistPanelState {
	if (
		!isRecord(value)
		|| !hasExactKeys(value, ['enabled', 'session'])
		|| typeof value.enabled !== 'boolean'
		|| !isRecord(value.session)
	) {
		return false;
	}

	const {session} = value;
	const validStatuses = ['cancelled', 'closed', 'invalidated', 'open', 'requesting'];
	const expectedKeys = ['generation', 'status'];
	if (session.sessionId !== undefined) {
		expectedKeys.push('sessionId');
	}

	if (session.invalidationReason !== undefined) {
		expectedKeys.push('invalidationReason');
	}

	return hasExactKeys(session, expectedKeys)
		&& Number.isSafeInteger(session.generation)
		&& (session.generation as number) >= 0
		&& validStatuses.includes(session.status as string)
		&& (session.sessionId === undefined || typeof session.sessionId === 'string')
		&& (
			session.invalidationReason === undefined
			|| aiSessionInvalidationReasons.includes(session.invalidationReason as never)
		);
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
