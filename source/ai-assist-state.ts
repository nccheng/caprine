export const aiSessionInvalidationReasons = [
	'ai-disabled',
	'messenger-reloaded',
	'conversation-changed',
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
