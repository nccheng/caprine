export const aiSessionInvalidationReasons = [
	'ai-disabled',
	'conversation-unavailable',
	'messenger-reloaded',
	'conversation-changed',
	'panel-closed',
	'panel-failed',
] as const;

export type AiSessionInvalidationReason = typeof aiSessionInvalidationReasons[number];

export type AiSessionStatus = 'closed' | 'open' | 'requesting' | 'cancelled' | 'invalidated';

export type AiSessionState = {
	generation: number;
	sessionId?: string;
	status: AiSessionStatus;
	invalidationReason?: AiSessionInvalidationReason;
};

export type ConversationBindingState = {
	captureGeneration: number;
	displayName?: string;
	status: 'changed' | 'ready' | 'unavailable';
};

export type ConversationSnapshot = {
	captureGeneration: number;
	conversationId: string;
	messengerWebContentsId: number;
	sessionId: string;
};

export class AiConversationBinding {
	private captureGeneration = 0;
	private conversationId?: string;
	private displayName?: string;
	private hasBoundSession = false;
	private snapshot?: ConversationSnapshot;
	private status: ConversationBindingState['status'] = 'unavailable';

	get panelState(): Readonly<ConversationBindingState> {
		const state: ConversationBindingState = {
			captureGeneration: this.captureGeneration,
			status: this.status,
		};
		if (this.displayName) {
			state.displayName = this.displayName;
		}

		return state;
	}

	get currentSnapshot(): Readonly<ConversationSnapshot> | undefined {
		return this.snapshot ? {...this.snapshot} : undefined;
	}

	reportAvailable(conversationId: string, displayName?: string): boolean {
		if (this.conversationId === conversationId) {
			this.displayName = displayName;
			return false;
		}

		const shouldInvalidate = this.hasBoundSession;
		this.captureGeneration += 1;
		this.conversationId = conversationId;
		this.displayName = displayName;
		this.snapshot = undefined;
		this.status = shouldInvalidate ? 'changed' : 'unavailable';
		return shouldInvalidate;
	}

	reportUnavailable(): boolean {
		const shouldInvalidate = this.hasBoundSession;
		if (
			this.conversationId !== undefined
			|| this.snapshot !== undefined
			|| this.status !== 'unavailable'
		) {
			this.captureGeneration += 1;
		}

		this.conversationId = undefined;
		this.displayName = undefined;
		this.snapshot = undefined;
		this.status = 'unavailable';
		return shouldInvalidate;
	}

	bind(sessionId: string, messengerWebContentsId: number): Readonly<ConversationSnapshot> | undefined {
		if (!this.conversationId) {
			return;
		}

		this.captureGeneration += 1;
		this.hasBoundSession = true;
		this.status = 'ready';
		this.snapshot = {
			captureGeneration: this.captureGeneration,
			conversationId: this.conversationId,
			messengerWebContentsId,
			sessionId,
		};
		return this.currentSnapshot;
	}

	invalidate(): void {
		this.captureGeneration += 1;
		this.snapshot = undefined;
		this.status = this.hasBoundSession ? 'changed' : 'unavailable';
	}

	close(): void {
		this.captureGeneration += 1;
		this.hasBoundSession = false;
		this.snapshot = undefined;
		this.status = 'unavailable';
	}

	isCurrent(snapshot: Readonly<ConversationSnapshot> | undefined): boolean {
		return Boolean(snapshot)
			&& this.status === 'ready'
			&& this.conversationId === snapshot!.conversationId
			&& this.captureGeneration === snapshot!.captureGeneration;
	}
}

export class AiAssistSessionStateMachine {
	private state: AiSessionState = {
		generation: 0,
		status: 'closed',
	};

	get snapshot(): Readonly<AiSessionState> {
		return {...this.state};
	}

	open(): Readonly<AiSessionState> {
		const generation = this.state.generation + 1;
		this.state = {
			generation,
			sessionId: `ai-session-${generation}`,
			status: 'open',
		};
		return this.snapshot;
	}

	beginRequest(): Readonly<AiSessionState> {
		if (this.state.status === 'open' || this.state.status === 'cancelled') {
			this.state = {...this.state, status: 'requesting'};
		}

		return this.snapshot;
	}

	completeRequest(): Readonly<AiSessionState> {
		if (this.state.status === 'requesting') {
			this.state = {...this.state, status: 'open'};
		}

		return this.snapshot;
	}

	cancel(): Readonly<AiSessionState> {
		if (this.state.status === 'open' || this.state.status === 'requesting') {
			this.state = {...this.state, status: 'cancelled'};
		}

		return this.snapshot;
	}

	invalidate(reason: AiSessionInvalidationReason): Readonly<AiSessionState> {
		if (this.state.status !== 'closed') {
			this.state = {
				...this.state,
				status: 'invalidated',
				invalidationReason: reason,
			};
		}

		return this.snapshot;
	}

	close(): Readonly<AiSessionState> {
		this.state = {
			generation: this.state.generation,
			status: 'closed',
		};
		return this.snapshot;
	}
}
