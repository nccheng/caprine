export type AiComposerCommand = {
	draftText: string;
	error?: 'prompt-too-long';
	prompt: string;
};

export type AiComposerEnterEvent = {
	isComposing: boolean;
	key: string;
	keyCode?: number;
	shiftKey: boolean;
};

export type AiComposerConsumeActions = {
	clear: () => void;
	isCurrent: () => boolean;
	openPanel: (prompt: string) => Promise<boolean>;
	restore: (draftText: string) => void;
};

export type AiComposerConsumeOutcome = 'accepted' | 'restored' | 'stale';

export type AiComposerCommandSnapshot<Composer> = Readonly<{
	command: Readonly<AiComposerCommand>;
	composer: Composer;
	conversationId: string;
	generation: number;
}>;

export type AiComposerCommandSnapshotState<Composer> = Readonly<{
	composer: Composer;
	conversationId: string | undefined;
	draftText: string;
	isConnected: boolean;
}>;

const maximumComposerPromptLength = 20_000;

function normalizedDraftText(value: string): string {
	return value
		.replaceAll('\u00A0', ' ')
		.replaceAll('\r\n', '\n')
		.replaceAll('\r', '\n')
		.replaceAll(/[\u200B-\u200D\uFEFF]/g, '');
}

export function parseAiComposerCommand(value: string): AiComposerCommand | undefined {
	const normalized = normalizedDraftText(value);
	if (normalized === '/ai') {
		return {draftText: value, prompt: ''};
	}

	if (!normalized.startsWith('/ai ')) {
		return;
	}

	const prompt = normalized.slice(4);
	return {
		draftText: value,
		...(prompt.length > maximumComposerPromptLength ? {error: 'prompt-too-long' as const} : {}),
		prompt,
	};
}

export class AiComposerCommandState<Composer> {
	private armed: AiComposerCommandSnapshot<Composer> | undefined;
	private generation = 0;

	arm(
		composer: Composer,
		draftText: string,
		conversationId: string | undefined,
	): AiComposerCommandSnapshot<Composer> | undefined {
		const command = parseAiComposerCommand(draftText);
		if (!command || !conversationId) {
			this.invalidate();
			return;
		}

		this.generation += 1;
		this.armed = {
			command,
			composer,
			conversationId,
			generation: this.generation,
		};
		return this.armed;
	}

	current(): AiComposerCommandSnapshot<Composer> | undefined {
		return this.armed;
	}

	invalidate(): void {
		this.armed = undefined;
		this.generation += 1;
	}

	matches(
		snapshot: Readonly<AiComposerCommandSnapshot<Composer>>,
		state: Readonly<AiComposerCommandSnapshotState<Composer>>,
	): boolean {
		return this.armed === snapshot
			&& snapshot.generation === this.generation
			&& state.isConnected
			&& state.composer === snapshot.composer
			&& state.draftText === snapshot.command.draftText
			&& state.conversationId === snapshot.conversationId;
	}
}

export function shouldInterceptAiComposerEnter(
	event: Readonly<AiComposerEnterEvent>,
	command: Readonly<AiComposerCommand> | undefined,
): boolean {
	return command !== undefined
		&& event.key === 'Enter'
		&& !event.shiftKey
		&& !event.isComposing
		&& event.keyCode !== 229;
}

export function shouldInterceptAiComposerSend(
	isSendControl: boolean,
	command: Readonly<AiComposerCommand> | undefined,
): boolean {
	return isSendControl && command !== undefined;
}

export async function consumeAiComposerCommand(
	command: Readonly<AiComposerCommand>,
	actions: Readonly<AiComposerConsumeActions>,
): Promise<AiComposerConsumeOutcome> {
	await Promise.resolve();
	if (!actions.isCurrent()) {
		return 'stale';
	}

	actions.clear();
	try {
		if (await actions.openPanel(command.prompt)) {
			return 'accepted';
		}
	} catch {}

	actions.restore(command.draftText);
	return 'restored';
}
