import {ConversationSnapshot} from './ai-assist-state';
import {AiHistoryInteraction} from './ai-history-store';
import {ContextReviewSnapshot, restoreContextReviewSnapshot} from './context-review';

function restoredReviewedTranscripts(interaction: Readonly<AiHistoryInteraction>) {
	return (interaction.reviewedTranscripts ?? []).map(transcript => ({
		contextItemId: transcript.contextItemId,
		durationSeconds: transcript.durationSeconds,
		...(transcript.editedSegments ? {editedSegments: transcript.editedSegments.map(segment => ({...segment}))} : {}),
		id: transcript.id,
		kind: transcript.kind,
		messageId: transcript.messageId,
		originalSegments: transcript.originalSegments.map(segment => ({...segment})),
		senderLabel: transcript.senderLabel,
		status: transcript.status === 'included' ? 'completed' as const : 'removed' as const,
	}));
}

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

	const availableTranscriptMessageIds = new Set((interaction.reviewedTranscripts ?? []).map(item => item.messageId));
	const videoSourceMessageId = interaction.videoArtifact?.sourceMessageId;
	const unavailableAttachments = interaction.context.items.some(({item}) =>
		(item.attachments ?? []).some(attachment =>
			!item.messageId
			|| !(['audio', 'video'].includes(attachment.kind)
				&& (availableTranscriptMessageIds.has(item.messageId) || item.messageId === videoSourceMessageId))));
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
		transcripts: restoredReviewedTranscripts(interaction),
	});
}
