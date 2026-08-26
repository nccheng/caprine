const assert = require('node:assert/strict');
const test = require('node:test');
const {
	createNativeMessengerImageNormalizer,
	maximumProcessedMessengerImageBytes,
	processedMessengerImageDimensions,
	ProcessedMessengerImageStore,
} = require('../dist-js/messenger-image-normalization.js');

const snapshot = {
	captureGeneration: 4,
	conversationId: 'messenger-thread:fixture',
	messengerWebContentsId: 8,
	sessionId: 'ai-session-2',
};

function captureDescription(overrides = {}) {
	return Object.freeze({
		byteLength: 32,
		handleId: 'image-capture-1',
		height: 2,
		messageId: 'fixture-image',
		snapshot: Object.freeze({...snapshot}),
		status: 'captured',
		width: 4,
		...overrides,
	});
}

function captureStore(description = captureDescription(), bytes = new Uint8Array(32).fill(7)) {
	let retained = bytes;
	let releases = 0;
	return {
		describeHandle(handleId, messageId, candidateSnapshot) {
			return retained
				&& handleId === description.handleId
				&& messageId === description.messageId
				&& candidateSnapshot.conversationId === description.snapshot.conversationId
				? description
				: undefined;
		},
		get releases() {
			return releases;
		},
		releaseHandle(handleId) {
			if (!retained || handleId !== description.handleId) {
				return false;
			}

			retained.fill(0);
			retained = undefined;
			releases += 1;
			return true;
		},
		async withCapture(handleId, messageId, candidateSnapshot, callback) {
			const current = this.describeHandle(handleId, messageId, candidateSnapshot);
			if (!current) {
				throw new TypeError('stale capture');
			}

			const source = retained;
			retained = undefined;
			try {
				return await callback(source, current);
			} finally {
				source.fill(0);
				releases += 1;
			}
		},
	};
}

test('processed dimensions preserve aspect ratio inside the fixed maximum', () => {
	assert.deepEqual(processedMessengerImageDimensions(800, 600), {height: 600, width: 800});
	assert.deepEqual(processedMessengerImageDimensions(4096, 2048), {height: 1024, width: 2048});
	assert.deepEqual(processedMessengerImageDimensions(2048, 4096), {height: 2048, width: 1024});
	assert.equal(processedMessengerImageDimensions(0, 10), undefined);
	assert.equal(processedMessengerImageDimensions(1.5, 10), undefined);
});

test('native normalizer re-encodes generated pixels as PNG and clears working buffers', async () => {
	const bitmapReferences = [];
	const encodedReferences = [];
	const generatedPng = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
	const imageFactory = {
		createFromBitmap(bitmap, options) {
			bitmapReferences.push(bitmap);
			assert.deepEqual(options, {height: 1, scaleFactor: 1, width: 2});
			return {
				getSize: () => ({height: 1, width: 2}),
				isEmpty: () => false,
				resize(resizeOptions) {
					assert.deepEqual(resizeOptions, {height: 1, quality: 'best', width: 2});
					return {
						getSize: () => ({height: 1, width: 2}),
						isEmpty: () => false,
						toPNG() {
							const encoded = Buffer.from(generatedPng);
							encodedReferences.push(encoded);
							return encoded;
						},
					};
				},
			};
		},
	};
	const normalize = createNativeMessengerImageNormalizer(imageFactory);
	const sourcePixels = Uint8Array.from([255, 0, 0, 255, 0, 0, 255, 255]);
	const output = await normalize({
		bytes: sourcePixels,
		height: 1,
		signal: new AbortController().signal,
		targetHeight: 1,
		targetWidth: 2,
		width: 2,
	});

	assert.deepEqual(output, {
		bytes: new Uint8Array(generatedPng),
		height: 1,
		mimeType: 'image/png',
		width: 2,
	});
	assert.equal(bitmapReferences[0].every(byte => byte === 0), true);
	assert.equal(encodedReferences[0].every(byte => byte === 0), true);
	assert.deepEqual(sourcePixels, Uint8Array.from([255, 0, 0, 255, 0, 0, 255, 255]));
});

