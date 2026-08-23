export type AiComposerCommand = {
	draftText: string;
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

const maximumComposerPromptLength = 20_000;

function normalizedDraftText(value: string): string {
	return value
		.replaceAll('\u00A0', ' ')
		.replaceAll('\r\n', '\n')
		.replaceAll('\r', '\n')
		.replaceAll(/[\u200B-\u200D\uFEFF]/g, '');
}

export function parseAiComposerCommand(value: string): AiComposerCommand | undefined {
	const draftText = normalizedDraftText(value);
	if (draftText === '/ai') {
		return {draftText, prompt: ''};
	}

	if (!draftText.startsWith('/ai ')) {
		return;
	}

	const prompt = draftText.slice(4);
	return prompt.length <= maximumComposerPromptLength
		? {draftText, prompt}
		: undefined;
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
