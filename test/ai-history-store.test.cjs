const assert = require('node:assert/strict');
const {mkdtempSync, readFileSync, rmSync} = require('node:fs');
const {tmpdir} = require('node:os');
const path = require('node:path');
const {afterEach, test} = require('node:test');
const {DatabaseSync} = require('node:sqlite');
const {AiHistoryStore, aiHistorySchemaVersion} = require('../dist-js/ai-history-store.js');
const {openAiTranscriptionModel, transcriptCacheSchemaVersion} = require('../dist-js/media-transcription.js');

const temporaryDirectories = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, {force: true, recursive: true});
	}
});

function temporaryDatabasePath() {
	const directory = mkdtempSync(path.join(tmpdir(), 'caprine-ai-history-'));
	temporaryDirectories.push(directory);
	return path.join(directory, 'history.sqlite');
}

function idGenerator() {
	let counter = 0;
	return () => `id-${++counter}`;
}

function interaction(overrides = {}) {
	return {
		answer: 'Use the reviewed answer.',
		artifactReferences: [{id: 'transcript-1', kind: 'transcript', path: 'artifacts/transcript-1.json'}],
		browsingMode: 'auto',
		completedAt: 2000,
		context: {
			actualCount: 2,
			contextVersion: 'context-v1',
			items: [
				{
					editedExcerpt: 'Redacted text',
					id: 'review-1',
					item: {
						confidence: 'high',
						messageId: 'message-1',
						sender: {displayName: 'Pat', role: 'incoming'},
						text: 'Original text',
					},
				},
				{
					id: 'review-2',
					item: {
						confidence: 'low',
						omittedReason: 'ambiguous-message',
						sender: {role: 'unknown'},
					},
				},
			],
			question: 'What should I say?',
			requestedCount: 10,
		},
		model: 'gpt-5.6-luna',
		outcome: 'completed',
		provider: 'openai',
		question: 'What should I say?',
		requestedAt: 1000,
		webSearch: {
			citations: [{
				contentIndex: 0,
				endIndex: 12,
				outputIndex: 1,
				providerEndIndex: 12,
				providerStartIndex: 0,
				startIndex: 0,
				title: 'Example',
				url: 'https://example.com/source',
			}],
			ran: true,
			sources: [{title: 'Example', url: 'https://example.com/source'}],
		},
		...overrides,
	};
}

test('completed interactions round-trip exactly after close and reopen', () => {
	const databasePath = temporaryDatabasePath();
	const store = new AiHistoryStore({databasePath, generateId: idGenerator(), now: () => 500});
	const chatId = store.createChat('thread:123');
	const expected = interaction();
	const interactionId = store.appendCompletedInteraction(chatId, expected);
	store.updateShareStatus(interactionId, {draftStatus: 'inserted', shareStatus: 'private'});
	store.close();

	const reopened = new AiHistoryStore({databasePath});
	assert.deepEqual(reopened.loadConversation('thread:123'), [{
		conversationId: 'thread:123',
		createdAt: 500,
		id: chatId,
		interactions: [{
			...expected,
			draftStatus: 'inserted',
			id: interactionId,
			outcome: 'completed',
			shareStatus: 'private',
		}],
	}]);
	reopened.close();
});

test('stable conversation IDs keep duplicate display names isolated', () => {
	const databasePath = temporaryDatabasePath();
	const store = new AiHistoryStore({databasePath, generateId: idGenerator()});
	const first = store.createChat('thread:alice-1');
	const second = store.createChat('thread:alice-2');
	store.appendCompletedInteraction(first, interaction());
	store.appendCompletedInteraction(second, interaction());
	assert.equal(store.loadConversation('thread:alice-1')[0].conversationId, 'thread:alice-1');
	assert.equal(store.loadConversation('thread:alice-2')[0].conversationId, 'thread:alice-2');
	assert.notEqual(first, second);
	store.close();
});

