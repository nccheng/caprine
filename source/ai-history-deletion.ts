import {randomUUID} from 'node:crypto';
import {ConversationSnapshot} from './ai-assist-state';

export type AiHistoryDeletionScope = 'all' | 'chat' | 'conversation';

export type AiHistoryDeletionConfirmation = {
	authorizationToken: string;
	confirmLabel: string;
	message: string;
	scope: AiHistoryDeletionScope;
	title: string;
};

export type AiHistoryDeletionTarget =
	| {
		chatId: string;
		scope: 'chat';
		snapshot: Readonly<ConversationSnapshot>;
	}
	| {
		scope: 'conversation';
		snapshot: Readonly<ConversationSnapshot>;
	}
	| {scope: 'all'};

type IssueDetails = Omit<AiHistoryDeletionConfirmation, 'authorizationToken' | 'scope'>;

export type AiHistoryDeletionDecision =
	| {status: 'authorized'; target: Readonly<AiHistoryDeletionTarget>}
	| {status: 'rejected'};

function snapshotMatches(
	expected: Readonly<ConversationSnapshot>,
	current: Readonly<ConversationSnapshot> | undefined,
): boolean {
	return current !== undefined
		&& current.captureGeneration === expected.captureGeneration
		&& current.conversationId === expected.conversationId
		&& current.messengerWebContentsId === expected.messengerWebContentsId
		&& current.sessionId === expected.sessionId;
}

export class AiHistoryDeletionAuthorizationState {
	private pending?: {
		confirmation: Readonly<AiHistoryDeletionConfirmation>;
		target: Readonly<AiHistoryDeletionTarget>;
	};

	constructor(private readonly generateToken = (): string => `history-deletion-token:${randomUUID()}`) {}

	get confirmation(): Readonly<AiHistoryDeletionConfirmation> | undefined {
		return this.pending?.confirmation;
	}

	issue(target: Readonly<AiHistoryDeletionTarget>, details: Readonly<IssueDetails>): void {
		const detachedTarget = structuredClone(target);
		if (detachedTarget.scope !== 'all') {
			Object.freeze(detachedTarget.snapshot);
		}

		this.pending = {
			confirmation: Object.freeze({
				authorizationToken: this.generateToken(),
				confirmLabel: details.confirmLabel,
				message: details.message,
				scope: target.scope,
				title: details.title,
			}),
			target: Object.freeze(detachedTarget),
		};
	}

	cancel(authorizationToken: string): boolean {
		if (this.pending?.confirmation.authorizationToken !== authorizationToken) {
			return false;
		}

		this.pending = undefined;
		return true;
	}

	consume(
		authorizationToken: string,
		currentSnapshot: Readonly<ConversationSnapshot> | undefined,
	): AiHistoryDeletionDecision {
		if (this.pending?.confirmation.authorizationToken !== authorizationToken) {
			return {status: 'rejected'};
		}

		const {target} = this.pending;
		this.pending = undefined;
		if (target.scope !== 'all' && !snapshotMatches(target.snapshot, currentSnapshot)) {
			return {status: 'rejected'};
		}

		return {status: 'authorized', target};
	}

	invalidate(): void {
		this.pending = undefined;
	}
}
