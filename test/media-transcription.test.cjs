const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {mkdtemp, readdir, readFile} = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
	maximumTranscriptionBytes,
	MediaTranscriptionService,
	normalizeTranscriptSegments,
	OpenAiTranscriptionClient,
	openAiTranscriptionModel,
	transcriptCacheSchemaVersion,
	TranscriptionError,
} = require('../dist-js/media-transcription.js');
const {MessengerMediaResolver} = require('../dist-js/media-resolver.js');
const {VideoToolError} = require('../dist-js/video-toolchain.js');

const snapshot = {
	captureGeneration: 3,
	conversationId: 'messenger-thread:123',
	messengerWebContentsId: 7,
	sessionId: 'ai-session-2',
};

async function fixtureDirectory() {
	return mkdtemp(path.join(os.tmpdir(), 'caprine-transcription-test-'));
}

function responseWithSegments(segments = [
	{end: 1.25, start: 0, text: ' Hello '},
	{end: 2.5, start: 1.25, text: 'world.'},
]) {
	return new Response(JSON.stringify({
		duration: 2.5,
		language: 'en',
		segments,
		text: 'Hello world.',
		usage: {seconds: 3, type: 'duration'},
	}), {status: 200});
}

async function expectCode(promise, code) {
	await assert.rejects(promise, error => {
		assert.ok(error instanceof TranscriptionError);
		assert.equal(error.code, code);
		return true;
	});
}

function memoryTranscriptCache() {
	const records = new Map();
	let generation = 0;
	return {
		clearAll() {
			records.clear();
			generation += 1;
		},
		deleteTranscriptCache(mediaSha256) {
			records.delete(mediaSha256);
		},
		getTranscriptCacheGeneration() {
			return generation;
		},
		loadTranscriptCache(mediaSha256) {
			return records.get(mediaSha256);
		},
		records,
		saveTranscriptCache(mediaSha256, record, expectedGeneration) {
			if (expectedGeneration === generation && !records.has(mediaSha256)) {
				records.set(mediaSha256, structuredClone(record));
			}
		},
	};
}

test('OpenAI transcription uses the official bounded timestamp request and exposes only normalized segments', async () => {
	let captured;
	const client = new OpenAiTranscriptionClient({
		async fetchImplementation(url, options) {
			captured = {options, url};
			return responseWithSegments();
		},
	});
	const transcript = await client.transcribe('sk-private', new Uint8Array([1, 2, 3]), 'audio/ogg');

	assert.equal(captured.url, 'https://api.openai.com/v1/audio/transcriptions');
	assert.equal(captured.options.method, 'POST');
	assert.equal(captured.options.redirect, 'error');
	assert.equal(captured.options.headers.Authorization, 'Bearer sk-private');
	assert.ok(captured.options.body instanceof FormData);
	assert.equal(captured.options.body.get('model'), 'whisper-1');
	assert.equal(captured.options.body.get('response_format'), 'verbose_json');
	assert.deepEqual(captured.options.body.getAll('timestamp_granularities[]'), ['segment']);
	assert.equal(captured.options.body.get('temperature'), '0');
	const uploaded = captured.options.body.get('file');
	assert.ok(uploaded instanceof Blob);
	assert.equal(uploaded.name, 'messenger-audio.ogg');
	assert.equal(uploaded.type, 'audio/ogg');
	assert.equal(uploaded.size, 3);
	assert.equal(JSON.stringify([...captured.options.body]).includes('sk-private'), false);
	assert.deepEqual(transcript, {
		model: openAiTranscriptionModel,
		segments: [
			{endSeconds: 1.25, startSeconds: 0, text: 'Hello'},
			{endSeconds: 2.5, startSeconds: 1.25, text: 'world.'},
		],
	});
});

test('transcription output rejects missing, empty, overlapping, non-finite, and oversized segment data', () => {
	for (const value of [
		{},
		{segments: []},
		{segments: [{end: 1, start: 0, text: '   '}]},
		{segments: [{end: 1, start: Number.NaN, text: 'bad'}]},
		{segments: [{end: 2, start: 1, text: 'first'}, {end: 3, start: 1.5, text: 'overlap'}]},
		{segments: [{end: 301, start: 0, text: 'too long'}]},
	]) {
		assert.throws(
			() => normalizeTranscriptSegments(value),
			error => error instanceof TranscriptionError && error.code === 'malformed-response',
		);
	}
});