test('replay lookup is scoped to the exact conversation and appending leaves the original immutable', () => {
	const databasePath = temporaryDatabasePath();
	const store = new AiHistoryStore({databasePath, generateId: idGenerator()});
	const chatId = store.createChat('thread:replay');
	const original = interaction({artifactReferences: []});
	const originalId = store.appendCompletedInteraction(chatId, original);

	assert.deepEqual(store.loadInteraction('thread:replay', chatId, originalId), {
		...original,
		draftStatus: 'not-inserted',
		id: originalId,
		shareStatus: 'private',
	});
	assert.equal(store.loadInteraction('thread:other', chatId, originalId), undefined);
	assert.equal(store.loadInteraction('thread:replay', 'wrong-chat', originalId), undefined);

	const replay = interaction({
		answer: 'New replay answer',
		artifactReferences: [],
		completedAt: 4000,
		requestedAt: 3000,
	});
	const replayId = store.appendCompletedInteraction(chatId, replay);
	const {interactions} = store.loadChat('thread:replay', chatId);
	assert.deepEqual(interactions.map(value => value.id), [originalId, replayId]);
	assert.equal(interactions[0].answer, original.answer);
	assert.equal(interactions[0].shareStatus, 'private');
	store.close();
});

test('conversation search matches turns, frozen context, and source titles without crossing conversation IDs', () => {
	const databasePath = temporaryDatabasePath();
	const store = new AiHistoryStore({databasePath, generateId: idGenerator()});
	const matching = store.createChat('thread:search');
	const other = store.createChat('thread:search');
	const duplicateName = store.createChat('thread:other');
	store.appendCompletedInteraction(matching, interaction({
		answer: 'Answer with a distinctive phrase',
		context: {
			...interaction().context,
			items: [{
				id: 'context-search',
				item: {confidence: 'high', sender: {role: 'incoming'}, text: 'Frozen meeting notes'},
			}],
		},
		webSearch: {
			citations: [{
				contentIndex: 0,
				endIndex: 4,
				outputIndex: 0,
				providerEndIndex: 4,
				providerStartIndex: 0,
				startIndex: 0,
				title: 'Rare citation title',
				url: 'https://example.com/citation',
			}],
			ran: true,
			sources: [],
		},
	}));
	store.appendCompletedInteraction(other, interaction({question: 'Unrelated question', context: {...interaction().context, question: 'Unrelated question'}}));
	store.appendCompletedInteraction(duplicateName, interaction({answer: 'Answer with a distinctive phrase'}));
	assert.deepEqual(store.searchConversation('thread:search', 'distinctive').map(chat => chat.id), [matching]);
	assert.deepEqual(store.searchConversation('thread:search', 'meeting notes').map(chat => chat.id), [matching]);
	assert.deepEqual(store.searchConversation('thread:search', 'rare citation').map(chat => chat.id), [matching]);
	assert.deepEqual(store.searchConversation('thread:search', 'unrelated').map(chat => chat.id), [other]);
	assert.deepEqual(store.searchConversation('thread:search', 'missing'), []);
	store.close();
});

test('workspace summaries are bounded and ordered by latest activity', () => {
	const databasePath = temporaryDatabasePath();
	let now = 1;
	const store = new AiHistoryStore({databasePath, generateId: idGenerator(), now: () => now++});
	const older = store.createChat('thread:activity');
	const newer = store.createChat('thread:activity');
	store.appendCompletedInteraction(newer, interaction({completedAt: 200, requestedAt: 190}));
	store.appendCompletedInteraction(older, interaction({completedAt: 300, requestedAt: 290}));
	const summaries = store.loadConversationSummaries('thread:activity');
	assert.deepEqual(summaries.map(summary => summary.id), [older, newer]);
	assert.equal(summaries[0].lastActivityAt, 300);
	assert.equal(store.loadChat('thread:activity', newer, 1).interactions.length, 1);
	assert.equal(store.loadChat('thread:other', newer, 1), undefined);
	store.close();
});

test('injected transaction failure rolls back the interaction and both turns', () => {
	const databasePath = temporaryDatabasePath();
	const store = new AiHistoryStore({
		databasePath,
		failAt(stage) {
			if (stage === 'after-question-turn') {
				throw new Error('injected failure');
			}
		},
		generateId: idGenerator(),
	});
	const chatId = store.createChat('thread:rollback');
	assert.throws(() => store.appendCompletedInteraction(chatId, interaction()), /injected failure/);
	assert.deepEqual(store.loadConversation('thread:rollback')[0].interactions, []);
	store.close();

	const database = new DatabaseSync(databasePath, {readOnly: true});
	assert.equal(database.prepare('SELECT count(*) AS count FROM ai_history_interactions').get().count, 0);
	assert.equal(database.prepare('SELECT count(*) AS count FROM ai_history_turns').get().count, 0);
	database.close();
});

