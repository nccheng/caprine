export type MessengerComposerFocusAdapter<Composer> = {
	currentConversationId: () => string | undefined;
	focus: (composer: Composer) => void;
	isEditable: (composer: Composer) => boolean;
	isFocused: (composer: Composer) => boolean;
	visibleComposers: () => Composer[];
};

export function restoreMessengerComposerFocus<Composer>(
	expectedConversationId: string,
	adapter: MessengerComposerFocusAdapter<Composer>,
): boolean {
	if (adapter.currentConversationId() !== expectedConversationId) {
		return false;
	}

	const composers = adapter.visibleComposers();
	if (composers.length !== 1 || !adapter.isEditable(composers[0])) {
		return false;
	}

	const composer = composers[0];
	adapter.focus(composer);
	return adapter.currentConversationId() === expectedConversationId && adapter.isFocused(composer);
}
