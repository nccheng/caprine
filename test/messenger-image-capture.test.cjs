const assert = require('node:assert/strict');
const test = require('node:test');
const {
	captureMessengerImagePixels,
	maximumMessengerImageCaptureDimension,
	MessengerImageCaptureStore,
	resolveMessengerImageCaptureTarget,
	validateMessengerImageCaptureRectangle,
} = require('../dist-js/messenger-image-capture.js');
const {
	loadMessengerContextFixture,
	MessengerContextFixtureElement,
} = require('./helpers/messenger-context-fixture.cjs');

const snapshot = {
	captureGeneration: 4,
	conversationId: 'messenger-thread:fixture',
	messengerWebContentsId: 8,
	sessionId: 'ai-session-2',
};

const viewport = {height: 600, width: 800};

function availableTarget(overrides = {}) {
	return {
		conversationId: snapshot.conversationId,
		messageId: 'fixture-incoming-2',
		rectangle: {
			height: 180, width: 320, x: 40, y: 80,
		},
		status: 'available',
		targetToken: 'target-1',
		viewport,
		...overrides,
	};
}

function nativePage(bytes = Buffer.alloc(320 * 180 * 4, 7)) {
	const rectangles = [];
	return {
		page: {
			async capturePage(rectangle) {
				rectangles.push(rectangle);
				return {
					getSize: () => ({height: 180, width: 320}),
					isEmpty: () => false,
					toBitmap: () => bytes,
				};
			},
			id: snapshot.messengerWebContentsId,
		},
		rectangles,
	};
}

test('image capture geometry clamps partial visibility and rejects invalid or oversized targets', () => {
	assert.deepEqual(
		validateMessengerImageCaptureRectangle(
			{
				height: 101.2, width: 201.2, x: -10.4, y: 550.1,
			},
			viewport,
		),
		{
			rectangle: {
				height: 50, width: 191, x: 0, y: 550,
			}, status: 'available',
		},
	);
	assert.deepEqual(
		validateMessengerImageCaptureRectangle({
			height: 20, width: 20, x: 900, y: 10,
		}, viewport),
		{reason: 'out-of-bounds', status: 'unavailable'},
	);
	assert.deepEqual(
		validateMessengerImageCaptureRectangle({
			height: 0, width: 20, x: 1, y: 1,
		}, viewport),
		{reason: 'out-of-bounds', status: 'unavailable'},
	);
	assert.deepEqual(
		validateMessengerImageCaptureRectangle(
			{
				height: maximumMessengerImageCaptureDimension + 1, width: 10, x: 0, y: 0,
			},
			{height: 10_000, width: 10_000},
		),
		{reason: 'oversized-target', status: 'unavailable'},
	);
});

test('sanitized live-like fixture resolves one identity-bound visible image without URLs or DOM', () => {
	const fixture = loadMessengerContextFixture('supported-messages.json');
	const resolution = resolveMessengerImageCaptureTarget(
		fixture.root,
		'fixture-incoming-2',
		snapshot.conversationId,
		viewport,
	);

	assert.equal(resolution.status, 'available');
	assert.deepEqual(resolution.rectangle, {
		height: 180, width: 320, x: 40, y: 80,
	});
	assert.equal(resolution.messageId, 'fixture-incoming-2');
	assert.match(resolution.targetToken, /^messenger-image-target-\d+$/);
	assert.equal(Object.hasOwn(resolution, 'url'), false);
	assert.equal(Object.values(resolution).some(value => value instanceof MessengerContextFixtureElement), false);
	const image = fixture.root.querySelector('img[alt]');
	image.currentSrc = 'https://www.facebook.invalid/private/source?token=redacted';
	const changedSource = resolveMessengerImageCaptureTarget(
		fixture.root,
		'fixture-incoming-2',
		snapshot.conversationId,
		viewport,
	);
	assert.equal(changedSource.status, 'available');
	assert.notEqual(changedSource.targetToken, resolution.targetToken);
	assert.equal(JSON.stringify(changedSource).includes('private/source'), false);
	assert.deepEqual(resolveMessengerImageCaptureTarget(
		fixture.root,
		'missing',
		snapshot.conversationId,
		viewport,
	), {
		reason: 'missing-target',
		status: 'unavailable',
	});
});