test('transcription retries only bounded transient failures and maps stable provider errors', async () => {
	let attempts = 0;
	const retrying = new OpenAiTranscriptionClient({
		async fetchImplementation() {
			attempts += 1;
			return attempts === 1 ? new Response(null, {status: 500}) : responseWithSegments();
		},
		retryDelayMilliseconds: 0,
	});
	await retrying.transcribe('sk-private', new Uint8Array([1]), 'audio/wav');
	assert.equal(attempts, 2);

	for (const [status, code] of [[400, 'unsupported-media'], [401, 'authentication'], [413, 'oversized']]) {
		attempts = 0;
		const client = new OpenAiTranscriptionClient({
			async fetchImplementation() {
				attempts += 1;
				return new Response(null, {status});
			},
			retryDelayMilliseconds: 0,
		});
		// eslint-disable-next-line no-await-in-loop
		await expectCode(client.transcribe('sk-private', new Uint8Array([1]), 'audio/wav'), code);
		assert.equal(attempts, 1);
	}

	attempts = 0;
	const rateLimited = new OpenAiTranscriptionClient({
		async fetchImplementation() {
			attempts += 1;
			return new Response(null, {status: 429});
		},
		retryDelayMilliseconds: 0,
	});
	await expectCode(rateLimited.transcribe('sk-private', new Uint8Array([1]), 'audio/wav'), 'rate-limit');
	assert.equal(attempts, 2);
});

test('transcription maps caller cancellation and timeout without exposing response bodies', async () => {
	const waitForAbort = async (_url, options) => new Promise((_resolve, reject) => {
		options.signal.addEventListener('abort', () => {
			reject(new DOMException('secret provider body', 'AbortError'));
		}, {once: true});
	});
	const client = new OpenAiTranscriptionClient({fetchImplementation: waitForAbort, timeoutMilliseconds: 5});
	const cancellation = new AbortController();
	const request = client.transcribe('sk-private', new Uint8Array([1]), 'audio/wav', cancellation.signal);
	cancellation.abort();
	await expectCode(request, 'cancelled');
	await expectCode(client.transcribe('sk-private', new Uint8Array([1]), 'audio/wav'), 'timeout');
});

test('transcription validates key, bytes, format, and attempt bounds before fetch', async () => {
	let called = false;
	const client = new OpenAiTranscriptionClient({
		async fetchImplementation() {
			called = true;
			return responseWithSegments();
		},
	});
	await expectCode(client.transcribe('', new Uint8Array([1]), 'audio/wav'), 'missing-key');
	await expectCode(client.transcribe('sk-private', new Uint8Array(), 'audio/wav'), 'oversized');
	await expectCode(client.transcribe('sk-private', new Uint8Array([1]), 'audio/aac'), 'unsupported-media');
	assert.equal(called, false);
	assert.throws(() => new OpenAiTranscriptionClient({maximumAttempts: 3}), /between 1 and 2/);
});

function fakeHandles(media) {
	let releases = 0;
	let handoffs = 0;
	return {
		describeHandle() {
			return media;
		},
		get handoffs() {
			return handoffs;
		},
		get releases() {
			return releases;
		},
		async releaseHandle() {
			releases += 1;
		},
		async withFile() {
			handoffs += 1;
			throw new Error('unexpected handoff');
		},
	};
}

const supportedMedia = {
	byteLength: 3,
	durationSeconds: 2.5,
	handleId: 'handle-1',
	kind: 'audio',
	messageId: 'message-voice',
	mimeType: 'audio/ogg',
	sourceType: 'blob',
};

function request(overrides = {}) {
	return {
		consent: 'transcribe-and-review',
		items: [{handleId: 'handle-1', messageId: 'message-voice'}],
		snapshot,
		...overrides,
	};
}

