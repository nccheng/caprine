import {AiHistoryChat, AiHistoryInteraction} from './ai-history-store';

export const maximumHistoryChats = 100;
export const maximumHistoryInteractionsPerChat = 100;

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
	question: string;
	shareStatus: 'private' | 'shared';
	webSearchRan: boolean;
};

export type AiHistoryChatView = {
	badges: AiHistoryBadge[];
	contextCount: number;
	createdAt: number;
	id: string;
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
	return {
		answer: boundedText(interaction.answer),
		artifacts: (interaction.artifactReferences ?? []).slice(0, 100).map(({id, kind}) => ({id, kind})),
		browsingMode: interaction.browsingMode,
		citations: interaction.webSearch.sources.slice(0, 100).map(source => ({
			title: boundedText(source.title ?? source.url, 500),
			url: boundedText(source.url, 2048),
		})),
		completedAt: interaction.completedAt,
		context: contextExcerpt(interaction),
		draftStatus: interaction.draftStatus,
		id: interaction.id,
		model: boundedText(interaction.model, 200),
		question: boundedText(interaction.question),
		shareStatus: interaction.shareStatus,
		webSearchRan: interaction.webSearch.ran,
	};
}

function chatBadges(chat: AiHistoryChat): AiHistoryBadge[] {
	const badges = new Set<AiHistoryBadge>();
	for (const interaction of chat.interactions) {
		if (interaction.webSearch.ran) {
			badges.add('Web');
		}

		for (const {item} of interaction.context.items) {
			for (const attachment of item.attachments ?? []) {
				const badge: Record<typeof attachment.kind, AiHistoryBadge> = {
					audio: 'Audio',
					image: 'Image',
					video: 'Video',
				};
				badges.add(badge[attachment.kind]);
			}
		}
	}

	return [...badges];
}

export function buildAiHistoryChatViews(chats: AiHistoryChat[]): AiHistoryChatView[] {
	return chats.slice(-maximumHistoryChats).reverse().map(chat => {
		const interactions = chat.interactions.slice(-maximumHistoryInteractionsPerChat).map(interaction => interactionView(interaction));
		const first = chat.interactions[0];
		const last = chat.interactions.at(-1);
		return {
			badges: chatBadges(chat),
			contextCount: chat.interactions.reduce((total, interaction) => total + interaction.context.items.length, 0),
			createdAt: chat.createdAt,
			id: chat.id,
			interactions,
			lastActivityAt: last?.completedAt ?? chat.createdAt,
			preview: boundedText(last?.answer ?? 'No answers yet.', 240),
			title: boundedText(first?.question ?? 'New AI chat', 120),
		};
	});
}
