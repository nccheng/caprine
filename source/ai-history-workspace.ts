import {
	AiHistoryChat,
	AiHistoryChatSummary,
	AiHistoryInteraction,
} from './ai-history-store';
import {originalHistoryReplayAvailability} from './ai-history-replay';
import {openAiResponseModel} from './openai-client';
import {maximumHistoryReviewedTranscriptCharacters} from './reviewed-transcripts';
import {AiQuickRun} from './ai-quick-run';

export const maximumHistoryChats = 100;
export const maximumHistoryInteractionsPerChat = 25;
export const maximumHistoryTranscriptDtoCharacters = maximumHistoryReviewedTranscriptCharacters;

export type AiHistoryBadge = 'Audio' | 'Image' | 'Video' | 'Web';

export type AiHistoryContextItemView = {
	excerpt: string;
	id: string;
	metadata: string;
};

export type AiHistoryInteractionView = {
	answer: string;
	artifacts: Array<{id: string; kind: 'keyframe' | 'timeline' | 'transcript'}>;
	browsingMode: 'always' | 'auto' | 'off';
	citations: Array<{title: string; url: string}>;
	completedAt: number;
	context: AiHistoryContextItemView[];
	draftStatus: 'inserted' | 'not-inserted';
	id: string;
	model: string;
	originalReplay: {available: true} | {available: false; reason: 'missing-artifacts' | 'unsupported-metadata'};
	question: string;
	reviewedTranscripts?: Array<{
		durationSeconds: number;
		editedSegments?: Array<{endSeconds: number; startSeconds: number; text: string}>;
		id: string;
		kind: 'audio' | 'video';
		originalSegments: Array<{endSeconds: number; startSeconds: number; text: string}>;
		senderLabel: string;
		status: 'included' | 'removed';
	}>;
	shareStatus: 'private' | 'shared';
	videoArtifact?: {
		coverage: 'balanced' | 'sparse';
		durationSeconds: number;
		focusedFrameCount: number;
		keyframes: Array<{dataUrl: string; timestampSeconds: number}>;
		sampledFrameCount: number;
		timeline: Array<{
			description: string;
			endSeconds: number;
			startSeconds: number;
			timestamps: number[];
		}>;
		transcript: Array<{endSeconds: number; startSeconds: number; text: string}>;
		uncertaintyNotes: string[];
	};
	webSearchRan: boolean;
};

export type AiHistoryChatView = {
	quickRuns?: AiQuickRun[];
	badges: AiHistoryBadge[];
	contextCount: number;
	createdAt: number;
	id: string;
	interactionCount: number;
	interactions: AiHistoryInteractionView[];
	lastActivityAt: number;
	preview: string;
	title: string;
};

function boundedText(value: string, maximumLength = 20_000): string {
	return value.slice(0, maximumLength);
}

function contextExcerpt(interaction: AiHistoryInteraction): AiHistoryContextItemView[] {
	return interaction.context.items.slice(0, 50).map(({editedExcerpt, id, item}) => {
		const parts: string[] = [];
		if (item.text) {
			parts.push(item.text);
		}

		if (item.reply) {
			parts.push(`Reply${item.reply.quotedSender ? ` to ${item.reply.quotedSender}` : ''}: ${item.reply.text}`);
		}

		if (item.reactions) {
			parts.push(`Reactions: ${item.reactions.map(reaction => `${reaction.emoji} ${reaction.count}`).join(', ')}`);
		}

		if (item.linkPreview) {
			parts.push(`Link: ${item.linkPreview.title ?? item.linkPreview.domain} (${item.linkPreview.url})`);
		}

		if (item.attachments) {
			parts.push(`Attachments: ${item.attachments.map(attachment => attachment.kind).join(', ')}`);
		}

		return {
			excerpt: boundedText(editedExcerpt ?? (item.omittedReason ? `Omitted: ${item.omittedReason}` : parts.join('\n'))),
			id,
			metadata: boundedText([
				item.timestamp,
				item.sender.displayName ?? item.sender.role,
				item.omittedReason,
			].filter(Boolean).join(' · '), 500),
		};
	});
}

