import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {ContextWindowSize, ReviewedContextItem} from './context-review';
import {
	TranscriptCacheRecord,
	transcriptCacheSchemaVersion,
} from './media-transcription';
import {OpenAiUrlCitation, OpenAiWebSource, WebSearchMode} from './openai-client';

export const aiHistorySchemaVersion = 4;

export const maximumVideoArtifactKeyframes = 12;
export const maximumVideoArtifactKeyframeBytes = 512 * 1024;
export const maximumVideoArtifactTotalKeyframeBytes = 4 * 1024 * 1024;

export type AiHistoryVideoTranscript = {
	status: 'no-audio';
} | {
	segments: Array<{endSeconds: number; startSeconds: number; text: string}>;
	status: 'completed';
};

export type AiHistoryVideoArtifactInput = {
	coverage: 'balanced' | 'sparse';
	durationSeconds: number;
	focusedFrameCount: number;
	keyframes: Array<{
		bytes: Uint8Array;
		mimeType: 'image/jpeg';
		timestampSeconds: number;
	}>;
	mediaSha256: string;
	provider: 'openai';
	model: string;
	sampledFrameCount: number;
	samplingConfiguration: unknown;
	sourceConversationId: string;
	sourceMessageId: string;
	timeline: Array<{
		description: string;
		endSeconds: number;
		startSeconds: number;
		timestamps: number[];
	}>;
	transcript: AiHistoryVideoTranscript;
	uncertaintyNotes: string[];
};

export type AiHistoryVideoArtifact = AiHistoryVideoArtifactInput & {
	id: string;
};

export type AiHistoryArtifactReference = {
	id: string;
	kind: 'keyframe' | 'timeline' | 'transcript';
	path: string;
};

export type AiHistoryReviewedContext = {
	actualCount: number;
	contextVersion: string;
	items: ReviewedContextItem[];
	question: string;
	requestedCount: ContextWindowSize;
};

export type AiHistoryInteractionInput = {
	answer: string;
	artifactReferences?: AiHistoryArtifactReference[];
	browsingMode: WebSearchMode;
	completedAt: number;
	context: AiHistoryReviewedContext;
	model: string;
	outcome: 'completed';
	provider: 'openai';
	question: string;
	requestedAt: number;
	webSearch: {
		citations: OpenAiUrlCitation[];
		ran: boolean;
		sources: OpenAiWebSource[];
	};
	videoArtifact?: AiHistoryVideoArtifactInput;
};

export type AiHistoryInteraction = AiHistoryInteractionInput & {
	draftStatus: 'inserted' | 'not-inserted';
	id: string;
	shareStatus: 'private' | 'shared';
};

export type AiHistoryChat = {
	conversationId: string;
	createdAt: number;
	id: string;
	interactions: AiHistoryInteraction[];
};

export type AiHistoryChatSummary = {
	badges: Array<'Audio' | 'Image' | 'Video' | 'Web'>;
	contextCount: number;
	createdAt: number;
	id: string;
	interactionCount: number;
	lastActivityAt: number;
	preview: string;
	title: string;
};

type AiHistoryStoreOptions = {
	databasePath: string;
	failAt?: (stage: 'after-interaction' | 'after-question-turn') => void;
	generateId?: () => string;
	now?: () => number;
};

type ChatRow = {
	conversation_id: string;
	created_at: number;
	id: string;
};

type InteractionRow = {
	answer: string;
	artifact_references_json: string;
	browsing_mode: WebSearchMode;
	completed_at: number;
	context_json: string;
	draft_status: 'inserted' | 'not-inserted';
	id: string;
	model: string;
	outcome: 'completed';
	provider: 'openai';
	question: string;
	requested_at: number;
	share_status: 'private' | 'shared';
	web_search_citations_json: string;
	web_search_ran: 0 | 1;
	web_search_sources_json: string;
};

type VideoArtifactRow = {
	coverage: 'balanced' | 'sparse';
	created_at: number;
	duration_seconds: number;
	focused_frame_count: number;
	id: string;
	media_sha256: string;
	model: string;
	provider: 'openai';
	sampled_frame_count: number;
	sampling_configuration_json: string;
	source_conversation_id: string;
	source_message_id: string;
	timeline_json: string;
	transcript_json: string;
	uncertainty_notes_json: string;
};

type VideoKeyframeRow = {
	bytes: Uint8Array;
	mime_type: 'image/jpeg';
	timestamp_seconds: number;
};

type SummaryRow = {
	context_count: number;
	created_at: number;
	has_audio: 0 | 1;
	has_image: 0 | 1;
	has_video: 0 | 1;
	has_web: 0 | 1;
	id: string;
	interaction_count: number;
	last_activity_at: number;
	preview: string;
	title: string;
};

type TranscriptCacheRow = {
	model: string;
	schema_version: number;
	segments_json: string;
};

function parseJson<T>(value: string): T {
	return JSON.parse(value) as T;
}