test('first-interaction failure rolls back its new chat as one atomic unit', () => {
	const databasePath = temporaryDatabasePath();
	const store = new AiHistoryStore({
		databasePath,
		failAt(stage) {
			if (stage === 'after-question-turn') {
				throw new Error('injected first-interaction failure');
			}
		},
		generateId: idGenerator(),
	});
	assert.throws(
		() => store.createChatWithCompletedInteraction('thread:first-failure', interaction()),
		/injected first-interaction failure/,
	);
	assert.deepEqual(store.loadConversation('thread:first-failure'), []);
	store.close();

	const reopened = new AiHistoryStore({databasePath});
	assert.deepEqual(reopened.loadConversation('thread:first-failure'), []);
	reopened.close();
});

test('failed and cancelled outcomes cannot be recorded as completed interactions', () => {
	const databasePath = temporaryDatabasePath();
	const store = new AiHistoryStore({databasePath, generateId: idGenerator()});
	const chatId = store.createChat('thread:outcomes');
	assert.throws(() => store.appendCompletedInteraction(chatId, interaction({outcome: 'failed'})), /only completed/);
	assert.throws(() => store.appendCompletedInteraction(chatId, interaction({outcome: 'cancelled'})), /only completed/);
	assert.deepEqual(store.loadConversation('thread:outcomes')[0].interactions, []);
	store.close();
});

test('delete operations are scoped and cascade only through the selected chat', () => {
	const databasePath = temporaryDatabasePath();
	const store = new AiHistoryStore({databasePath, generateId: idGenerator()});
	const first = store.createChat('thread:first');
	const second = store.createChat('thread:first');
	const other = store.createChat('thread:other');
	store.appendCompletedInteraction(first, interaction());
	store.appendCompletedInteraction(second, interaction());
	store.appendCompletedInteraction(other, interaction());
	assert.equal(store.deleteChat('thread:other', first), false);
	assert.equal(store.deleteChat('thread:first', first), true);
	assert.equal(store.loadConversation('thread:first').length, 1);
	assert.equal(store.clearConversation('thread:first'), 1);
	assert.equal(store.loadConversation('thread:other').length, 1);
	assert.equal(store.clearAll(), 1);
	assert.deepEqual(store.loadConversation('thread:other'), []);
	store.close();
});

test('transcript cache round-trips by SHA-256 and only clear-all removes reusable content', () => {
	const databasePath = temporaryDatabasePath();
	const mediaSha256 = 'ab'.repeat(32);
	const record = {
		model: openAiTranscriptionModel,
		schemaVersion: transcriptCacheSchemaVersion,
		segments: [{endSeconds: 1.5, startSeconds: 0, text: 'Reusable transcript'}],
	};
	const store = new AiHistoryStore({databasePath, generateId: idGenerator()});
	const chatId = store.createChat('thread:cache');
	store.appendCompletedInteraction(chatId, interaction());
	store.saveTranscriptCache(mediaSha256, record);
	assert.deepEqual(store.loadTranscriptCache(mediaSha256), record);
	assert.equal(store.clearConversation('thread:cache'), 1);
	assert.deepEqual(store.loadTranscriptCache(mediaSha256), record);
	store.close();

	const reopened = new AiHistoryStore({databasePath});
	assert.deepEqual(reopened.loadTranscriptCache(mediaSha256), record);
	assert.equal(reopened.clearAll(), 1);
	assert.equal(reopened.loadTranscriptCache(mediaSha256), undefined);
	assert.throws(() => reopened.loadTranscriptCache('not-a-sha'), /lowercase SHA-256/);
	reopened.close();
});

