const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {mkdtemp, readdir} = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
	maximumTranscriptionBytes,
	MediaTranscriptionService,
	normalizeTranscriptSegments,
	OpenAiTranscriptionClient,
	openAiTranscriptionModel,
	TranscriptionError,
} = require('../dist-js/media-transcription.js');
const {MessengerMediaResolver} = require('../dist-js/media-resolver.js');

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
		handleId: 'handle-1',
		itemCount: 1,
		messageId: 'message-voice',
		snapshot,
		...overrides,
	};
}

test('media transcription rejects consent, item, size, duration, type, and stale snapshot before upload and releases the handle', async () => {
	for (const [overrides, media, currentSnapshot, code] of [
		[{consent: 'not-consented'}, supportedMedia, snapshot, 'invalid-consent'],
		[{itemCount: 3}, supportedMedia, snapshot, 'item-limit'],
		[{}, {...supportedMedia, byteLength: maximumTranscriptionBytes + 1}, snapshot, 'oversized'],
		[{}, {...supportedMedia, durationSeconds: 301}, snapshot, 'duration-exceeded'],
		[{}, {...supportedMedia, durationSeconds: undefined}, snapshot, 'unsupported-media'],
		[{}, {...supportedMedia, kind: 'video', mimeType: 'video/mp4'}, snapshot, 'unsupported-media'],
		[{}, supportedMedia, {...snapshot, conversationId: 'messenger-thread:other'}, 'stale-media'],
	]) {
		const handles = fakeHandles(media);
		const service = new MediaTranscriptionService(handles, {
			async transcribe() {
				throw new Error('unexpected provider call');
			},
		}, () => currentSnapshot);
		// eslint-disable-next-line no-await-in-loop
		await expectCode(service.transcribe('sk-private', request(overrides)), code);
		assert.equal(handles.handoffs, 0);
		assert.equal(handles.releases, 1);
	}
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
	}, () => snapshot);

	const transcript = await service.transcribe('sk-private', request({handleId: media.handleId}));
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

test('media transcription discards stale completions and releases bytes after provider failure or cancellation', async () => {
	await Promise.all(['stale', 'failure', 'cancelled'].map(async scenario => {
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
		const service = new MediaTranscriptionService(resolver, {
			async transcribe() {
				if (scenario === 'stale') {
					current = {...snapshot, conversationId: 'messenger-thread:other'};
					return {model: openAiTranscriptionModel, segments: [{endSeconds: 2, startSeconds: 0, text: 'late'}]};
				}

				if (scenario === 'cancelled') {
					cancellation.abort();
					throw new TranscriptionError('cancelled', 'Transcription cancelled.');
				}

				throw new TranscriptionError('provider-unavailable', 'Provider failed.');
			},
		}, () => current);
		const expectedCodes = {
			cancelled: 'cancelled',
			failure: 'provider-unavailable',
			stale: 'stale-media',
		};
		await expectCode(
			service.transcribe('sk-private', request({handleId: media.handleId}), cancellation.signal),
			expectedCodes[scenario],
		);
		assert.deepEqual(await readdir(directory), []);
	}));
});
