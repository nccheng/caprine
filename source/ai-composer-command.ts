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
	compositionActive: boolean;
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
	armCurrent: (composer: Composer) => Readonly<AiComposerCommandSnapshot<Composer>> | undefined;
	blocksArmedFallback: (node: Node | undefined) => boolean;
	commandFromComposer: (composer: Composer) => Readonly<AiComposerCommand> | undefined;
	composerFromNode: (node: Node | undefined) => Composer | undefined;
	fallbackComposer: Composer | undefined;
};

export type AiComposerBrowserSendRouteOptions<Composer> = Omit<AiComposerEventRouteOptions<Composer>, 'blockedArmedFallback' | 'composer'> & {
	armCurrent: (composer: Composer) => Readonly<AiComposerCommandSnapshot<Composer>> | undefined;
	commandFromComposer: (composer: Composer) => Readonly<AiComposerCommand> | undefined;
	liveComposer: Composer | undefined;
	ownership: 'ambiguous' | 'unique' | 'unresolved';
	protectEvent: boolean;
};

export type AiComposerBrowserArmOptions<Node, Composer> = {
	activeElement: Node | undefined;
	armedComposer: Composer | undefined;
	armCurrent: (composer: Composer) => Readonly<AiComposerCommandSnapshot<Composer>> | undefined;
	blocksArmedFallback: (node: Node | undefined) => boolean;
	composerFromNode: (node: Node | undefined) => Composer | undefined;
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

export class AiComposerCompositionState<Composer> {
	private activeComposer: Composer | undefined;

	start(composer: Composer): void {
		this.activeComposer = composer;
	}

	finish(): Composer | undefined {
		const composer = this.activeComposer;
		this.activeComposer = undefined;
		return composer;
	}

	current(): Composer | undefined {
		return this.activeComposer;
	}

	isActive(): boolean {
		return this.activeComposer !== undefined;
	}
}

export class AiComposerSendGestureGuard<Control> {
	private protectedControl: Control | undefined;

	arm(control: Control): void {
		this.protectedControl = control;
	}

	clear(): void {
		this.protectedControl = undefined;
	}

	protectsClick(control: Control | undefined): boolean {
		const protects = control !== undefined && control === this.protectedControl;
		this.clear();
		return protects;
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
		compositionActive,
		consume,
		invalidate,
		isCurrent,
		snapshot,
	} = options;
	if (!isNormalAiComposerEnter(event) || !snapshot || compositionActive) {
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
		compositionActive,
		consume,
		invalidate,
		isCurrent,
		snapshot,
	} = options;
	if (!isSendControl || !snapshot) {
		return 'ignored';
	}

	event.preventDefault();
	event.stopImmediatePropagation();
	if (compositionActive) {
		return 'protected-stale';
	}

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

export function isAiComposerCompositionConfirmation(
	event: Readonly<AiComposerEnterEvent>,
	compositionActive: boolean,
): boolean {
	return event.isComposing || event.keyCode === 229 || compositionActive;
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

export function armAiComposerFromBrowserEvent<Node, Composer>(
	event: AiComposerBrowserEvent<Node>,
	options: Readonly<AiComposerBrowserArmOptions<Node, Composer>>,
): Readonly<AiComposerCommandSnapshot<Composer>> | undefined {
	const resolution = resolveAiComposerFromEventSignals({
		activeElement: options.activeElement,
		armedComposer: options.armedComposer,
		composedPath: event.composedPath(),
		target: event.target ?? undefined,
	}, options.composerFromNode, options.blocksArmedFallback);
	return resolution.composer === undefined
		? undefined
		: options.armCurrent(resolution.composer);
}

function freshArmAndConsumeAiComposer<Composer>(
	event: AiComposerProtectedEvent,
	outcome: AiComposerEventRouteOutcome,
	composer: Composer,
	options: Readonly<Pick<AiComposerEventRouteOptions<Composer>, 'consume' | 'invalidate' | 'isCurrent'> & {
		armCurrent: (composer: Composer) => Readonly<AiComposerCommandSnapshot<Composer>> | undefined;
	}>,
): AiComposerEventRouteOutcome {
	if (outcome === 'ignored') {
		event.preventDefault();
		event.stopImmediatePropagation();
	}

	const snapshot = options.armCurrent(composer);
	if (!snapshot || !options.isCurrent(snapshot)) {
		if (snapshot !== undefined || outcome === 'ignored') {
			options.invalidate();
		}

		return 'protected-stale';
	}

	options.consume(snapshot);
	return 'protected-consumed';
}

export function routeAiComposerBrowserEnter<Node, Composer>(
	event: Readonly<AiComposerEnterEvent> & AiComposerBrowserEvent<Node>,
	options: Readonly<AiComposerBrowserRouteOptions<Node, Composer>>,
): AiComposerEventRouteOutcome {
	if (event.key !== 'Enter' || event.shiftKey) {
		return 'ignored';
	}

	const isCompositionConfirmation = isAiComposerCompositionConfirmation(event, options.compositionActive);
	const resolution = resolveAiComposerFromEventSignals({
		activeElement: options.activeElement,
		armedComposer: undefined,
		composedPath: event.composedPath(),
		target: event.target ?? undefined,
	}, options.composerFromNode, options.blocksArmedFallback);
	const liveComposer = resolution.composer
		?? (resolution.blockedArmedFallback ? undefined : options.fallbackComposer);
	if (liveComposer === undefined) {
		if (!isCompositionConfirmation && options.snapshot && !resolution.blockedArmedFallback) {
			event.preventDefault();
			event.stopImmediatePropagation();
			options.invalidate();
			return 'protected-stale';
		}

		return 'ignored';
	}

	const composer = liveComposer as Composer;
	if (options.commandFromComposer(composer) === undefined) {
		if (
			options.snapshot
			&& (composer !== options.snapshot.composer || !options.isCurrent(options.snapshot))
		) {
			options.invalidate();
		}

		return 'ignored';
	}

	if (isCompositionConfirmation) {
		event.stopImmediatePropagation();
		return 'protected-stale';
	}

	if (!isNormalAiComposerEnter(event)) {
		return 'ignored';
	}

	const outcome = routeArmedAiComposerEnter(event, {
		...options,
		blockedArmedFallback: false,
		composer,
	});
	if (outcome === 'protected-consumed') {
		return outcome;
	}

	if (outcome === 'protected-stale' && options.snapshot?.composer === composer) {
		return outcome;
	}

	return freshArmAndConsumeAiComposer(event, outcome, composer, options);
}

export function routeAiComposerBrowserSend<Composer>(
	event: AiComposerProtectedEvent,
	options: Readonly<AiComposerBrowserSendRouteOptions<Composer>>,
): AiComposerEventRouteOutcome {
	const {liveComposer, ownership} = options;
	if (ownership !== 'unique' || liveComposer === undefined) {
		if (ownership === 'ambiguous' && options.snapshot) {
			options.invalidate();
		}

		if (options.protectEvent) {
			event.preventDefault();
			event.stopImmediatePropagation();
			return 'protected-stale';
		}

		return 'ignored';
	}

	const composer = liveComposer as Composer;
	const command = options.commandFromComposer(composer);
	if (command === undefined) {
		if (
			options.snapshot
			&& (composer !== options.snapshot.composer || !options.isCurrent(options.snapshot))
		) {
			options.invalidate();
		}

		return 'ignored';
	}

	const outcome = routeArmedAiComposerSend(event, true, {
		...options,
		blockedArmedFallback: false,
		composer,
	});
	if (outcome === 'protected-consumed') {
		return outcome;
	}

	if (options.compositionActive) {
		if (outcome === 'ignored') {
			event.preventDefault();
			event.stopImmediatePropagation();
		}

		return 'protected-stale';
	}

	if (outcome === 'protected-stale' && options.snapshot?.composer === composer) {
		return outcome;
	}

	return freshArmAndConsumeAiComposer(event, outcome, composer, options);
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
