import {ConversationSnapshot} from './ai-assist-state';

export const draftInsertionFailureReasons = [
	'attachment-present',
	'composer-ambiguous',
	'composer-changed',
	'composer-not-editable',
	'conversation-changed',
	'draft-present',
	'focus-failed',
	'partial-insertion',
	'stale-authorization',
] as const;

export type DraftInsertionFailureReason = typeof draftInsertionFailureReasons[number];

export type DraftInsertionAuthorizationView = {
	answerGeneration: number;
	authorizationToken: string;
	conversationId: string;
};

export type DraftInsertionAuthorization = DraftInsertionAuthorizationView & {
	snapshot: Readonly<ConversationSnapshot>;
	text: string;
};

export type DraftInsertionAuthorizationInput = DraftInsertionAuthorizationView;

type ComposerResolution<Composer> =
	| {status: 'ambiguous' | 'unavailable'}
	| {composer: Composer; status: 'unique'};

export type DraftInsertionAdapter<Composer> = {
	currentConversationId: () => string | undefined;
	focus: (composer: Composer) => boolean;
	hasPendingAttachment: (composer: Composer) => boolean;
	insertText: (composer: Composer, text: string) => Promise<void> | void;
	isAuthorized: () => boolean | Promise<boolean>;
	isEditable: (composer: Composer) => boolean;
	readText: (composer: Composer) => string;
	resolveComposer: () => ComposerResolution<Composer>;
	settle: () => Promise<void>;
};

export type DraftInsertionResult =
	| {status: 'inserted'}
	| {reason: DraftInsertionFailureReason; status: 'blocked'};

export const draftInsertionTimeoutResult: DraftInsertionResult = {
	reason: 'partial-insertion',
	status: 'blocked',
};

export class InsertedDraftProvenanceState<Composer> {
	private provenance?: {composer: Composer; conversationId: string; text: string};

	invalidate(): void {
		this.provenance = undefined;
	}

	mark(composer: Composer, conversationId: string, text: string): void {
		this.provenance = {composer, conversationId, text};
	}

	matches(composer: Composer, conversationId: string | undefined, text: string): boolean {
		return this.provenance?.composer === composer
			&& this.provenance.conversationId === conversationId
			&& this.provenance.text === text;
	}

	owns(composer: Composer): boolean {
		return this.provenance?.composer === composer;
	}

	consume(composer: Composer, conversationId: string | undefined, text: string): boolean {
		const matches = this.matches(composer, conversationId, text);
		this.invalidate();
		return matches;
	}
}

function sameSnapshot(
	left: Readonly<ConversationSnapshot>,
	right: Readonly<ConversationSnapshot> | undefined,
): boolean {
	return Boolean(right)
		&& left.captureGeneration === right!.captureGeneration
		&& left.conversationId === right!.conversationId
		&& left.messengerWebContentsId === right!.messengerWebContentsId
		&& left.sessionId === right!.sessionId;
}

export class DraftInsertionAuthorizationState {
	private authorization?: DraftInsertionAuthorization;

	invalidate(): void {
		this.authorization = undefined;
	}

	issue(authorization: DraftInsertionAuthorization): Readonly<DraftInsertionAuthorizationView> {
		this.authorization = {
			...authorization,
			snapshot: {...authorization.snapshot},
		};
		return this.read(authorization.snapshot)!;
	}

	read(currentSnapshot: Readonly<ConversationSnapshot> | undefined): Readonly<DraftInsertionAuthorizationView> | undefined {
		if (!this.authorization || !sameSnapshot(this.authorization.snapshot, currentSnapshot)) {
			return;
		}

		const {answerGeneration, authorizationToken, conversationId} = this.authorization;
		return {answerGeneration, authorizationToken, conversationId};
	}

	consume(
		input: Readonly<DraftInsertionAuthorizationInput>,
		currentSnapshot: Readonly<ConversationSnapshot> | undefined,
	): Readonly<DraftInsertionAuthorization> | undefined {
		const {authorization} = this;
		if (!authorization || !sameSnapshot(authorization.snapshot, currentSnapshot)) {
			this.authorization = undefined;
			return;
		}

		if (
			input.answerGeneration !== authorization.answerGeneration
			|| input.authorizationToken !== authorization.authorizationToken
			|| input.conversationId !== authorization.conversationId
		) {
			return;
		}

		this.authorization = undefined;
		return {
			...authorization,
			snapshot: {...authorization.snapshot},
		};
	}
}