test('database deletion failures preserve the requested and unrelated history', () => {
	const databasePath = temporaryDatabasePath();
	const store = new AiHistoryStore({databasePath, generateId: idGenerator()});
	const selected = store.createChat('thread:selected');
	const unrelated = store.createChat('thread:unrelated');
	store.appendCompletedInteraction(selected, interaction());
	store.appendCompletedInteraction(unrelated, interaction());
	const blocker = new DatabaseSync(databasePath);
	blocker.exec(`
		CREATE TRIGGER reject_history_delete
		BEFORE DELETE ON ai_history_chats
		BEGIN
			SELECT RAISE(ABORT, 'injected delete failure');
		END;
	`);
	blocker.close();

	assert.throws(() => store.deleteChat('thread:selected', selected), /injected delete failure/);
	assert.equal(store.loadConversation('thread:selected').length, 1);
	assert.equal(store.loadConversation('thread:unrelated').length, 1);
	store.close();
});

test('database schema excludes forbidden secret, provider payload, DOM, cookie, and raw-media fields', () => {
	const databasePath = temporaryDatabasePath();
	const store = new AiHistoryStore({databasePath, generateId: idGenerator()});
	const chatId = store.createChat('thread:inspection');
	store.appendCompletedInteraction(chatId, interaction());
	store.saveTranscriptCache('cd'.repeat(32), {
		model: openAiTranscriptionModel,
		schemaVersion: transcriptCacheSchemaVersion,
		segments: [{endSeconds: 1, startSeconds: 0, text: 'Privacy-safe transcript'}],
	});
	store.close();
	const bytes = readFileSync(databasePath, 'utf8');
	for (const forbidden of ['api_key', 'auth_token', 'cookie', 'provider_payload', 'raw_dom', 'raw_audio', 'raw_video']) {
		assert.equal(bytes.includes(forbidden), false, `${forbidden} must not be persisted`);
	}
});

test('version 1 fixture migrates deterministically to the current schema', () => {
	const databasePath = temporaryDatabasePath();
	const fixture = new DatabaseSync(databasePath);
	fixture.exec(`
		PRAGMA foreign_keys = ON;
		CREATE TABLE ai_history_chats (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT;
		CREATE INDEX ai_history_chats_conversation ON ai_history_chats (conversation_id, created_at);
		CREATE TABLE ai_history_interactions (
			id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES ai_history_chats(id) ON DELETE CASCADE,
			requested_at INTEGER NOT NULL, completed_at INTEGER NOT NULL, context_json TEXT NOT NULL,
			provider TEXT NOT NULL CHECK (provider = 'openai'), model TEXT NOT NULL,
			browsing_mode TEXT NOT NULL CHECK (browsing_mode IN ('always', 'auto', 'off')),
			web_search_ran INTEGER NOT NULL CHECK (web_search_ran IN (0, 1)),
			web_search_citations_json TEXT NOT NULL, web_search_sources_json TEXT NOT NULL,
			draft_status TEXT NOT NULL CHECK (draft_status IN ('not-inserted', 'inserted')),
			share_status TEXT NOT NULL CHECK (share_status IN ('private', 'shared'))
		) STRICT;
		CREATE INDEX ai_history_interactions_chat ON ai_history_interactions (chat_id, requested_at);
		CREATE TABLE ai_history_turns (
			id TEXT PRIMARY KEY, interaction_id TEXT NOT NULL REFERENCES ai_history_interactions(id) ON DELETE CASCADE,
			role TEXT NOT NULL CHECK (role IN ('user', 'assistant')), content TEXT NOT NULL,
			created_at INTEGER NOT NULL, UNIQUE (interaction_id, role)
		) STRICT;
		PRAGMA user_version = 1;
	`);
	fixture.close();

	const migrated = new AiHistoryStore({databasePath});
	migrated.close();
	const inspected = new DatabaseSync(databasePath, {readOnly: true});
	assert.equal(inspected.prepare('PRAGMA user_version').get().user_version, aiHistorySchemaVersion);
	const columns = new Set(inspected.prepare('PRAGMA table_info(ai_history_interactions)').all().map(row => row.name));
	assert.equal(columns.has('artifact_references_json'), true);
	assert.equal(columns.has('outcome'), true);
	assert.equal(inspected.prepare('SELECT count(*) AS count FROM sqlite_master WHERE type = \'table\' AND name = \'ai_transcript_cache\'').get().count, 1);
	inspected.close();
});