test('normalization preserves source identity and exposes only a bounded local handle', async () => {
	const captures = captureStore();
	const temporaryOutput = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
	const released = [];
	const store = new ProcessedMessengerImageStore(
		captures,
		candidate => candidate.conversationId === snapshot.conversationId,
		async input => {
			assert.deepEqual({
				height: input.height,
				targetHeight: input.targetHeight,
				targetWidth: input.targetWidth,
				width: input.width,
			}, {
				height: 2, targetHeight: 2, targetWidth: 4, width: 4,
			});
			return {
				bytes: temporaryOutput,
				height: 2,
				mimeType: 'image/png',
				width: 4,
			};
		},
		bytes => released.push([...bytes]),
	);
	const result = await store.normalize(
		'image-capture-1',
		'fixture-image',
		snapshot,
		new AbortController().signal,
	);

	assert.equal(result.status, 'processed');
	assert.deepEqual(result, {
		byteLength: 11,
		handleId: 'processed-image-1',
		height: 2,
		messageId: 'fixture-image',
		mimeType: 'image/png',
		snapshot,
		status: 'processed',
		width: 4,
	});
	assert.equal(Object.hasOwn(result, 'bytes'), false);
	assert.equal(Object.hasOwn(result, 'url'), false);
	assert.equal(captures.releases, 1);
	assert.equal(temporaryOutput.every(byte => byte === 0), true);
	assert.deepEqual(store.describeHandle(result.handleId, result.messageId, snapshot), result);

	const handedOff = await store.withProcessedImage(
		result.handleId,
		result.messageId,
		snapshot,
		async bytes => [...bytes],
	);
	assert.deepEqual(handedOff, [137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
	assert.equal(released.length, 2);
	assert.equal(released.every(bytes => bytes.every(byte => byte === 0)), true);
	assert.equal(store.releaseHandle(result.handleId), false);
});

test('invalid and oversized sources fail before normalization and release the capture once', async () => {
	await Promise.all([
		{description: captureDescription({byteLength: 31}), expected: 'invalid-source'},
		{
			description: captureDescription({
				byteLength: (4096 + 1) * 4,
				height: 1,
				width: 4096 + 1,
			}),
			expected: 'oversized-source',
		},
	].map(async scenario => {
		const captures = captureStore(scenario.description, new Uint8Array(1));
		let calls = 0;
		const store = new ProcessedMessengerImageStore(
			captures,
			() => true,
			async () => {
				calls += 1;
				throw new Error('must not run');
			},
		);
		assert.deepEqual(
			await store.normalize(
				scenario.description.handleId,
				scenario.description.messageId,
				snapshot,
				new AbortController().signal,
			),
			{reason: scenario.expected, status: 'unavailable'},
		);
		assert.equal(calls, 0);
		assert.equal(captures.releases, 1);
	}));
});

test('stale source ownership transfer releases the capture exactly once', async () => {
	const captures = captureStore();
	let current = false;
	const originalDescribe = captures.describeHandle;
	captures.describeHandle = (...arguments_) => current
		? originalDescribe.apply(captures, arguments_)
		: undefined;
	const store = new ProcessedMessengerImageStore(
		captures,
		() => current,
	);

	assert.deepEqual(
		await store.normalize(
			'image-capture-1',
			'fixture-image',
			snapshot,
			new AbortController().signal,
		),
		{reason: 'conversation-changed', status: 'unavailable'},
	);
	assert.equal(captures.releases, 1);
	current = true;
	assert.equal(captures.describeHandle('image-capture-1', 'fixture-image', snapshot), undefined);
});

test('malformed oversized failed and canceled outputs never become successful images', async () => {
	const scenarios = [
		{
			expected: 'invalid-output',
			async normalize() {
				return {
					bytes: new Uint8Array([1]),
					height: 1,
					mimeType: 'image/jpeg',
					width: 1,
				};
			},
		},
		{
			expected: 'oversized-output',
			normalize: async () => ({
				bytes: new Uint8Array(maximumProcessedMessengerImageBytes + 1),
				height: 2,
				mimeType: 'image/png',
				width: 4,
			}),
		},
		{
			expected: 'normalization-failed',
			async normalize() {
				throw new Error('codec failed');
			},
		},
	];
	await Promise.all(scenarios.map(async scenario => {
		const captures = captureStore();
		const released = [];
		const store = new ProcessedMessengerImageStore(
			captures,
			() => true,
			scenario.normalize,
			bytes => released.push(bytes.byteLength),
		);
		assert.deepEqual(
			await store.normalize(
				'image-capture-1',
				'fixture-image',
				snapshot,
				new AbortController().signal,
			),
			{reason: scenario.expected, status: 'unavailable'},
		);
		assert.equal(captures.releases, 1);
		assert.equal(store.describeHandle('processed-image-1', 'fixture-image', snapshot), undefined);
		assert.equal(released.length, scenario.expected === 'normalization-failed' ? 0 : 1);
	}));

	const captures = captureStore();
	const abortController = new AbortController();
	let finish;
	const released = [];
	const store = new ProcessedMessengerImageStore(
		captures,
		() => true,
		async () => new Promise(resolve => {
			finish = () => resolve({
				bytes: new Uint8Array([1, 2, 3]),
				height: 2,
				mimeType: 'image/png',
				width: 4,
			});
		}),
		bytes => released.push([...bytes]),
	);
	const pending = store.normalize('image-capture-1', 'fixture-image', snapshot, abortController.signal);
	await new Promise(setImmediate);
	abortController.abort();
	finish();
	assert.deepEqual(await pending, {reason: 'aborted', status: 'unavailable'});
	assert.equal(captures.releases, 1);
	assert.deepEqual(released, [[0, 0, 0]]);
});

test('conversation changes stale handoff and explicit cleanup release processed bytes exactly once', async () => {
	let current = true;
	const captures = captureStore();
	const released = [];
	const store = new ProcessedMessengerImageStore(
		captures,
		() => current,
		async () => ({
			bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]),
			height: 2,
			mimeType: 'image/png',
			width: 4,
		}),
		bytes => released.push([...bytes]),
	);
	const result = await store.normalize(
		'image-capture-1',
		'fixture-image',
		snapshot,
		new AbortController().signal,
	);
	assert.equal(result.status, 'processed');
	current = false;
	assert.equal(store.describeHandle(result.handleId, result.messageId, snapshot), undefined);
	await assert.rejects(
		store.withProcessedImage(result.handleId, result.messageId, snapshot, async () => undefined),
		/Rejected stale processed Messenger image/,
	);
	assert.equal(store.releaseHandle(result.handleId), false);
	store.releaseAll();
	assert.equal(released.length, 2);
	assert.equal(released.every(bytes => bytes.every(byte => byte === 0)), true);
});

test('aborting after normalization discards the processed handle before handoff', async () => {
	const captures = captureStore();
	const abortController = new AbortController();
	const released = [];
	const store = new ProcessedMessengerImageStore(
		captures,
		() => true,
		async () => ({
			bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]),
			height: 2,
			mimeType: 'image/png',
			width: 4,
		}),
		bytes => released.push([...bytes]),
	);
	const result = await store.normalize(
		'image-capture-1',
		'fixture-image',
		snapshot,
		abortController.signal,
	);
	assert.equal(result.status, 'processed');
	abortController.abort();
	assert.equal(store.describeHandle(result.handleId, result.messageId, snapshot), undefined);
	await assert.rejects(
		store.withProcessedImage(result.handleId, result.messageId, snapshot, async () => undefined),
		/Rejected stale processed Messenger image/,
	);
	assert.equal(released.length, 2);
	assert.equal(released.every(bytes => bytes.every(byte => byte === 0)), true);
});