test('media transcription rejects consent, batch, size, type, and stale snapshot before upload and releases requested handles', async () => {
	for (const [overrides, media, currentSnapshot, code] of [
		[{consent: 'not-consented'}, supportedMedia, snapshot, 'invalid-consent'],
		[{items: []}, supportedMedia, snapshot, 'item-limit'],
		[{
			items: [
				{handleId: 'handle-1', messageId: 'message-voice'},
				{handleId: 'handle-2', messageId: 'message-voice-2'},
				{handleId: 'handle-3', messageId: 'message-voice-3'},
			],
		}, supportedMedia, snapshot, 'item-limit'],
		[{
			items: [
				{handleId: 'handle-1', messageId: 'message-voice'},
				{handleId: 'handle-1', messageId: 'message-voice'},
			],
		}, supportedMedia, snapshot, 'item-limit'],
		[{}, {...supportedMedia, byteLength: maximumTranscriptionBytes + 1}, snapshot, 'oversized'],
		[{}, {...supportedMedia, kind: 'video', mimeType: 'audio/mp4'}, snapshot, 'unsupported-media'],
		[{}, supportedMedia, {...snapshot, conversationId: 'messenger-thread:other'}, 'stale-media'],
	]) {
		const handles = fakeHandles(media);
		let providerCalls = 0;
		const service = new MediaTranscriptionService(handles, {
			async transcribe() {
				providerCalls += 1;
				throw new Error('unexpected provider call');
			},
		}, () => currentSnapshot, async () => 2.5);
		// eslint-disable-next-line no-await-in-loop
		await expectCode(service.transcribeBatch('sk-private', request(overrides)), code);
		assert.equal(handles.handoffs, 0);
		assert.equal(providerCalls, 0);
		assert.equal(handles.releases, request(overrides).items.length);
	}
});

test('media transcription derives the duration locally before upload instead of trusting renderer metadata', async () => {
	const directory = await fixtureDirectory();
	const resolver = new MessengerMediaResolver(directory, async () => {
		throw new Error('unexpected Messenger fetch');
	});
	await resolver.cleanupRestartArtifacts();
	const media = await resolver.resolveBlob(
		new Uint8Array([1, 2, 3]).buffer,
		'audio/wav',
		'audio',
		'message-voice',
		snapshot,
		299,
	);
	let providerCalls = 0;
	const service = new MediaTranscriptionService(resolver, {
		async transcribe() {
			providerCalls += 1;
			throw new Error('unexpected provider call');
		},
	}, () => snapshot, async () => 301);

	await expectCode(
		service.transcribeBatch('sk-private', request({items: [{handleId: media.handleId, messageId: media.messageId}]})),
		'duration-exceeded',
	);
	assert.equal(providerCalls, 0);
	assert.deepEqual(await readdir(directory), []);
});

test('media transcription binds provider work to the current handle and releases bytes after success', async () => {
	const directory = await fixtureDirectory();
	const resolver = new MessengerMediaResolver(directory, async () => {
		throw new Error('unexpected Messenger fetch');
	});
	await resolver.cleanupRestartArtifacts();
	const bytes = new Uint8Array([4, 5, 6]);
	const media = await resolver.resolveBlob(bytes.buffer, 'audio/ogg', 'audio', 'message-voice', snapshot, 2.5);
	let providerInput;
	const service = new MediaTranscriptionService(resolver, {
		async transcribe(apiKey, providerBytes, mimeType) {
			providerInput = {apiKey, bytes: [...providerBytes], mimeType};
			return {
				model: openAiTranscriptionModel,
				segments: [{endSeconds: 2.5, startSeconds: 0, text: 'Synthetic transcript'}],
			};
		},
	}, () => snapshot, async () => 2.5);

	const [transcript] = await service.transcribeBatch(
		'sk-private',
		request({items: [{handleId: media.handleId, messageId: media.messageId}]}),
	);
	assert.deepEqual(providerInput, {apiKey: 'sk-private', bytes: [4, 5, 6], mimeType: 'audio/ogg'});
	assert.deepEqual(transcript, {
		mediaSha256: createHash('sha256').update(bytes).digest('hex'),
		model: openAiTranscriptionModel,
		segments: [{endSeconds: 2.5, startSeconds: 0, text: 'Synthetic transcript'}],
		source: {
			byteLength: 3,
			durationSeconds: 2.5,
			kind: 'audio',
			messageId: 'message-voice',
			mimeType: 'audio/ogg',
		},
	});
	assert.deepEqual(await readdir(directory), []);
	const serialized = JSON.stringify(transcript);
	assert.equal(serialized.includes('sk-private'), false);
	assert.equal(serialized.includes(directory), false);
	assert.equal(serialized.includes('filePath'), false);
	assert.equal(serialized.includes('bytes'), false);
});

