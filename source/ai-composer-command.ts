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

export type AiComposerProtectedEvent = {
	preventDefault: () => void;
	stopImmediatePropagation: () => void;
};

export type AiComposerEventSignals<Node, Composer> = {
	activeElement: Node | undefined;
	armedComposer: Composer | undefined;
	composedPath: readonly Node[];
	target: Node | undefined;
};

export type AiComposerEventResolution<Composer> = Readonly<{
	blockedArmedFallback: boolean;
	composer: Composer | undefined;
}>;

export type AiComposerConsumeActions = {
	clear: () => void;
	isCurrent: () => boolean;
	openPanel: (prompt: string) => Promise<boolean>;
	restore: (draftText: string) => void;
};

export type AiComposerConsumeOutcome = 'accepted' | 'restored' | 'stale';
export type AiComposerEventRouteOutcome = 'ignored' | 'protected-consumed' | 'protected-stale';

export type AiComposerEventRouteOptions<Composer> = {
	blockedArmedFallback: boolean;
	composer: Composer | undefined;
	composingComposer: Composer | undefined;
	consume: (snapshot: Readonly<AiComposerCommandSnapshot<Composer>>) => void;
	invalidate: () => void;
	isCurrent: (snapshot: Readonly<AiComposerCommandSnapshot<Composer>>) => boolean;
	snapshot: Readonly<AiComposerCommandSnapshot<Composer>> | undefined;
};

export type AiComposerBrowserEvent<Node> = AiComposerProtectedEvent & {
	composedPath: () => readonly Node[];
	target: Node | null; // eslint-disable-line @typescript-eslint/ban-types
};

export type AiComposerBrowserRouteOptions<Node, Composer> = Omit<
AiComposerEventRouteOptions<Composer>,
'blockedArmedFallback' | 'composer'
> & {
	activeElement: Node | undefined;
	blocksArmedFallback: (node: Node | undefined) => boolean;
	commandFromComposer: (composer: Composer) => Readonly<AiComposerCommand> | undefined;
	composerFromNode: (node: Node | undefined) => Composer | undefined;
};

export type AiComposerBrowserSendRouteOptions<Node, Composer> = AiComposerBrowserRouteOptions<Node, Composer> & {
	fallbackComposer: Composer | undefined;
	isSendControl: (node: Node | undefined, composer: Composer) => boolean;
};

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

export function resolveAiComposerFromEventSignals<Node, Composer>(
	signals: Readonly<AiComposerEventSignals<Node, Composer>>,
	composerFromNode: (node: Node | undefined) => Composer | undefined,
	blocksArmedFallback: (node: Node | undefined) => boolean,
): AiComposerEventResolution<Composer> {
	const candidates = [
		signals.target,
		...signals.composedPath,
		signals.activeElement,
	];
	for (const candidate of candidates) {
		const composer = composerFromNode(candidate);
		if (composer !== undefined) {
			return {blockedArmedFallback: false, composer};
		}
	}

	const blockedArmedFallback = candidates.some(candidate => blocksArmedFallback(candidate));
	return {
		blockedArmedFallback,
		composer: blockedArmedFallback ? undefined : signals.armedComposer,
	};
}

export function routeArmedAiComposerEnter<Composer>(
	event: Readonly<AiComposerEnterEvent> & AiComposerProtectedEvent,
	options: Readonly<AiComposerEventRouteOptions<Composer>>,
): AiComposerEventRouteOutcome {
	const {
		blockedArmedFallback,
		composer,
		composingComposer,
		consume,
		invalidate,
		isCurrent,
		snapshot,
	} = options;
	if (!isNormalAiComposerEnter(event) || !snapshot || composingComposer === snapshot.composer) {
		return 'ignored';
	}

	event.preventDefault();
	event.stopImmediatePropagation();
	if (blockedArmedFallback || (composer !== undefined && composer !== snapshot.composer) || !isCurrent(snapshot)) {
		invalidate();
		return 'protected-stale';
	}

	consume(snapshot);
	return 'protected-consumed';
}