function resolvedComposer<Composer>(
	resolution: ComposerResolution<Composer>,
): {composer?: Composer; failure?: DraftInsertionFailureReason} {
	if ('composer' in resolution) {
		return {composer: resolution.composer};
	}

	return {
		failure: resolution.status === 'ambiguous'
			? 'composer-ambiguous'
			: 'composer-not-editable',
	};
}

function preflightComposer<Composer>(
	composer: Composer,
	adapter: DraftInsertionAdapter<Composer>,
): DraftInsertionFailureReason | undefined {
	if (!adapter.isEditable(composer)) {
		return 'composer-not-editable';
	}

	if (adapter.readText(composer) !== '') {
		return 'draft-present';
	}

	if (adapter.hasPendingAttachment(composer)) {
		return 'attachment-present';
	}

	return undefined;
}

export async function executeDraftInsertion<Composer>(
	conversationId: string,
	text: string,
	adapter: DraftInsertionAdapter<Composer>,
): Promise<DraftInsertionResult> {
	if (!await adapter.isAuthorized()) {
		return {reason: 'stale-authorization', status: 'blocked'};
	}

	if (adapter.currentConversationId() !== conversationId) {
		return {reason: 'conversation-changed', status: 'blocked'};
	}

	const initialResolution = adapter.resolveComposer();
	const {composer: initialComposer, failure: initialResolutionFailure} = resolvedComposer(initialResolution);
	if (initialResolutionFailure) {
		return {reason: initialResolutionFailure, status: 'blocked'};
	}

	if (initialComposer === undefined) {
		return {reason: 'composer-not-editable', status: 'blocked'};
	}

	const initialFailure = preflightComposer(initialComposer, adapter);
	if (initialFailure) {
		return {reason: initialFailure, status: 'blocked'};
	}

	if (!adapter.focus(initialComposer)) {
		return {reason: 'focus-failed', status: 'blocked'};
	}

	await adapter.settle();
	if (!await adapter.isAuthorized()) {
		return {reason: 'stale-authorization', status: 'blocked'};
	}

	if (adapter.currentConversationId() !== conversationId) {
		return {reason: 'conversation-changed', status: 'blocked'};
	}

	const focusedResolution = adapter.resolveComposer();
	const {composer: focusedComposer, failure: focusedResolutionFailure} = resolvedComposer(focusedResolution);
	if (focusedResolutionFailure) {
		return {reason: focusedResolutionFailure, status: 'blocked'};
	}

	if (focusedComposer === undefined) {
		return {reason: 'composer-not-editable', status: 'blocked'};
	}

	if (focusedComposer !== initialComposer) {
		return {reason: 'composer-changed', status: 'blocked'};
	}

	const focusedFailure = preflightComposer(focusedComposer, adapter);
	if (focusedFailure) {
		return {reason: focusedFailure, status: 'blocked'};
	}

	try {
		await adapter.insertText(focusedComposer, text);
	} catch {
		return {reason: 'partial-insertion', status: 'blocked'};
	}

	await adapter.settle();
	if (!await adapter.isAuthorized()) {
		return {reason: 'partial-insertion', status: 'blocked'};
	}

	if (adapter.currentConversationId() !== conversationId) {
		return {reason: 'partial-insertion', status: 'blocked'};
	}

	const verifiedResolution = adapter.resolveComposer();
	const {composer: verifiedComposer, failure: verifiedResolutionFailure} = resolvedComposer(verifiedResolution);
	if (verifiedResolutionFailure) {
		return {reason: 'partial-insertion', status: 'blocked'};
	}

	if (verifiedComposer === undefined) {
		return {reason: 'partial-insertion', status: 'blocked'};
	}

	if (verifiedComposer !== initialComposer) {
		return {reason: 'partial-insertion', status: 'blocked'};
	}

	if (!adapter.isEditable(verifiedComposer) || adapter.readText(verifiedComposer) !== text) {
		return {reason: 'partial-insertion', status: 'blocked'};
	}

	if (!adapter.focus(verifiedComposer)) {
		return {reason: 'partial-insertion', status: 'blocked'};
	}

	return {status: 'inserted'};
}