test('identical media bytes reuse a bounded cache record and rebind current request metadata', async () => {
	const directory = await fixtureDirectory();
	const resolver = new MessengerMediaResolver(directory, async () => {
		throw new Error('unexpected Messenger fetch');
	});
	await resolver.cleanupRestartArtifacts();
	const bytes = new Uint8Array([21, 22, 23]);
	let providerCalls = 0;
	let keyReads = 0;
	const cache = memoryTranscriptCache();
	const service = new MediaTranscriptionService(resolver, {
		async transcribe(apiKey) {
			providerCalls += 1;
			assert.equal(apiKey, 'sk-private');
			return {
				model: openAiTranscriptionModel,
				segments: [{endSeconds: 2, startSeconds: 0, text: 'Reusable transcript'}],
			};
		},
	}, () => snapshot, {inspectDuration: async () => 2, transcriptCache: cache});
	const firstMedia = await resolver.resolveBlob(bytes.buffer, 'audio/ogg', 'audio', 'message-first', snapshot, 2);
	const [first] = await service.transcribeBatch(() => {
		keyReads += 1;
		return 'sk-private';
	}, request({items: [{handleId: firstMedia.handleId, messageId: firstMedia.messageId}]}));
	const secondMedia = await resolver.resolveBlob(bytes.buffer, 'audio/ogg', 'audio', 'message-second', snapshot, 2);
	const [second] = await service.transcribeBatch(() => {
		keyReads += 1;
		throw new Error('cache hit must not read the API key');
	}, request({items: [{handleId: secondMedia.handleId, messageId: secondMedia.messageId}]}));

	assert.equal(providerCalls, 1);
	assert.equal(keyReads, 1);
	assert.equal(first.mediaSha256, createHash('sha256').update(bytes).digest('hex'));
	assert.equal(second.mediaSha256, first.mediaSha256);
	assert.equal(first.source.messageId, 'message-first');
	assert.equal(second.source.messageId, 'message-second');
	assert.deepEqual(second.segments, first.segments);
	assert.deepEqual(cache.records.get(first.mediaSha256), {
		model: openAiTranscriptionModel,
		schemaVersion: transcriptCacheSchemaVersion,
		segments: first.segments,
	});
	const serialized = JSON.stringify(cache.records.get(first.mediaSha256));
	assert.equal(serialized.includes('message-first'), false);
	assert.equal(serialized.includes('message-second'), false);
	assert.equal(serialized.includes('audio/ogg'), false);
	assert.deepEqual(await readdir(directory), []);
});

test('clear-all generation prevents an active provider completion from repopulating the cache', async () => {
	const directory = await fixtureDirectory();
	const resolver = new MessengerMediaResolver(directory, async () => {
		throw new Error('unexpected Messenger fetch');
	});
	await resolver.cleanupRestartArtifacts();
	const cache = memoryTranscriptCache();
	let releaseProvider;
	let providerStarted;
	const started = new Promise(resolve => {
		providerStarted = resolve;
	});
	const service = new MediaTranscriptionService(resolver, {
		async transcribe() {
			providerStarted();
			await new Promise(resolve => {
				releaseProvider = resolve;
			});
			return {
				model: openAiTranscriptionModel,
				segments: [{endSeconds: 1, startSeconds: 0, text: 'Late transcript'}],
			};
		},
	}, () => snapshot, {inspectDuration: async () => 1, transcriptCache: cache});
	const media = await resolver.resolveBlob(
		new Uint8Array([41, 42, 43]).buffer,
		'audio/wav',
		'audio',
		'message-clear-race',
		snapshot,
		1,
	);
	const result = service.transcribeBatch(
		'sk-private',
		request({items: [{handleId: media.handleId, messageId: media.messageId}]}),
	);
	await started;
	cache.clearAll();
	releaseProvider();
	await result;

	assert.equal(cache.records.size, 0);
	assert.deepEqual(await readdir(directory), []);
});