function requireText(value: string, name: string, maximumLength = 20_000): string {
	if (value.length === 0 || value.length > maximumLength) {
		throw new TypeError(`${name} must contain between 1 and ${maximumLength} characters`);
	}

	return value;
}

function requireIdentifier(value: string, name: string): string {
	return requireText(value, name, 512);
}

function requireMediaSha256(value: string): string {
	if (!/^[\da-f]{64}$/.test(value)) {
		throw new TypeError('mediaSha256 must be a lowercase SHA-256 digest');
	}

	return value;
}

function interactionFromRow(row: InteractionRow): AiHistoryInteraction {
	return {
		answer: row.answer,
		artifactReferences: parseJson<AiHistoryArtifactReference[]>(row.artifact_references_json),
		browsingMode: row.browsing_mode,
		completedAt: row.completed_at,
		context: parseJson<AiHistoryReviewedContext>(row.context_json),
		draftStatus: row.draft_status,
		id: row.id,
		model: row.model,
		outcome: row.outcome,
		provider: row.provider,
		question: row.question,
		requestedAt: row.requested_at,
		shareStatus: row.share_status,
		webSearch: {
			citations: parseJson<OpenAiUrlCitation[]>(row.web_search_citations_json),
			ran: row.web_search_ran === 1,
			sources: parseJson<OpenAiWebSource[]>(row.web_search_sources_json),
		},
	};
}

export class AiHistoryStore {
	private readonly database: DatabaseSync;
	private readonly failAt?: AiHistoryStoreOptions['failAt'];
	private readonly generateId: () => string;
	private readonly now: () => number;
	private transcriptCacheGeneration = 0;

	constructor(options: AiHistoryStoreOptions) {
		this.database = new DatabaseSync(options.databasePath);
		this.failAt = options.failAt;
		this.generateId = options.generateId ?? randomUUID;
		this.now = options.now ?? Date.now;
		this.database.exec('PRAGMA foreign_keys = ON');
		this.migrate();
	}

	close(): void {
		this.database.close();
	}

	createChat(conversationId: string): string {
		requireIdentifier(conversationId, 'conversationId');
		return this.insertChat(conversationId);
	}

	createChatWithCompletedInteraction(
		conversationId: string,
		input: AiHistoryInteractionInput,
	): {chatId: string; interactionId: string} {
		requireIdentifier(conversationId, 'conversationId');
		this.validateInteraction(input);
		return this.transaction(() => {
			const chatId = this.insertChat(conversationId);
			return {
				chatId,
				interactionId: this.insertCompletedInteraction(chatId, input),
			};
		});
	}

	appendCompletedInteraction(chatId: string, input: AiHistoryInteractionInput): string {
		requireIdentifier(chatId, 'chatId');
		this.validateInteraction(input);
		return this.transaction(() => this.insertCompletedInteraction(chatId, input));
	}

	updateShareStatus(
		interactionId: string,
		status: {draftStatus: 'inserted' | 'not-inserted'; shareStatus: 'private' | 'shared'},
	): void {
		requireIdentifier(interactionId, 'interactionId');
		const result = this.database.prepare(`
			UPDATE ai_history_interactions
			SET draft_status = ?, share_status = ?
			WHERE id = ?
		`).run(status.draftStatus, status.shareStatus, interactionId);
		if (result.changes !== 1) {
			throw new Error('AI history interaction was not found');
		}
	}

	loadConversation(conversationId: string): AiHistoryChat[] {
		requireIdentifier(conversationId, 'conversationId');
		const chats = this.database.prepare(`
			SELECT id, conversation_id, created_at
			FROM ai_history_chats
			WHERE conversation_id = ?
			ORDER BY created_at, id
		`).all(conversationId) as ChatRow[];
		const loadInteractions = this.database.prepare(`
			SELECT
				i.id, i.requested_at, i.completed_at, i.context_json, i.provider, i.model,
				i.browsing_mode, i.web_search_ran, i.web_search_citations_json,
				i.web_search_sources_json, i.draft_status, i.share_status,
				i.artifact_references_json, i.outcome,
				MAX(CASE WHEN t.role = 'user' THEN t.content END) AS question,
				MAX(CASE WHEN t.role = 'assistant' THEN t.content END) AS answer
			FROM ai_history_interactions i
			JOIN ai_history_turns t ON t.interaction_id = i.id
			WHERE i.chat_id = ?
			GROUP BY i.id
			ORDER BY i.requested_at, i.id
		`);

		return chats.map(chat => ({
			conversationId: chat.conversation_id,
			createdAt: chat.created_at,
			id: chat.id,
			interactions: (loadInteractions.all(chat.id) as InteractionRow[]).map(row => this.interactionWithVideoArtifact(row)),
		}));
	}