test('image target resolution fails closed for hidden detached and ambiguous images', () => {
	const rootWithImage = image => new MessengerContextFixtureElement({
		children: [{
			attributes: {'data-message-id': 'message-1'},
			children: [image],
		}],
		tag: 'document',
	});
	const rectangle = {
		height: 20, width: 20, x: 10, y: 10,
	};

	assert.deepEqual(resolveMessengerImageCaptureTarget(rootWithImage({
		attributes: {alt: 'Photo'},
		hidden: true,
		rectangle,
		tag: 'img',
	}), 'message-1', snapshot.conversationId, viewport), {reason: 'hidden-target', status: 'unavailable'});
	assert.deepEqual(resolveMessengerImageCaptureTarget(rootWithImage({
		attributes: {alt: 'Photo'},
		isConnected: false,
		rectangle,
		tag: 'img',
	}), 'message-1', snapshot.conversationId, viewport), {reason: 'detached-target', status: 'unavailable'});
	assert.deepEqual(resolveMessengerImageCaptureTarget(new MessengerContextFixtureElement({
		children: [{
			attributes: {'data-message-id': 'message-1'},
			children: [
				{attributes: {alt: 'Photo'}, rectangle, tag: 'img'},
				{attributes: {alt: 'Image'}, rectangle, tag: 'img'},
			],
		}],
		tag: 'document',
	}), 'message-1', snapshot.conversationId, viewport), {reason: 'ambiguous-target', status: 'unavailable'});
});

test('native capture receives only the validated rectangle and returns copied local pixels', async () => {
	const source = Buffer.alloc(8, 9);
	const page = {
		async capturePage(rectangle) {
			assert.deepEqual(rectangle, {
				height: 1, width: 2, x: 3, y: 4,
			});
			return {
				getSize: () => ({height: 1, width: 2}),
				isEmpty: () => false,
				toBitmap: () => source,
			};
		},
		id: snapshot.messengerWebContentsId,
	};
	const capture = await captureMessengerImagePixels(page, {
		height: 1, width: 2, x: 3, y: 4,
	});

	assert.deepEqual(capture, {bytes: new Uint8Array(8).fill(9), height: 1, width: 2});
	source.fill(1);
	assert.deepEqual(capture.bytes, new Uint8Array(8).fill(9));
});

test('capture store binds pixels to current identity and releases once after transfer', async () => {
	const {page, rectangles} = nativePage();
	const released = [];
	const store = new MessengerImageCaptureStore(
		async () => availableTarget(),
		page,
		candidate => candidate.conversationId === snapshot.conversationId,
		bytes => released.push([...bytes]),
	);
	const result = await store.capture('fixture-incoming-2', snapshot, new AbortController().signal);

	assert.equal(result.status, 'captured');
	assert.deepEqual(rectangles, [{
		height: 180, width: 320, x: 40, y: 80,
	}]);
	assert.deepEqual(store.describeHandle(result.handleId, result.messageId, snapshot), result);
	const transferred = await store.withCapture(
		result.handleId,
		result.messageId,
		snapshot,
		async (bytes, description) => ({
			byteLength: bytes.byteLength,
			handleId: description.handleId,
			initialByte: bytes[0],
		}),
	);
	assert.deepEqual(transferred, {
		byteLength: 320 * 180 * 4,
		handleId: result.handleId,
		initialByte: 7,
	});
	assert.equal(released.length, 1);
	assert.equal(released[0].every(byte => byte === 0), true);
	assert.equal(store.releaseHandle(result.handleId), false);
});