test('malformed cache entries fail closed, are evicted, and require a new explicit action before provider retry', async () => {
	const directory = await fixtureDirectory();
	const resolver = new MessengerMediaResolver(directory, async () => {
		throw new Error('unexpected Messenger fetch');
	});
	await resolver.cleanupRestartArtifacts();
	const bytes = new Uint8Array([31, 32, 33]);
	const mediaSha256 = createHash('sha256').update(bytes).digest('hex');
	const cache = memoryTranscriptCache();
	cache.records.set(mediaSha256, {
		model: openAiTranscriptionModel,
		schemaVersion: transcriptCacheSchemaVersion,
		segments: [{endSeconds: 1, startSeconds: 0, text: ''}],
	});
	let providerCalls = 0;
	const service = new MediaTranscriptionService(resolver, {
		async transcribe() {
			providerCalls += 1;
			return {
				model: openAiTranscriptionModel,
				segments: [{endSeconds: 1, startSeconds: 0, text: 'Fresh transcript'}],
			};
		},
	}, () => snapshot, {inspectDuration: async () => 1, transcriptCache: cache});
	const malformedMedia = await resolver.resolveBlob(bytes.buffer, 'audio/wav', 'audio', 'message-malformed', snapshot, 1);
	await expectCode(
		service.transcribeBatch('sk-private', request({items: [{handleId: malformedMedia.handleId, messageId: malformedMedia.messageId}]})),
		'malformed-cache',
	);
	assert.equal(providerCalls, 0);
	assert.equal(cache.records.has(mediaSha256), false);

	const retryMedia = await resolver.resolveBlob(bytes.buffer, 'audio/wav', 'audio', 'message-retry', snapshot, 1);
	const [retried] = await service.transcribeBatch(
		'sk-private',
		request({items: [{handleId: retryMedia.handleId, messageId: retryMedia.messageId}]}),
	);
	assert.equal(providerCalls, 1);
	assert.equal(retried.source.messageId, 'message-retry');
	assert.deepEqual(cache.records.get(mediaSha256).segments, retried.segments);
	assert.deepEqual(await readdir(directory), []);
});

test('media transcription discards stale completions and releases bytes after provider failure, cancellation, or handle release', async () => {
	await Promise.all(['stale', 'failure', 'cancelled', 'released'].map(async scenario => {
		const directory = await fixtureDirectory();
		const resolver = new MessengerMediaResolver(directory, async () => {
			throw new Error('unexpected Messenger fetch');
		});
		await resolver.cleanupRestartArtifacts();
		const media = await resolver.resolveBlob(
			new Uint8Array([7, 8, 9]).buffer,
			'audio/wav',
			'audio',
			'message-voice',
			snapshot,
			2,
		);
		let current = snapshot;
		const cancellation = new AbortController();
		const cache = memoryTranscriptCache();
		const service = new MediaTranscriptionService(resolver, {
			async transcribe() {
				if (scenario === 'stale') {
					current = {...snapshot, conversationId: 'messenger-thread:other'};
					return {model: openAiTranscriptionModel, segments: [{endSeconds: 2, startSeconds: 0, text: 'late'}]};
				}

				if (scenario === 'released') {
					await resolver.releaseHandle(media.handleId);
					return {model: openAiTranscriptionModel, segments: [{endSeconds: 2, startSeconds: 0, text: 'released'}]};
				}

				if (scenario === 'cancelled') {
					cancellation.abort();
					throw new TranscriptionError('cancelled', 'Transcription cancelled.');
				}

				throw new TranscriptionError('provider-unavailable', 'Provider failed.');
			},
		}, () => current, {inspectDuration: async () => 2, transcriptCache: cache});
		const expectedCodes = {
			cancelled: 'cancelled',
			failure: 'provider-unavailable',
			released: 'stale-media',
			stale: 'stale-media',
		};
		await expectCode(
			service.transcribeBatch(
				'sk-private',
				request({items: [{handleId: media.handleId, messageId: media.messageId}]}),
				cancellation.signal,
			),
			expectedCodes[scenario],
		);
		assert.equal(cache.records.size, 0);
		assert.deepEqual(await readdir(directory), []);
	}));
});

