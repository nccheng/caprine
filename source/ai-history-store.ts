import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {ContextWindowSize, ReviewedContextItem} from './context-review';
import {OpenAiUrlCitation, OpenAiWebSource, WebSearchMode} from './openai-client';

export const aiHistorySchemaVersion = 2;

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

export class AiHistoryStore {
	private readonly database: DatabaseSync;
	private readonly failAt?: AiHistoryStoreOptions['failAt'];
	private readonly generateId: () => string;
	private readonly now: () => number;

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
			interactions: (loadInteractions.all(chat.id) as InteractionRow[]).map(row => ({
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
			})),
		}));
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
					OR LOWER(i.web_search_sources_json) LIKE ? ESCAPE '\\'
				)
		`).all(conversationId, pattern, pattern, pattern) as Array<{chat_id: string}>).map(row => row.chat_id));

		return this.loadConversation(conversationId).filter(chat => matchingChatIds.has(chat.id));
	}

	deleteChat(conversationId: string, chatId: string): boolean {
		requireIdentifier(conversationId, 'conversationId');
		requireIdentifier(chatId, 'chatId');
		return this.database.prepare(`
			DELETE FROM ai_history_chats
			WHERE id = ? AND conversation_id = ?
		`).run(chatId, conversationId).changes === 1;
	}

	clearConversation(conversationId: string): number {
		requireIdentifier(conversationId, 'conversationId');
		return Number(this.database.prepare(`
			DELETE FROM ai_history_chats WHERE conversation_id = ?
		`).run(conversationId).changes);
	}

	clearAll(): number {
		return Number(this.database.prepare('DELETE FROM ai_history_chats').run().changes);
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
		return interactionId;
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
	}

	private migrate(): void {
		const version = Number((this.database.prepare('PRAGMA user_version').get() as {user_version: number}).user_version);
		if (version > aiHistorySchemaVersion) {
			throw new Error(`AI history database schema ${version} is newer than supported schema ${aiHistorySchemaVersion}`);
		}

		for (let nextVersion = version + 1; nextVersion <= aiHistorySchemaVersion; nextVersion += 1) {
			this.database.exec('BEGIN IMMEDIATE');
			try {
				if (nextVersion === 1) {
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
				} else if (nextVersion === 2) {
					this.database.exec('ALTER TABLE ai_history_interactions ADD COLUMN artifact_references_json TEXT NOT NULL DEFAULT \'[]\'');
					this.database.exec('ALTER TABLE ai_history_interactions ADD COLUMN outcome TEXT NOT NULL DEFAULT \'completed\' CHECK (outcome = \'completed\')');
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
