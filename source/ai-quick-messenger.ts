import {QuickRunErrorCode} from './ai-quick-run';
import {caprineAiSharedAnswerCharacterLimit} from './share-text-protocol';

export type QuickMessengerAction = {
	runId: string;
	token: string;
	conversationId: string;
	phase: 'question' | 'answer';
	text: string;
	replyToMessageId?: string;
};

export type QuickMessengerResult =
	| {status: 'observed'; messageId: string}
	| {status: 'blocked' | 'uncertain'; code: QuickRunErrorCode};

export type QuickMessengerAdapter<Composer> = {
	currentConversationId: () => string | undefined;
	isCurrent: () => boolean;
	resolveComposer: () => Composer | undefined;
	isEditable: (composer: Composer) => boolean;
	readText: (composer: Composer) => string;
	hasAttachment: (composer: Composer) => boolean;
	hasReply: (composer: Composer) => boolean;
	prepareReply: (messageId: string, composer: Composer) => Promise<boolean>;
	replyMatches: (messageId: string, composer: Composer) => boolean;
	insertText: (composer: Composer, text: string) => void;
	canSend: (composer: Composer) => boolean;
	// Main persists the attempted stage before issuing one-use permission.
	authorizeSend: () => Promise<boolean>;
	send: (composer: Composer) => void;
	messageIds: () => Set<string>;
	observe: (before: ReadonlySet<string>, text: string, replyTo?: string) => string[];
	settle: () => Promise<void>;
};

export async function executeQuickMessengerAction<Composer>(
	action: Readonly<QuickMessengerAction>,
	adapter: QuickMessengerAdapter<Composer>,
): Promise<QuickMessengerResult> {
	let attempted = false;
	const blocked = (code: QuickRunErrorCode): QuickMessengerResult => ({code, status: attempted ? 'uncertain' : 'blocked'});
	const composer = adapter.resolveComposer();
	if (!composer) {
		return blocked('composer-changed');
	}

	const guard = (expected: string): QuickRunErrorCode | undefined => {
		if (!adapter.isCurrent() || adapter.currentConversationId() !== action.conversationId) {
			return 'conversation-changed';
		}

		if (adapter.resolveComposer() !== composer || !adapter.isEditable(composer)) {
			return 'composer-changed';
		}

		if (adapter.readText(composer) !== expected) {
			return 'draft-present';
		}

		if (adapter.hasAttachment(composer)) {
			return 'attachment-present';
		}

		return undefined;
	};

	try {
		const initialFailure = guard('');
		if (initialFailure) {
			return blocked(initialFailure);
		}

		if (adapter.hasReply(composer)) {
			return blocked('quote-present');
		}

		if (action.phase === 'answer' && (!action.replyToMessageId || !await adapter.prepareReply(action.replyToMessageId, composer))) {
			return blocked('quote-unavailable');
		}

		const quoteMatches = () => action.phase === 'answer'
			? Boolean(action.replyToMessageId && adapter.replyMatches(action.replyToMessageId, composer))
			: !adapter.hasReply(composer);
		const preparedFailure = guard('');
		if (preparedFailure !== undefined || !quoteMatches()) {
			return blocked(preparedFailure ?? 'quote-mismatch');
		}

		adapter.insertText(composer, action.text);
		await adapter.settle();
		const insertionFailure = guard(action.text);
		if (insertionFailure !== undefined || !quoteMatches()) {
			return blocked(insertionFailure ?? 'quote-mismatch');
		}

		if (!adapter.canSend(composer)) {
			return blocked('send-control-unavailable');
		}

		const before = adapter.messageIds();
		if (!await adapter.authorizeSend()) {
			return blocked('stale-authorization');
		}

		const finalFailure = guard(action.text);
		if (finalFailure !== undefined || !quoteMatches() || !adapter.canSend(composer)) {
			return blocked(finalFailure ?? 'quote-mismatch');
		}

		attempted = true;
		adapter.send(composer);
		for (let attempt = 0; attempt < 30; attempt += 1) {
			// eslint-disable-next-line no-await-in-loop
			await adapter.settle();
			if (!adapter.isCurrent() || adapter.currentConversationId() !== action.conversationId) {
				return blocked('conversation-changed');
			}

			const matches = adapter.observe(before, action.text, action.replyToMessageId);
			if (matches.length > 1) {
				return blocked('message-ambiguous');
			}

			if (matches.length === 1 && adapter.resolveComposer() === composer && adapter.readText(composer) === '' && !adapter.hasReply(composer)) {
				return {messageId: matches[0], status: 'observed'};
			}
		}

		return blocked('send-result-unknown');
	} catch {
		return blocked(attempted ? 'send-result-unknown' : 'composer-changed');
	}
}

export function isQuickMessengerAction(value: unknown): value is QuickMessengerAction {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return false;
	}

	const action = value as Record<string, unknown>;
	const keys = ['runId', 'token', 'conversationId', 'phase', 'text', ...(action.replyToMessageId === undefined ? [] : ['replyToMessageId'])];
	return Object.keys(action).length === keys.length && keys.every(key => Object.hasOwn(action, key))
		&& ['runId', 'token', 'conversationId'].every(key => typeof action[key] === 'string' && (action[key] as string).length > 0 && (action[key] as string).length <= 512)
		&& typeof action.text === 'string' && action.text.length > 0 && action.text.length <= (action.phase === 'answer' ? caprineAiSharedAnswerCharacterLimit : 20_000)
		&& (action.phase === 'question' ? action.replyToMessageId === undefined
			: action.phase === 'answer' && typeof action.replyToMessageId === 'string' && /^[^\s\p{C}]{1,200}$/u.test(action.replyToMessageId));
}