test('a failed two-item batch does not cache an earlier successful item', async () => {
	const directory = await fixtureDirectory();
	const resolver = new MessengerMediaResolver(directory, async () => {
		throw new Error('unexpected Messenger fetch');
	});
	await resolver.cleanupRestartArtifacts();
	const first = await resolver.resolveBlob(
		new Uint8Array([51, 52]).buffer,
		'audio/wav',
		'audio',
		'message-first',
		snapshot,
		1,
	);
	const second = await resolver.resolveBlob(
		new Uint8Array([53, 54]).buffer,
		'audio/wav',
		'audio',
		'message-second',
		snapshot,
		1,
	);
	const cache = memoryTranscriptCache();
	let providerCalls = 0;
	const service = new MediaTranscriptionService(resolver, {
		async transcribe() {
			providerCalls += 1;
			if (providerCalls === 2) {
				throw new TranscriptionError('provider-unavailable', 'Provider failed.');
			}

			return {
				model: openAiTranscriptionModel,
				segments: [{endSeconds: 1, startSeconds: 0, text: 'First transcript'}],
			};
		},
	}, () => snapshot, {inspectDuration: async () => 1, transcriptCache: cache});

	await expectCode(service.transcribeBatch('sk-private', request({
		items: [
			{handleId: first.handleId, messageId: first.messageId},
			{handleId: second.handleId, messageId: second.messageId},
		],
	})), 'provider-unavailable');
	assert.equal(providerCalls, 2);
	assert.equal(cache.records.size, 0);
	assert.deepEqual(await readdir(directory), []);
});

test('media transcription processes one authoritative two-item batch and releases both handles', async () => {
	const directory = await fixtureDirectory();
	const resolver = new MessengerMediaResolver(directory, async () => {
		throw new Error('unexpected Messenger fetch');
	});
	await resolver.cleanupRestartArtifacts();
	const first = await resolver.resolveBlob(
		new Uint8Array([10, 11]).buffer,
		'audio/wav',
		'audio',
		'message-one',
		snapshot,
		1,
	);
	const second = await resolver.resolveBlob(
		new Uint8Array([12, 13, 14]).buffer,
		'audio/ogg',
		'audio',
		'message-two',
		snapshot,
		1.5,
	);
	const providerMessageSizes = [];
	const service = new MediaTranscriptionService(resolver, {
		async transcribe(_apiKey, bytes) {
			providerMessageSizes.push(bytes.byteLength);
			return {
				model: openAiTranscriptionModel,
				segments: [{endSeconds: 1, startSeconds: 0, text: `Transcript ${bytes.byteLength}`}],
			};
		},
	}, () => snapshot, async filePath => filePath.endsWith('.wav') ? 1 : 1.5);

	const transcripts = await service.transcribeBatch('sk-private', request({
		items: [
			{handleId: first.handleId, messageId: first.messageId},
			{handleId: second.handleId, messageId: second.messageId},
		],
	}));
	assert.deepEqual(providerMessageSizes, [2, 3]);
	assert.deepEqual(transcripts.map(transcript => transcript.source), [
		{
			byteLength: 2,
			durationSeconds: 1,
			kind: 'audio',
			messageId: 'message-one',
			mimeType: 'audio/wav',
		},
		{
			byteLength: 3,
			durationSeconds: 1.5,
			kind: 'audio',
			messageId: 'message-two',
			mimeType: 'audio/ogg',
		},
	]);
	assert.deepEqual(await readdir(directory), []);
});