test('replacement cancellation and conversation invalidation discard pixels fail closed', async () => {
	await Promise.all([
		{expected: 'replaced-target', targets: [availableTarget(), availableTarget({targetToken: 'target-2'})]},
		{expected: 'missing-target', targets: [availableTarget(), {reason: 'missing-target', status: 'unavailable'}]},
	].map(async scenario => {
		const bytes = Buffer.alloc(320 * 180 * 4, 5);
		const {page} = nativePage(bytes);
		const released = [];
		const targets = [...scenario.targets];
		const store = new MessengerImageCaptureStore(
			async () => targets.shift(),
			page,
			() => true,
			value => released.push([...value]),
		);

		assert.deepEqual(
			await store.capture('fixture-incoming-2', snapshot, new AbortController().signal),
			{reason: scenario.expected, status: 'unavailable'},
		);
		assert.equal(released.length, 1);
		assert.equal(released[0].every(byte => byte === 0), true);
	}));

	const abortController = new AbortController();
	let finishCapture;
	const page = {
		capturePage: async () => new Promise(resolve => {
			finishCapture = () => resolve({
				getSize: () => ({height: 1, width: 1}),
				isEmpty: () => false,
				toBitmap: () => Buffer.alloc(4, 2),
			});
		}),
		id: snapshot.messengerWebContentsId,
	};
	const released = [];
	const store = new MessengerImageCaptureStore(
		async () => availableTarget(),
		page,
		() => true,
		value => released.push([...value]),
	);
	const pending = store.capture('fixture-incoming-2', snapshot, abortController.signal);
	await new Promise(setImmediate);
	abortController.abort();
	finishCapture();
	assert.deepEqual(await pending, {reason: 'aborted', status: 'unavailable'});
	assert.deepEqual(released, [[0, 0, 0, 0]]);

	const staleStore = new MessengerImageCaptureStore(
		async () => availableTarget(),
		nativePage().page,
		() => false,
	);
	assert.deepEqual(
		await staleStore.capture('fixture-incoming-2', snapshot, new AbortController().signal),
		{reason: 'conversation-changed', status: 'unavailable'},
	);

	const wrongPage = nativePage();
	wrongPage.page.id += 1;
	const wrongPageStore = new MessengerImageCaptureStore(
		async () => availableTarget(),
		wrongPage.page,
		() => true,
	);
	assert.deepEqual(
		await wrongPageStore.capture('fixture-incoming-2', snapshot, new AbortController().signal),
		{reason: 'conversation-changed', status: 'unavailable'},
	);
	assert.deepEqual(wrongPage.rectangles, []);

	const wrongConversationStore = new MessengerImageCaptureStore(
		async () => availableTarget({conversationId: 'messenger-thread:other'}),
		nativePage().page,
		() => true,
	);
	assert.deepEqual(
		await wrongConversationStore.capture('fixture-incoming-2', snapshot, new AbortController().signal),
		{reason: 'conversation-changed', status: 'unavailable'},
	);
});

test('target resolver exceptions become typed failures and never leak captured bytes', async () => {
	let resolutionCount = 0;
	const released = [];
	const store = new MessengerImageCaptureStore(
		async () => {
			resolutionCount += 1;
			if (resolutionCount === 2) {
				throw new Error('fixture resolver failed');
			}

			return availableTarget();
		},
		nativePage(Buffer.alloc(320 * 180 * 4, 6)).page,
		() => true,
		bytes => released.push([...bytes]),
	);
	assert.deepEqual(
		await store.capture('fixture-incoming-2', snapshot, new AbortController().signal),
		{reason: 'capture-failed', status: 'unavailable'},
	);
	assert.equal(released.length, 1);
	assert.equal(released[0].every(byte => byte === 0), true);

	const initialFailure = new MessengerImageCaptureStore(
		async () => {
			throw new Error('fixture resolver failed');
		},
		nativePage().page,
		() => true,
	);
	assert.deepEqual(
		await initialFailure.capture('fixture-incoming-2', snapshot, new AbortController().signal),
		{reason: 'capture-failed', status: 'unavailable'},
	);
});

test('explicit cleanup releases every retained capture exactly once', async () => {
	const released = [];
	const store = new MessengerImageCaptureStore(
		async () => availableTarget(),
		nativePage().page,
		() => true,
		bytes => released.push(bytes.byteLength),
	);
	const first = await store.capture('fixture-incoming-2', snapshot, new AbortController().signal);
	const second = await store.capture('fixture-incoming-2', snapshot, new AbortController().signal);
	assert.equal(first.status, 'captured');
	assert.equal(second.status, 'captured');

	store.releaseAll();
	store.releaseAll();
	assert.deepEqual(released, [320 * 180 * 4, 320 * 180 * 4]);
});