	loadInteraction(conversationId: string, chatId: string, interactionId: string): AiHistoryInteraction | undefined {
		requireIdentifier(conversationId, 'conversationId');
		requireIdentifier(chatId, 'chatId');
		requireIdentifier(interactionId, 'interactionId');
		const row = this.database.prepare(`
			SELECT
				i.id, i.requested_at, i.completed_at, i.context_json, i.provider, i.model,
				i.browsing_mode, i.web_search_ran, i.web_search_citations_json,
				i.web_search_sources_json, i.draft_status, i.share_status,
				i.artifact_references_json, i.outcome,
				MAX(CASE WHEN t.role = 'user' THEN t.content END) AS question,
				MAX(CASE WHEN t.role = 'assistant' THEN t.content END) AS answer
			FROM ai_history_interactions i
			JOIN ai_history_chats c ON c.id = i.chat_id
			JOIN ai_history_turns t ON t.interaction_id = i.id
			WHERE c.conversation_id = ? AND c.id = ? AND i.id = ?
			GROUP BY i.id
		`).get(conversationId, chatId, interactionId) as InteractionRow | undefined;
		return row ? this.interactionWithVideoArtifact(row) : undefined;
	}

	loadConversationSummaries(conversationId: string, query = ''): AiHistoryChatSummary[] {
		requireIdentifier(conversationId, 'conversationId');
		if (query.length > 200) {
			throw new TypeError('query must contain at most 200 characters');
		}

		const normalizedQuery = query.trim().toLocaleLowerCase();
		const pattern = `%${normalizedQuery.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
		const rows = this.database.prepare(`
			SELECT
				c.id,
				c.created_at,
				COALESCE(MAX(i.completed_at), c.created_at) AS last_activity_at,
				COALESCE((
					SELECT t.content
					FROM ai_history_interactions first_i
					JOIN ai_history_turns t ON t.interaction_id = first_i.id AND t.role = 'user'
					WHERE first_i.chat_id = c.id
					ORDER BY first_i.requested_at, first_i.id
					LIMIT 1
				), 'New AI chat') AS title,
				COALESCE((
					SELECT t.content
					FROM ai_history_interactions last_i
					JOIN ai_history_turns t ON t.interaction_id = last_i.id AND t.role = 'assistant'
					WHERE last_i.chat_id = c.id
					ORDER BY last_i.completed_at DESC, last_i.id DESC
					LIMIT 1
				), 'No answers yet.') AS preview,
				COALESCE(SUM(json_array_length(json_extract(i.context_json, '$.items'))), 0) AS context_count,
				COUNT(i.id) AS interaction_count,
				COALESCE(MAX(i.web_search_ran), 0) AS has_web,
				COALESCE(MAX(i.context_json LIKE '%"kind":"image"%'), 0) AS has_image,
				COALESCE(MAX(i.context_json LIKE '%"kind":"audio"%'), 0) AS has_audio,
				COALESCE(MAX(i.context_json LIKE '%"kind":"video"%'), 0) AS has_video
			FROM ai_history_chats c
			LEFT JOIN ai_history_interactions i ON i.chat_id = c.id
			WHERE c.conversation_id = ?
				AND (? = '' OR EXISTS (
					SELECT 1
					FROM ai_history_interactions search_i
					JOIN ai_history_turns search_t ON search_t.interaction_id = search_i.id
					WHERE search_i.chat_id = c.id
						AND (
							LOWER(search_t.content) LIKE ? ESCAPE '\\'
							OR LOWER(search_i.context_json) LIKE ? ESCAPE '\\'
							OR LOWER(search_i.web_search_citations_json) LIKE ? ESCAPE '\\'
							OR LOWER(search_i.web_search_sources_json) LIKE ? ESCAPE '\\'
							OR EXISTS (
								SELECT 1
								FROM ai_history_interaction_video_artifacts video_r
								JOIN ai_video_analysis_artifacts video_a ON video_a.id = video_r.artifact_id
								WHERE video_r.interaction_id = search_i.id
									AND (
										LOWER(video_a.transcript_json) LIKE ? ESCAPE '\\'
										OR LOWER(video_r.timeline_json) LIKE ? ESCAPE '\\'
									)
							)
						)
				))
			GROUP BY c.id
			ORDER BY last_activity_at DESC, c.created_at DESC, c.id DESC
			LIMIT 100
		`).all(conversationId, normalizedQuery, pattern, pattern, pattern, pattern, pattern, pattern) as SummaryRow[];

		return rows.map(row => ({
			badges: [
				...(row.has_web ? ['Web' as const] : []),
				...(row.has_image ? ['Image' as const] : []),
				...(row.has_audio ? ['Audio' as const] : []),
				...(row.has_video ? ['Video' as const] : []),
			],
			contextCount: row.context_count,
			createdAt: row.created_at,
			id: row.id,
			interactionCount: row.interaction_count,
			lastActivityAt: row.last_activity_at,
			preview: row.preview,
			title: row.title,
		}));
	}

	loadChat(conversationId: string, chatId: string, maximumInteractions = 25): AiHistoryChat | undefined {
		requireIdentifier(conversationId, 'conversationId');
		requireIdentifier(chatId, 'chatId');
		if (!Number.isSafeInteger(maximumInteractions) || maximumInteractions < 1 || maximumInteractions > 100) {
			throw new TypeError('maximumInteractions must be between 1 and 100');
		}

		const chat = this.database.prepare(`
			SELECT id, conversation_id, created_at
			FROM ai_history_chats
			WHERE conversation_id = ? AND id = ?
		`).get(conversationId, chatId) as ChatRow | undefined;
		if (!chat) {
			return;
		}

		const rows = this.database.prepare(`
			SELECT * FROM (
				SELECT
					i.id, i.requested_at, i.completed_at, i.context_json, i.provider, i.model,
					i.browsing_mode, i.web_search_ran, i.web_search_citations_json,
					i.web_search_sources_json, i.draft_status, i.share_status,
					i.artifact_references_json, i.outcome,
					MAX(CASE WHEN t.role = 'user' THEN t.content END) AS question,
					MAX(CASE WHEN t.role = 'assistant' THEN t.content END) AS answer
				FROM ai_history_interactions i
				JOIN ai_history_turns t ON t.interaction_id = i.id
				WHERE i.chat_id = ?
				GROUP BY i.id
				ORDER BY i.requested_at DESC, i.id DESC
				LIMIT ?
			) recent
			ORDER BY requested_at, id
		`).all(chatId, maximumInteractions) as InteractionRow[];

		return {
			conversationId: chat.conversation_id,
			createdAt: chat.created_at,
			id: chat.id,
			interactions: rows.map(row => this.interactionWithVideoArtifact(row)),
		};
	}

	loadVideoArtifactByMediaHash(conversationId: string, mediaSha256: string): AiHistoryVideoArtifact | undefined {
		requireIdentifier(conversationId, 'conversationId');
		requireMediaSha256(mediaSha256);
		const row = this.database.prepare(`
			SELECT a.*, r.focused_frame_count, r.timeline_json, r.uncertainty_notes_json
			FROM ai_video_analysis_artifacts a
			JOIN ai_history_interaction_video_artifacts r ON r.artifact_id = a.id
			JOIN ai_history_interactions i ON i.id = r.interaction_id
			WHERE a.source_conversation_id = ? AND a.media_sha256 = ?
			ORDER BY i.completed_at DESC, i.id DESC
			LIMIT 1
		`).get(conversationId, mediaSha256) as VideoArtifactRow | undefined;
		return row ? this.videoArtifactFromRow(row) : undefined;
	}

	searchConversation(conversationId: string, query: string): AiHistoryChat[] {
		requireIdentifier(conversationId, 'conversationId');
		const normalizedQuery = requireText(query.trim(), 'query', 200).toLocaleLowerCase();
		const pattern = `%${normalizedQuery.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
		const matchingChatIds = new Set((this.database.prepare(`
			SELECT DISTINCT i.chat_id
			FROM ai_history_interactions i
			JOIN ai_history_chats c ON c.id = i.chat_id
			JOIN ai_history_turns t ON t.interaction_id = i.id
			WHERE c.conversation_id = ?
				AND (
					LOWER(t.content) LIKE ? ESCAPE '\\'
					OR LOWER(i.context_json) LIKE ? ESCAPE '\\'
					OR LOWER(i.web_search_citations_json) LIKE ? ESCAPE '\\'
					OR LOWER(i.web_search_sources_json) LIKE ? ESCAPE '\\'
					OR EXISTS (
						SELECT 1
						FROM ai_history_interaction_video_artifacts video_r
						JOIN ai_video_analysis_artifacts video_a ON video_a.id = video_r.artifact_id
						WHERE video_r.interaction_id = i.id
							AND (
								LOWER(video_a.transcript_json) LIKE ? ESCAPE '\\'
								OR LOWER(video_r.timeline_json) LIKE ? ESCAPE '\\'
							)
					)
				)
		`).all(conversationId, pattern, pattern, pattern, pattern, pattern, pattern) as Array<{chat_id: string}>).map(row => row.chat_id));

		return this.loadConversation(conversationId).filter(chat => matchingChatIds.has(chat.id));
	}

	deleteChat(conversationId: string, chatId: string): boolean {
		requireIdentifier(conversationId, 'conversationId');
		requireIdentifier(chatId, 'chatId');
		return this.transaction(() => {
			const deleted = this.database.prepare(`
				DELETE FROM ai_history_chats
				WHERE id = ? AND conversation_id = ?
			`).run(chatId, conversationId).changes === 1;
			this.deleteOrphanedVideoArtifacts();
			return deleted;
		});
	}

	clearConversation(conversationId: string): number {
		requireIdentifier(conversationId, 'conversationId');
		return this.transaction(() => {
			const count = Number(this.database.prepare(`
				DELETE FROM ai_history_chats WHERE conversation_id = ?
			`).run(conversationId).changes);
			this.deleteOrphanedVideoArtifacts();
			return count;
		});
	}

	clearAll(): number {
		const deletedCount = this.transaction(() => {
			const chatCount = Number(this.database.prepare('DELETE FROM ai_history_chats').run().changes);
			const transcriptCount = Number(this.database.prepare('DELETE FROM ai_transcript_cache').run().changes);
			const artifactCount = Number(this.database.prepare('DELETE FROM ai_video_analysis_artifacts').run().changes);
			return chatCount + transcriptCount + artifactCount;
		});
		this.transcriptCacheGeneration += 1;
		return deletedCount;
	}

	getTranscriptCacheGeneration(): number {
		return this.transcriptCacheGeneration;
	}

	loadTranscriptCache(mediaSha256: string): unknown {
		requireMediaSha256(mediaSha256);
		const row = this.database.prepare(`
			SELECT schema_version, model, segments_json
			FROM ai_transcript_cache
			WHERE media_sha256 = ?
		`).get(mediaSha256) as TranscriptCacheRow | undefined;
		if (!row) {
			return;
		}

		return {
			model: row.model,
			schemaVersion: row.schema_version,
			segments: parseJson<unknown>(row.segments_json),
		};
	}

	saveTranscriptCache(mediaSha256: string, record: TranscriptCacheRecord, expectedGeneration: number): void {
		requireMediaSha256(mediaSha256);
		if (expectedGeneration !== this.transcriptCacheGeneration) {
			return;
		}

		this.database.prepare(`
			INSERT OR IGNORE INTO ai_transcript_cache (
				media_sha256, schema_version, model, segments_json
			) VALUES (?, ?, ?, ?)
		`).run(
			mediaSha256,
			record.schemaVersion,
			record.model,
			JSON.stringify(record.segments),
		);
	}

	deleteTranscriptCache(mediaSha256: string): void {
		requireMediaSha256(mediaSha256);
		this.database.prepare('DELETE FROM ai_transcript_cache WHERE media_sha256 = ?').run(mediaSha256);
	}

	private insertChat(conversationId: string): string {
		const id = requireIdentifier(this.generateId(), 'generated chat ID');
		this.database.prepare(`
			INSERT INTO ai_history_chats (id, conversation_id, created_at)
			VALUES (?, ?, ?)
		`).run(id, conversationId, this.now());
		return id;
	}

	private insertCompletedInteraction(chatId: string, input: AiHistoryInteractionInput): string {
		const interactionId = requireIdentifier(this.generateId(), 'generated interaction ID');
		const questionTurnId = requireIdentifier(this.generateId(), 'generated question turn ID');
		const answerTurnId = requireIdentifier(this.generateId(), 'generated answer turn ID');
		this.database.prepare(`
			INSERT INTO ai_history_interactions (
				id, chat_id, requested_at, completed_at, context_json, provider, model,
				browsing_mode, web_search_ran, web_search_citations_json,
				web_search_sources_json, draft_status, share_status, artifact_references_json,
				outcome
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'not-inserted', 'private', ?, 'completed')
		`).run(
			interactionId,
			chatId,
			input.requestedAt,
			input.completedAt,
			JSON.stringify(input.context),
			input.provider,
			input.model,
			input.browsingMode,
			input.webSearch.ran ? 1 : 0,
			JSON.stringify(input.webSearch.citations),
			JSON.stringify(input.webSearch.sources),
			JSON.stringify(input.artifactReferences ?? []),
		);
		this.failAt?.('after-interaction');
		this.database.prepare(`
			INSERT INTO ai_history_turns (id, interaction_id, role, content, created_at)
			VALUES (?, ?, 'user', ?, ?)
		`).run(questionTurnId, interactionId, input.question, input.requestedAt);
		this.failAt?.('after-question-turn');
		this.database.prepare(`
			INSERT INTO ai_history_turns (id, interaction_id, role, content, created_at)
			VALUES (?, ?, 'assistant', ?, ?)
		`).run(answerTurnId, interactionId, input.answer, input.completedAt);
		if (input.videoArtifact) {
			this.upsertVideoArtifact(interactionId, input.videoArtifact);
		}

		return interactionId;
	}

	private interactionWithVideoArtifact(row: InteractionRow): AiHistoryInteraction {
		const interaction = interactionFromRow(row);
		const artifactRow = this.database.prepare(`
			SELECT a.*, r.focused_frame_count, r.timeline_json, r.uncertainty_notes_json
			FROM ai_history_interaction_video_artifacts r
			JOIN ai_video_analysis_artifacts a ON a.id = r.artifact_id
			WHERE r.interaction_id = ?
		`).get(row.id) as VideoArtifactRow | undefined;
		return artifactRow
			? {...interaction, videoArtifact: this.videoArtifactFromRow(artifactRow)}
			: interaction;
	}

	private videoArtifactFromRow(row: VideoArtifactRow): AiHistoryVideoArtifact {
		const keyframes = this.database.prepare(`
			SELECT timestamp_seconds, mime_type, bytes
			FROM ai_video_analysis_keyframes
			WHERE artifact_id = ?
			ORDER BY timestamp_seconds, id
		`).all(row.id) as VideoKeyframeRow[];
		return {
			coverage: row.coverage,
			durationSeconds: row.duration_seconds,
			focusedFrameCount: row.focused_frame_count,
			id: row.id,
			keyframes: keyframes.map(keyframe => ({
				bytes: new Uint8Array(keyframe.bytes),
				mimeType: keyframe.mime_type,
				timestampSeconds: keyframe.timestamp_seconds,
			})),
			mediaSha256: row.media_sha256,
			model: row.model,
			provider: row.provider,
			sampledFrameCount: row.sampled_frame_count,
			samplingConfiguration: parseJson<unknown>(row.sampling_configuration_json),
			sourceConversationId: row.source_conversation_id,
			sourceMessageId: row.source_message_id,
			timeline: parseJson<AiHistoryVideoArtifact['timeline']>(row.timeline_json),
			transcript: parseJson<AiHistoryVideoTranscript>(row.transcript_json),
			uncertaintyNotes: parseJson<string[]>(row.uncertainty_notes_json),
		};
	}

	private upsertVideoArtifact(interactionId: string, artifact: AiHistoryVideoArtifactInput): void {
		this.validateVideoArtifact(artifact);
		const owner = this.database.prepare(`
			SELECT c.conversation_id
			FROM ai_history_interactions i
			JOIN ai_history_chats c ON c.id = i.chat_id
			WHERE i.id = ?
		`).get(interactionId) as {conversation_id: string} | undefined;
		if (owner?.conversation_id !== artifact.sourceConversationId) {
			throw new TypeError('video artifact must belong to the interaction conversation');
		}

		const artifactId = `video:${artifact.sourceConversationId}:${artifact.mediaSha256}`;
		const existing = this.database.prepare(`
			SELECT id FROM ai_video_analysis_artifacts
			WHERE source_conversation_id = ? AND media_sha256 = ?
		`).get(artifact.sourceConversationId, artifact.mediaSha256) as {id: string} | undefined;
		if (!existing) {
			this.database.prepare(`
				INSERT INTO ai_video_analysis_artifacts (
					id, source_conversation_id, source_message_id, media_sha256,
					duration_seconds, coverage, transcript_json, sampled_frame_count,
					sampling_configuration_json, provider, model, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`).run(
				artifactId,
				artifact.sourceConversationId,
				artifact.sourceMessageId,
				artifact.mediaSha256,
				artifact.durationSeconds,
				artifact.coverage,
				JSON.stringify(artifact.transcript),
				artifact.sampledFrameCount,
				JSON.stringify(artifact.samplingConfiguration),
				artifact.provider,
				artifact.model,
				this.now(),
			);
			const insertKeyframe = this.database.prepare(`
				INSERT INTO ai_video_analysis_keyframes (
					id, artifact_id, timestamp_seconds, mime_type, bytes
				) VALUES (?, ?, ?, 'image/jpeg', ?)
			`);
			for (const [index, keyframe] of artifact.keyframes.entries()) {
				insertKeyframe.run(`${artifactId}:keyframe:${index}`, artifactId, keyframe.timestampSeconds, keyframe.bytes);
			}
		}

		this.database.prepare(`
			INSERT INTO ai_history_interaction_video_artifacts (
				interaction_id, artifact_id, focused_frame_count, timeline_json, uncertainty_notes_json
			) VALUES (?, ?, ?, ?, ?)
		`).run(
			interactionId,
			existing?.id ?? artifactId,
			artifact.focusedFrameCount,
			JSON.stringify(artifact.timeline),
			JSON.stringify(artifact.uncertaintyNotes),
		);
	}

	private deleteOrphanedVideoArtifacts(): void {
		this.database.prepare(`
			DELETE FROM ai_video_analysis_artifacts
			WHERE NOT EXISTS (
				SELECT 1 FROM ai_history_interaction_video_artifacts r
				WHERE r.artifact_id = ai_video_analysis_artifacts.id
			)
		`).run();
	}

	private transaction<Result>(operation: () => Result): Result {
		this.database.exec('BEGIN IMMEDIATE');
		try {
			const result = operation();
			this.database.exec('COMMIT');
			return result;
		} catch (error) {
			this.database.exec('ROLLBACK');
			throw error;
		}
	}

	private validateInteraction(input: AiHistoryInteractionInput): void {
		requireText(input.question, 'question');
		requireText(input.answer, 'answer');
		requireText(input.model, 'model', 200);
		if (input.provider !== 'openai') {
			throw new TypeError('provider must be openai');
		}

		if (input.outcome !== 'completed') {
			throw new TypeError('only completed interactions may be stored');
		}

		if (!Number.isSafeInteger(input.requestedAt) || !Number.isSafeInteger(input.completedAt) || input.completedAt < input.requestedAt) {
			throw new TypeError('interaction timestamps are invalid');
		}

		if (input.context.question !== input.question) {
			throw new TypeError('context question must match the interaction question');
		}

		JSON.stringify(input.context);
		JSON.stringify(input.webSearch.citations);
		JSON.stringify(input.webSearch.sources);
		JSON.stringify(input.artifactReferences ?? []);
		if (input.videoArtifact) {
			this.validateVideoArtifact(input.videoArtifact);
		}
	}

	private validateVideoArtifact(artifact: Readonly<AiHistoryVideoArtifactInput>): void {
		requireIdentifier(artifact.sourceConversationId, 'video source conversation ID');
		requireIdentifier(artifact.sourceMessageId, 'video source message ID');
		requireMediaSha256(artifact.mediaSha256);
		requireText(artifact.model, 'video model', 200);
		if (artifact.provider !== 'openai'
			|| !['balanced', 'sparse'].includes(artifact.coverage)
			|| !Number.isFinite(artifact.durationSeconds)
			|| artifact.durationSeconds <= 0
			|| !Number.isSafeInteger(artifact.sampledFrameCount)
			|| artifact.sampledFrameCount < 1
			|| !Number.isSafeInteger(artifact.focusedFrameCount)
			|| artifact.focusedFrameCount < 0
			|| artifact.keyframes.length === 0
			|| artifact.keyframes.length > maximumVideoArtifactKeyframes
			|| artifact.timeline.length > 120
			|| artifact.uncertaintyNotes.length > 60) {
			throw new TypeError('video artifact is invalid or exceeds its durable bounds');
		}

		let totalBytes = 0;
		let previousTimestamp = -1;
		for (const keyframe of artifact.keyframes) {
			totalBytes += keyframe.bytes.byteLength;
			if (!(keyframe.bytes instanceof Uint8Array)
				|| keyframe.mimeType !== 'image/jpeg'
				|| keyframe.bytes.byteLength < 4
				|| keyframe.bytes.byteLength > maximumVideoArtifactKeyframeBytes
				|| keyframe.bytes[0] !== 0xFF
				|| keyframe.bytes[1] !== 0xD8
				|| keyframe.bytes.at(-2) !== 0xFF
				|| keyframe.bytes.at(-1) !== 0xD9
				|| !Number.isFinite(keyframe.timestampSeconds)
				|| keyframe.timestampSeconds <= previousTimestamp
				|| keyframe.timestampSeconds > artifact.durationSeconds) {
				throw new TypeError('video keyframe is invalid or exceeds its durable bounds');
			}

			previousTimestamp = keyframe.timestampSeconds;
		}

		if (totalBytes > maximumVideoArtifactTotalKeyframeBytes) {
			throw new TypeError('video keyframes exceed the durable byte limit');
		}

		if (artifact.transcript.status === 'completed') {
			let transcriptCharacters = 0;
			let previousEnd = 0;
			if (artifact.transcript.segments.length > 1000) {
				throw new TypeError('video transcript exceeds the durable segment limit');
			}

			for (const segment of artifact.transcript.segments) {
				transcriptCharacters += segment.text.length;
				if (!segment.text.trim()
					|| segment.text.length > 20_000
					|| !Number.isFinite(segment.startSeconds)
					|| !Number.isFinite(segment.endSeconds)
					|| segment.startSeconds < previousEnd
					|| segment.endSeconds < segment.startSeconds
					|| segment.endSeconds > artifact.durationSeconds) {
					throw new TypeError('video transcript is invalid or exceeds its durable bounds');
				}

				previousEnd = segment.endSeconds;
			}

			if (transcriptCharacters > 100_000) {
				throw new TypeError('video transcript exceeds the durable text limit');
			}
		}

		for (const event of artifact.timeline) {
			if (!event.description.trim()
				|| event.description.length > 4000
				|| !Number.isFinite(event.startSeconds)
				|| !Number.isFinite(event.endSeconds)
				|| event.startSeconds < 0
				|| event.endSeconds < event.startSeconds
				|| event.endSeconds > artifact.durationSeconds
				|| event.timestamps.length === 0
				|| event.timestamps.length > 20
				|| event.timestamps.some(value => !Number.isFinite(value) || value < 0 || value > artifact.durationSeconds)) {
				throw new TypeError('video timeline is invalid or exceeds its durable bounds');
			}
		}

		if (artifact.uncertaintyNotes.some(note => !note.trim() || note.length > 2000)
			|| JSON.stringify(artifact.samplingConfiguration).length > 20_000) {
			throw new TypeError('video metadata is invalid or exceeds its durable bounds');
		}

		JSON.stringify(artifact.transcript);
		JSON.stringify(artifact.samplingConfiguration);
		JSON.stringify(artifact.timeline);
		JSON.stringify(artifact.uncertaintyNotes);
	}

	private migrate(): void {
		const version = Number((this.database.prepare('PRAGMA user_version').get() as {user_version: number}).user_version);
		if (version > aiHistorySchemaVersion) {
			throw new Error(`AI history database schema ${version} is newer than supported schema ${aiHistorySchemaVersion}`);
		}

		for (let nextVersion = version + 1; nextVersion <= aiHistorySchemaVersion; nextVersion += 1) {
			this.database.exec('BEGIN IMMEDIATE');
			try {
				switch (nextVersion) {
					case 1: {
						this.database.exec(`
						CREATE TABLE ai_history_chats (
							id TEXT PRIMARY KEY,
							conversation_id TEXT NOT NULL,
							created_at INTEGER NOT NULL
						) STRICT;
						CREATE INDEX ai_history_chats_conversation ON ai_history_chats (conversation_id, created_at);
						CREATE TABLE ai_history_interactions (
							id TEXT PRIMARY KEY,
							chat_id TEXT NOT NULL REFERENCES ai_history_chats(id) ON DELETE CASCADE,
							requested_at INTEGER NOT NULL,
							completed_at INTEGER NOT NULL,
							context_json TEXT NOT NULL,
							provider TEXT NOT NULL CHECK (provider = 'openai'),
							model TEXT NOT NULL,
							browsing_mode TEXT NOT NULL CHECK (browsing_mode IN ('always', 'auto', 'off')),
							web_search_ran INTEGER NOT NULL CHECK (web_search_ran IN (0, 1)),
							web_search_citations_json TEXT NOT NULL,
							web_search_sources_json TEXT NOT NULL,
							draft_status TEXT NOT NULL CHECK (draft_status IN ('not-inserted', 'inserted')),
							share_status TEXT NOT NULL CHECK (share_status IN ('private', 'shared'))
						) STRICT;
						CREATE INDEX ai_history_interactions_chat ON ai_history_interactions (chat_id, requested_at);
						CREATE TABLE ai_history_turns (
							id TEXT PRIMARY KEY,
							interaction_id TEXT NOT NULL REFERENCES ai_history_interactions(id) ON DELETE CASCADE,
							role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
							content TEXT NOT NULL,
							created_at INTEGER NOT NULL,
							UNIQUE (interaction_id, role)
						) STRICT;
						`);
						break;
					}

					case 2: {
						this.database.exec('ALTER TABLE ai_history_interactions ADD COLUMN artifact_references_json TEXT NOT NULL DEFAULT \'[]\'');
						this.database.exec('ALTER TABLE ai_history_interactions ADD COLUMN outcome TEXT NOT NULL DEFAULT \'completed\' CHECK (outcome = \'completed\')');
						break;
					}

					case 3: {
						this.database.exec(`
						CREATE TABLE ai_transcript_cache (
							media_sha256 TEXT PRIMARY KEY
								CHECK (length(media_sha256) = 64 AND media_sha256 NOT GLOB '*[^0-9a-f]*'),
							schema_version INTEGER NOT NULL CHECK (schema_version = ${transcriptCacheSchemaVersion}),
							model TEXT NOT NULL CHECK (model = 'whisper-1'),
							segments_json TEXT NOT NULL
						) STRICT;
					`);
						break;
					}

					case 4: {
						this.database.exec(`
							CREATE TABLE ai_video_analysis_artifacts (
								id TEXT PRIMARY KEY,
								source_conversation_id TEXT NOT NULL,
								source_message_id TEXT NOT NULL,
								media_sha256 TEXT NOT NULL
									CHECK (length(media_sha256) = 64 AND media_sha256 NOT GLOB '*[^0-9a-f]*'),
								duration_seconds REAL NOT NULL CHECK (duration_seconds > 0),
								coverage TEXT NOT NULL CHECK (coverage IN ('balanced', 'sparse')),
								transcript_json TEXT NOT NULL,
								sampled_frame_count INTEGER NOT NULL CHECK (sampled_frame_count > 0),
								sampling_configuration_json TEXT NOT NULL,
								provider TEXT NOT NULL CHECK (provider = 'openai'),
								model TEXT NOT NULL,
								created_at INTEGER NOT NULL,
								UNIQUE (source_conversation_id, media_sha256)
							) STRICT;
							CREATE TABLE ai_video_analysis_keyframes (
								id TEXT PRIMARY KEY,
								artifact_id TEXT NOT NULL REFERENCES ai_video_analysis_artifacts(id) ON DELETE CASCADE,
								timestamp_seconds REAL NOT NULL CHECK (timestamp_seconds >= 0),
								mime_type TEXT NOT NULL CHECK (mime_type = 'image/jpeg'),
								bytes BLOB NOT NULL,
								UNIQUE (artifact_id, timestamp_seconds)
							) STRICT;
							CREATE TABLE ai_history_interaction_video_artifacts (
								interaction_id TEXT PRIMARY KEY REFERENCES ai_history_interactions(id) ON DELETE CASCADE,
								artifact_id TEXT NOT NULL REFERENCES ai_video_analysis_artifacts(id) ON DELETE RESTRICT,
								focused_frame_count INTEGER NOT NULL CHECK (focused_frame_count >= 0),
								timeline_json TEXT NOT NULL,
								uncertainty_notes_json TEXT NOT NULL
							) STRICT;
							CREATE INDEX ai_history_video_artifacts_artifact
								ON ai_history_interaction_video_artifacts (artifact_id);
						`);
						break;
					}

					default: {
						throw new Error(`Unsupported AI history migration ${nextVersion}`);
					}
				}

				this.database.exec(`PRAGMA user_version = ${nextVersion}`);
				this.database.exec('COMMIT');
			} catch (error) {
				this.database.exec('ROLLBACK');
				throw error;
			}
		}
	}
}