test('video transcription extracts bounded audio, exposes fixed progress, and uploads only normalized audio bytes', async () => {
	const directory = await fixtureDirectory();
	const resolver = new MessengerMediaResolver(directory, async () => {
		throw new Error('unexpected Messenger fetch');
	});
	await resolver.cleanupRestartArtifacts();
	const media = await resolver.resolveBlob(
		new Uint8Array([70, 71, 72, 73]).buffer,
		'video/mp4',
		'video',
		'message-video',
		snapshot,
		4,
	);
	const phases = [];
	let providerInput;
	const service = new MediaTranscriptionService(resolver, {
		async transcribe(apiKey, bytes, mimeType) {
			providerInput = {apiKey, bytes: [...bytes], mimeType};
			return {
				model: openAiTranscriptionModel,
				segments: [{endSeconds: 4, startSeconds: 0, text: 'Video audio'}],
			};
		},
	}, () => snapshot, {
		videoAudioExtractor: {
			async extract(_filePath, options) {
				options.onPhase('extracting-audio');
				return {
					audioTrackAvailable: true,
					bytes: new Uint8Array([8, 9, 10]),
					durationSeconds: 4,
					mimeType: 'audio/mpeg',
				};
			},
		},
	});

	const [transcript] = await service.transcribeBatch(
		'sk-private',
		request({items: [{handleId: media.handleId, messageId: media.messageId}]}),
		undefined,
		phase => phases.push(phase),
	);
	assert.deepEqual(phases, ['extracting-audio', 'transcribing']);
	assert.deepEqual(providerInput, {apiKey: 'sk-private', bytes: [8, 9, 10], mimeType: 'audio/mpeg'});
	assert.equal(transcript.source.kind, 'video');
	assert.equal(transcript.source.mimeType, 'audio/mpeg');
	assert.equal(transcript.source.durationSeconds, 4);
	assert.equal(transcript.mediaSha256, createHash('sha256').update(new Uint8Array([8, 9, 10])).digest('hex'));
	assert.deepEqual(await readdir(directory), []);
});

test('silent video returns an explicit no-audio result without reading a key or calling the provider', async () => {
	const directory = await fixtureDirectory();
	const resolver = new MessengerMediaResolver(directory, async () => {
		throw new Error('unexpected Messenger fetch');
	});
	await resolver.cleanupRestartArtifacts();
	const media = await resolver.resolveBlob(
		new Uint8Array([80, 81]).buffer,
		'video/webm',
		'video',
		'message-silent',
		snapshot,
		2,
	);
	let providerCalls = 0;
	const service = new MediaTranscriptionService(resolver, {
		async transcribe() {
			providerCalls += 1;
			throw new Error('unexpected provider call');
		},
	}, () => snapshot, {
		videoAudioExtractor: {
			async extract() {
				return {audioTrackAvailable: false, durationSeconds: 2};
			},
		},
	});

	const [result] = await service.transcribeBatch(() => {
		throw new Error('silent video must not read the API key');
	}, request({items: [{handleId: media.handleId, messageId: media.messageId}]}));
	assert.deepEqual(result, {
		source: {
			byteLength: 2,
			durationSeconds: 2,
			kind: 'video',
			messageId: 'message-silent',
			mimeType: 'video/webm',
		},
		status: 'no-audio',
	});
	assert.equal(providerCalls, 0);
	assert.deepEqual(await readdir(directory), []);
});

