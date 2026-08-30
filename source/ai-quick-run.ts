import {openAiErrorCodes, WebSearchMode} from './openai-client';

export const quickRunStages = ['invocation', 'context', 'question-send', 'model', 'reply', 'answer-send'] as const;
export const quickRunOutcomes = ['running', 'completed', 'failed', 'cancelled', 'interrupted', 'send-uncertain'] as const;
export const quickEventStatuses = ['started', 'succeeded', 'failed', 'cancelled', 'unknown'] as const;
export const quickRunErrorCodes = [
	...openAiErrorCodes,
	'conversation-changed',
	'composer-changed',
	'draft-present',
	'attachment-present',
	'quote-present',
	'quote-unavailable',
	'quote-mismatch',
	'send-control-unavailable',
	'send-result-unknown',
	'message-unavailable',
	'message-ambiguous',
	'history-unavailable',
	'context-unavailable',
	'restart',
	'unsupported-media',
	'disabled',
	'busy',
	'stale-authorization',
] as const;

export type QuickRunStage = typeof quickRunStages[number];
export type QuickRunOutcome = typeof quickRunOutcomes[number];
export type QuickRunErrorCode = typeof quickRunErrorCodes[number];
export type QuickRunEvent = {
	at: number;
	code?: QuickRunErrorCode;
	stage: QuickRunStage;
	status: typeof quickEventStatuses[number];
};

// Private, local data. The clipboard formatter below intentionally never serializes this object.
export type AiQuickRun = {
	id: string;
	chatId: string;
	conversationId: string;
	createdAt: number;
	updatedAt: number;
	appVersion: string;
	model: string;
	browsingMode: WebSearchMode;
	contextCount: number;
	question: string;
	prompt: string;
	contextJson?: string;
	answer: string;
	questionMessageId?: string;
	answerMessageId?: string;
	interactionId?: string;
	outcome: QuickRunOutcome;
	events: QuickRunEvent[];
};

export const maximumQuickRunsPerChat = 25;
export const maximumQuickRunEvents = 24;
// A rejected provider input still needs a valid local diagnostic record.
export const maximumQuickRunInputCharacters = 2_000_000;

export function advanceQuickRun(
	run: Readonly<AiQuickRun>,
	event: QuickRunEvent,
	outcome: QuickRunOutcome = 'running',
): AiQuickRun {
	if (run.outcome !== 'running' || run.events.length >= maximumQuickRunEvents || event.at < run.updatedAt) {
		throw new Error('Cannot advance a finished, full, or older quick run');
	}

	return {
		...run, events: [...run.events, {...event}], updatedAt: event.at, outcome,
	};
}

export function interruptedQuickRun(run: Readonly<AiQuickRun>, at: number): AiQuickRun {
	const last = run.events.at(-1);
	const uncertain = last?.status === 'started' && (last.stage === 'question-send' || last.stage === 'answer-send');
	return advanceQuickRun(run, {
		at: Math.max(at, run.updatedAt),
		code: 'restart',
		stage: last?.stage ?? 'invocation',
		status: uncertain ? 'unknown' : 'cancelled',
	}, uncertain ? 'send-uncertain' : 'interrupted');
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isAiQuickRun(value: unknown): value is AiQuickRun {
	if (!isRecord(value)) {
		return false;
	}

	const keys = ['id', 'chatId', 'conversationId', 'createdAt', 'updatedAt', 'appVersion', 'model', 'browsingMode', 'contextCount', 'question', 'prompt', 'answer', 'outcome', 'events'];
	for (const key of ['questionMessageId', 'answerMessageId', 'interactionId', 'contextJson']) {
		if (value[key] !== undefined) {
			keys.push(key);
		}
	}

	const text = (key: string, limit: number) => typeof value[key] === 'string' && (value[key] as string).length <= limit;
	return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
		&& ['id', 'chatId', 'conversationId', 'appVersion', 'model'].every(key => text(key, 512) && (value[key] as string).length > 0)
		&& ['questionMessageId', 'answerMessageId', 'interactionId'].every(key => value[key] === undefined || (text(key, 512) && (value[key] as string).length > 0))
		&& ['question', 'answer'].every(key => text(key, 20_000))
		&& text('prompt', maximumQuickRunInputCharacters)
		&& (value.contextJson === undefined || text('contextJson', maximumQuickRunInputCharacters))
		&& Number.isSafeInteger(value.createdAt) && (value.createdAt as number) >= 0
		&& Number.isSafeInteger(value.updatedAt) && (value.updatedAt as number) >= (value.createdAt as number)
		&& [10, 20, 50].includes(value.contextCount as number)
		&& ['always', 'auto', 'off'].includes(value.browsingMode as string)
		&& quickRunOutcomes.includes(value.outcome as QuickRunOutcome)
		&& Array.isArray(value.events) && value.events.length > 0 && value.events.length <= maximumQuickRunEvents
		&& value.events.every(event => isRecord(event)
			&& Object.keys(event).length === (event.code === undefined ? 3 : 4)
			&& Number.isSafeInteger(event.at) && (event.at as number) >= (value.createdAt as number) && (event.at as number) <= (value.updatedAt as number)
			&& quickRunStages.includes(event.stage as QuickRunStage)
			&& quickEventStatuses.includes(event.status as QuickRunEvent['status'])
			&& (event.code === undefined || quickRunErrorCodes.includes(event.code as QuickRunErrorCode)));
}

export function formatQuickRunDiagnostics(run: Readonly<AiQuickRun>): string {
	if (!isAiQuickRun(run)) {
		throw new TypeError('Invalid quick-run diagnostics');
	}

	return [
		'Caprine quick-mode execution (redacted)',
		`Outcome: ${run.outcome}`,
		`Context window: ${run.contextCount}`,
		`Web search: ${run.browsingMode}`,
		`Original message observed: ${Boolean(run.questionMessageId)}`,
		`Answer message observed: ${Boolean(run.answerMessageId)}`,
		'UI observation does not prove delivery to the recipient.',
		...run.events.map(event => `+${event.at - run.createdAt}ms ${event.stage}: ${event.status}${event.code ? ` (${event.code})` : ''}`),
	].join('\n');
}
