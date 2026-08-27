import {OpenAiErrorCode, openAiErrorCodes} from './openai-client';

export const diagnosticAvailabilityValues = ['available', 'checking', 'missing'] as const;
export const diagnosticHealthValues = ['degraded', 'healthy', 'not-checked'] as const;
export const diagnosticMediaErrorCodes = ['unavailable', 'unsupported'] as const;

export type AiAssistDiagnostics = {
	aiEnabled: boolean;
	contextAdapter: typeof diagnosticHealthValues[number];
	copySequence: number;
	historyDatabase: 'reachable' | 'unavailable';
	lastMediaError: typeof diagnosticMediaErrorCodes[number] | 'none';
	lastProviderError: OpenAiErrorCode | 'none';
	messengerConversation: 'degraded' | 'healthy';
	openAiKey: 'configured' | 'missing';
	panel: 'loaded' | 'loading';
	videoTools: {
		ffmpeg: typeof diagnosticAvailabilityValues[number];
		ffprobe: typeof diagnosticAvailabilityValues[number];
	};
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actualKeys = Object.keys(value);
	return actualKeys.length === keys.length && keys.every(key => actualKeys.includes(key));
}

export function isAiAssistDiagnostics(value: unknown): value is AiAssistDiagnostics {
	if (!isRecord(value) || !isRecord(value.videoTools)) {
		return false;
	}

	return hasExactKeys(value, [
		'aiEnabled',
		'contextAdapter',
		'copySequence',
		'historyDatabase',
		'lastMediaError',
		'lastProviderError',
		'messengerConversation',
		'openAiKey',
		'panel',
		'videoTools',
	])
		&& typeof value.aiEnabled === 'boolean'
		&& diagnosticHealthValues.includes(value.contextAdapter as never)
		&& Number.isSafeInteger(value.copySequence)
		&& (value.copySequence as number) > 0
		&& ['reachable', 'unavailable'].includes(value.historyDatabase as string)
		&& (value.lastMediaError === 'none' || diagnosticMediaErrorCodes.includes(value.lastMediaError as never))
		&& (value.lastProviderError === 'none' || openAiErrorCodes.includes(value.lastProviderError as never))
		&& ['degraded', 'healthy'].includes(value.messengerConversation as string)
		&& ['configured', 'missing'].includes(value.openAiKey as string)
		&& ['loaded', 'loading'].includes(value.panel as string)
		&& hasExactKeys(value.videoTools, ['ffmpeg', 'ffprobe'])
		&& diagnosticAvailabilityValues.includes(value.videoTools.ffmpeg as never)
		&& diagnosticAvailabilityValues.includes(value.videoTools.ffprobe as never);
}

export function formatAiAssistDiagnostics(value: AiAssistDiagnostics): string {
	if (!isAiAssistDiagnostics(value)) {
		throw new TypeError('Invalid AI Assist diagnostics');
	}

	return [
		'Caprine AI Assist diagnostics',
		`AI enabled: ${value.aiEnabled ? 'yes' : 'no'}`,
		`OpenAI key: ${value.openAiKey}`,
		`Local panel: ${value.panel}`,
		`Messenger conversation: ${value.messengerConversation}`,
		`Context adapter: ${value.contextAdapter}`,
		`ffmpeg: ${value.videoTools.ffmpeg}`,
		`ffprobe: ${value.videoTools.ffprobe}`,
		`History database: ${value.historyDatabase}`,
		`Last provider error: ${value.lastProviderError}`,
		`Last media error: ${value.lastMediaError}`,
	].join('\n');
}

export class DiagnosticsCopyAuthorization {
	private sequence = 1;

	get current(): number {
		return this.sequence;
	}

	advance(): number {
		this.sequence += 1;
		return this.sequence;
	}

	consume(sequence: number): boolean {
		if (sequence !== this.sequence) {
			return false;
		}

		this.advance();
		return true;
	}
}
