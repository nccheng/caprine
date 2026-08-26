import {ConversationSnapshot} from './ai-assist-state';
import {AiHistoryInteraction} from './ai-history-store';
import {ContextReviewSnapshot, restoreContextReviewSnapshot} from './context-review';

export type AiHistoryOriginalReplayAvailability =
	| {available: true}
	| {available: false; reason: 'missing-artifacts' | 'unsupported-metadata'};

type HistoryChatBinding = {
	chatId: string;
	conversationId: string;
	sessionId: string;
};

export function captureHistoryDestinationChatId(
	historyChat: Readonly<HistoryChatBinding> | undefined,
	snapshot: Readonly<ConversationSnapshot>,
): string | undefined {
	return historyChat?.conversationId === snapshot.conversationId
		&& historyChat.sessionId === snapshot.sessionId
		? historyChat.chatId
		: undefined;
}

export function originalHistoryReplayAvailability(
	interaction: Readonly<AiHistoryInteraction>,
	currentModel: string,
): AiHistoryOriginalReplayAvailability {
	if (interaction.provider !== 'openai' || interaction.model !== currentModel) {
		return {available: false, reason: 'unsupported-metadata'};
	}

	const videoSourceMessageId = interaction.videoArtifact?.sourceMessageId;
	const unavailableAttachments = interaction.context.items.some(({item}) =>
		(item.attachments ?? []).some(attachment =>
			attachment.kind !== 'video' || item.messageId !== videoSourceMessageId));
	if ((interaction.artifactReferences?.length ?? 0) > 0 || unavailableAttachments) {
		return {available: false, reason: 'missing-artifacts'};
	}

	return {available: true};
}

export function restoreOriginalHistoryReview(
	interaction: Readonly<AiHistoryInteraction>,
	snapshot: Readonly<ConversationSnapshot>,
): Readonly<ContextReviewSnapshot> {
	return restoreContextReviewSnapshot({
		...interaction.context,
		images: [],
		newMessagesAvailable: false,
		snapshot,
	});
}