test('reviewed video retains its original file for frames only after successful transcription', async () => {
	await Promise.all(['success', 'silent', 'failure', 'cancelled', 'stale', 'audio'].map(async scenario => {
		const directory = await fixtureDirectory();
		const resolver = new MessengerMediaResolver(directory, async () => {
			throw new Error('unexpected network request');
		});
		await resolver.cleanupRestartArtifacts();
		const kind = scenario === 'audio' ? 'audio' : 'video';
		const media = await resolver.resolveBlob(new Uint8Array([1, 2, 3]).buffer,
			kind === 'video' ? 'video/mp4' : 'audio/ogg', kind, 'retained-video', snapshot, 2);
		const controller = new AbortController();
		let current = snapshot;
		const service = new MediaTranscriptionService(resolver, {
			async transcribe() {
				if (scenario === 'failure') {
					throw new TranscriptionError('provider-failed', 'Fixture failure');
				}

				if (scenario === 'cancelled') {
					controller.abort();
				}

				if (scenario === 'stale') {
					current = {...snapshot, conversationId: 'other-conversation'};
				}

				return {model: openAiTranscriptionModel, segments: [{startSeconds: 0, endSeconds: 2, text: 'Video'}]};
			},
		}, () => current, {
			inspectDuration: async () => 2,
			videoAudioExtractor: {
				async extract() {
					return scenario === 'silent'
						? {audioTrackAvailable: false, durationSeconds: 2}
						: {
							audioTrackAvailable: true, durationSeconds: 2, bytes: new Uint8Array([4, 5]), mimeType: 'audio/mpeg',
						};
				},
			},
		});
		const pending = service.transcribeBatch('fixture-key', request({
			items: [{handleId: media.handleId, messageId: media.messageId}],
			retainVideoHandles: true,
		}), controller.signal);
		await (['failure', 'cancelled', 'stale'].includes(scenario) ? assert.rejects(pending) : pending);
		if (['success', 'silent'].includes(scenario)) {
			await resolver.inspectFile(media.handleId, media.messageId, snapshot, async filePath => {
				const bytes = await readFile(filePath);
				assert.equal(bytes.length, 3);
			});
			await assert.rejects(resolver.inspectFile(media.handleId, media.messageId,
				{...snapshot, conversationId: 'wrong-conversation'}, async () => {}));
			await resolver.releaseHandle(media.handleId);
		}

		assert.deepEqual(await readdir(directory), [], scenario);
	}));
});

test('late video extraction results are rejected after cancellation and conversation invalidation', async () => {
	await Promise.all(['cancelled', 'stale'].map(async scenario => {
		const directory = await fixtureDirectory();
		const resolver = new MessengerMediaResolver(directory, async () => {
			throw new Error('unexpected Messenger fetch');
		});
		await resolver.cleanupRestartArtifacts();
		const media = await resolver.resolveBlob(
			new Uint8Array([90, 91]).buffer,
			'video/mp4',
			'video',
			`message-${scenario}`,
			snapshot,
			2,
		);
		let current = snapshot;
		const cancellation = new AbortController();
		const service = new MediaTranscriptionService(resolver, {
			async transcribe() {
				throw new Error('unexpected provider call');
			},
		}, () => current, {
			videoAudioExtractor: {
				async extract() {
					if (scenario === 'cancelled') {
						cancellation.abort();
					} else {
						current = {...snapshot, conversationId: 'messenger-thread:other'};
					}

					return {audioTrackAvailable: false, durationSeconds: 2};
				},
			},
		});
		await expectCode(service.transcribeBatch(
			'sk-private',
			request({items: [{handleId: media.handleId, messageId: media.messageId}]}),
			cancellation.signal,
		), scenario === 'cancelled' ? 'cancelled' : 'stale-media');
		assert.deepEqual(await readdir(directory), []);
	}));
});

test('video extraction maps cancellation, timeout, corrupt input, and unavailable tools to typed failures', async () => {
	for (const [videoCode, expectedCode] of [
		['cancelled', 'cancelled'],
		['timeout', 'timeout'],
		['unsupported-video', 'unsupported-media'],
		['tools-unavailable', 'local-tools-unavailable'],
	]) {
		const media = {...supportedMedia, kind: 'video', mimeType: 'video/mp4'};
		let releases = 0;
		const handles = {
			describeHandle() {
				return media;
			},
			get releases() {
				return releases;
			},
			async releaseHandle() {
				releases += 1;
			},
			async withFile(_handleId, _messageId, _snapshot, callback) {
				return callback('/private/tmp/caprine-video.mp4', media);
			},
		};
		const service = new MediaTranscriptionService(handles, {
			async transcribe() {
				throw new Error('unexpected provider call');
			},
		}, () => snapshot, {
			videoAudioExtractor: {
				async extract() {
					throw new VideoToolError(videoCode, 'sanitized video failure');
				},
			},
		});
		// eslint-disable-next-line no-await-in-loop
		await expectCode(service.transcribeBatch('sk-private', request()), expectedCode);
		assert.equal(handles.releases, 1);
	}
});