function interactionView(interaction: AiHistoryInteraction): AiHistoryInteractionView {
	const reviewedTranscriptCharacters = (interaction.reviewedTranscripts ?? [])
		.flatMap(transcript => [...transcript.originalSegments, ...(transcript.editedSegments ?? [])])
		.reduce((total, segment) => total + segment.text.length, 0);
	if (reviewedTranscriptCharacters > maximumHistoryTranscriptDtoCharacters) {
		throw new TypeError('reviewed transcript history exceeds the renderer text limit');
	}

	const citations = new Map<string, {title: string; url: string}>();
	for (const citation of interaction.webSearch.citations) {
		citations.set(citation.url, {
			title: boundedText(citation.title ?? citation.url, 500),
			url: boundedText(citation.url, 2048),
		});
	}

	for (const source of interaction.webSearch.sources) {
		citations.set(source.url, {
			title: boundedText(source.title ?? source.url, 500),
			url: boundedText(source.url, 2048),
		});
	}

	return {
		answer: boundedText(interaction.answer),
		artifacts: (interaction.artifactReferences ?? []).slice(0, 100).map(({id, kind}) => ({id, kind})),
		browsingMode: interaction.browsingMode,
		citations: [...citations.values()].slice(0, 100),
		completedAt: interaction.completedAt,
		context: contextExcerpt(interaction),
		draftStatus: interaction.draftStatus,
		id: interaction.id,
		model: boundedText(interaction.model, 200),
		originalReplay: originalHistoryReplayAvailability(interaction, openAiResponseModel),
		question: boundedText(interaction.question),
		...(interaction.reviewedTranscripts?.length ? {
			reviewedTranscripts: interaction.reviewedTranscripts.map(transcript => ({
				durationSeconds: transcript.durationSeconds,
				...(transcript.editedSegments ? {
					editedSegments: transcript.editedSegments.map(segment => ({...segment, text: boundedText(segment.text)})),
				} : {}),
				id: boundedText(transcript.id, 512),
				kind: transcript.kind,
				originalSegments: transcript.originalSegments.map(segment => ({...segment, text: boundedText(segment.text)})),
				senderLabel: boundedText(transcript.senderLabel, 200),
				status: transcript.status,
			})),
		} : {}),
		shareStatus: interaction.shareStatus,
		...(interaction.videoArtifact ? {
			videoArtifact: {
				coverage: interaction.videoArtifact.coverage,
				durationSeconds: interaction.videoArtifact.durationSeconds,
				focusedFrameCount: interaction.videoArtifact.focusedFrameCount,
				keyframes: interaction.videoArtifact.keyframes.map(keyframe => ({
					dataUrl: `data:image/jpeg;base64,${Buffer.from(keyframe.bytes).toString('base64')}`,
					timestampSeconds: keyframe.timestampSeconds,
				})),
				sampledFrameCount: interaction.videoArtifact.sampledFrameCount,
				timeline: interaction.videoArtifact.timeline.map(event => ({...event, timestamps: [...event.timestamps]})),
				transcript: interaction.videoArtifact.transcript.status === 'completed'
					? interaction.videoArtifact.transcript.segments.map(segment => ({...segment}))
					: [],
				uncertaintyNotes: [...interaction.videoArtifact.uncertaintyNotes],
			},
		} : {}),
		webSearchRan: interaction.webSearch.ran,
	};
}

export function buildAiHistoryChatViews(
	summaries: AiHistoryChatSummary[],
	selectedChat?: AiHistoryChat,
): AiHistoryChatView[] {
	return summaries.slice(0, maximumHistoryChats).map(summary => {
		const interactions = summary.id === selectedChat?.id
			? selectedChat.interactions.slice(-maximumHistoryInteractionsPerChat).map(interaction => interactionView(interaction))
			: [];
		return {
			badges: summary.badges,
			contextCount: summary.contextCount,
			createdAt: summary.createdAt,
			id: summary.id,
			interactionCount: summary.interactionCount,
			interactions,
			lastActivityAt: summary.lastActivityAt,
			preview: boundedText(summary.preview, 240),
			title: boundedText(summary.title, 120),
		};
	});
}