export function routeArmedAiComposerSend<Composer>(
	event: AiComposerProtectedEvent,
	isSendControl: boolean,
	options: Readonly<AiComposerEventRouteOptions<Composer>>,
): AiComposerEventRouteOutcome {
	const {
		blockedArmedFallback,
		composer,
		composingComposer,
		consume,
		invalidate,
		isCurrent,
		snapshot,
	} = options;
	if (!isSendControl || !snapshot || composingComposer === snapshot.composer) {
		return 'ignored';
	}

	event.preventDefault();
	event.stopImmediatePropagation();
	if (blockedArmedFallback || (composer !== undefined && composer !== snapshot.composer) || !isCurrent(snapshot)) {
		invalidate();
		return 'protected-stale';
	}

	consume(snapshot);
	return 'protected-consumed';
}

export function isNormalAiComposerEnter(event: Readonly<AiComposerEnterEvent>): boolean {
	return event.key === 'Enter'
		&& !event.shiftKey
		&& !event.isComposing
		&& event.keyCode !== 229;
}

export function isAiComposerSendControlDescription(value: string): boolean {
	return /\b(send|enter)\b/i.test(value);
}

export function isAiComposerSendControlEvent<Node>(
	target: Node | undefined,
	composedPath: readonly Node[],
	isSendControl: (node: Node | undefined) => boolean,
): boolean {
	return [target, ...composedPath].some(candidate => isSendControl(candidate));
}

export function routeAiComposerBrowserEnter<Node, Composer>(
	event: Readonly<AiComposerEnterEvent> & AiComposerBrowserEvent<Node>,
	options: Readonly<AiComposerBrowserRouteOptions<Node, Composer>>,
): AiComposerEventRouteOutcome {
	const resolution = resolveAiComposerFromEventSignals({
		activeElement: options.activeElement,
		armedComposer: options.snapshot?.composer,
		composedPath: event.composedPath(),
		target: event.target ?? undefined,
	}, options.composerFromNode, options.blocksArmedFallback);
	const outcome = routeArmedAiComposerEnter(event, {
		...options,
		blockedArmedFallback: resolution.blockedArmedFallback,
		composer: resolution.composer,
	});
	if (outcome !== 'ignored') {
		return outcome;
	}

	if (options.snapshot && options.composingComposer === options.snapshot.composer) {
		return 'ignored';
	}

	const command = resolution.composer === undefined
		? undefined
		: options.commandFromComposer(resolution.composer);
	if (!shouldInterceptAiComposerEnter(event, command)) {
		return 'ignored';
	}

	event.preventDefault();
	event.stopImmediatePropagation();
	return 'protected-stale';
}

export function routeAiComposerBrowserSend<Node, Composer>(
	event: AiComposerBrowserEvent<Node>,
	options: Readonly<AiComposerBrowserSendRouteOptions<Node, Composer>>,
): AiComposerEventRouteOutcome {
	const resolution = resolveAiComposerFromEventSignals({
		activeElement: options.activeElement,
		armedComposer: options.snapshot?.composer,
		composedPath: event.composedPath(),
		target: event.target ?? undefined,
	}, options.composerFromNode, options.blocksArmedFallback);
	const composer = resolution.composer ?? options.fallbackComposer;
	const protectedComposer = options.snapshot?.composer ?? composer;
	const isSendControl = protectedComposer === undefined
		? false
		: isAiComposerSendControlEvent(
			event.target ?? undefined,
			event.composedPath(),
			candidate => options.isSendControl(candidate, protectedComposer),
		);
	const outcome = routeArmedAiComposerSend(event, isSendControl, {
		...options,
		blockedArmedFallback: resolution.blockedArmedFallback && !isSendControl,
		composer,
	});
	if (outcome !== 'ignored' || composer === undefined) {
		return outcome;
	}

	if (options.snapshot && options.composingComposer === options.snapshot.composer) {
		return 'ignored';
	}

	const command = options.commandFromComposer(composer);
	if (!shouldInterceptAiComposerSend(isSendControl, command)) {
		return 'ignored';
	}

	event.preventDefault();
	event.stopImmediatePropagation();
	return 'protected-stale';
}

export function shouldInterceptAiComposerEnter(
	event: Readonly<AiComposerEnterEvent>,
	command: Readonly<AiComposerCommand> | undefined,
): boolean {
	return command !== undefined
		&& isNormalAiComposerEnter(event);
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
