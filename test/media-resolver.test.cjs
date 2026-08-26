const assert = require('node:assert/strict');
const {mkdtemp, readdir, writeFile} = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
	isAllowedMessengerMediaUrl,
	MediaResolverError,
	MessengerMediaResolver,
} = require('../dist-js/media-resolver.js');

const snapshot = {
	captureGeneration: 3,
	conversationId: 'messenger-thread:123',
	messengerWebContentsId: 7,
	sessionId: 'ai-session-2',
};

async function fixtureDirectory() {
	return mkdtemp(path.join(os.tmpdir(), 'caprine-media-test-'));
}

test('Messenger media URL allowlist is strict and HTTPS-only', () => {
	assert.equal(isAllowedMessengerMediaUrl('https://video.xx.fbcdn.net/file.mp4?token=secret'), true);
	assert.equal(isAllowedMessengerMediaUrl('https://www.facebook.com/media/file.mp4'), true);
	assert.equal(isAllowedMessengerMediaUrl('https://cdn.fbsbx.com/file.mp4'), true);
	assert.equal(isAllowedMessengerMediaUrl('http://video.xx.fbcdn.net/file.mp4'), false);
	assert.equal(isAllowedMessengerMediaUrl('https://fbcdn.net.evil.example/file.mp4'), false);
	assert.equal(isAllowedMessengerMediaUrl('https://user:secret@fbcdn.net/file.mp4'), false);
});

test('HTTPS media follows only allowlisted redirects and removes files after handoff', async () => {
	const directory = await fixtureDirectory();
	const diagnostics = [];
	const requests = [];
	const resolver = new MessengerMediaResolver(directory, async (url, init) => {
		requests.push({init, url});
		if (requests.length === 1) {
			return new Response(null, {headers: {location: 'https://video.xx.fbcdn.net/final'}, status: 302});
		}

		return new Response(new Uint8Array([1, 2, 3]), {
			headers: {'content-length': '3', 'content-type': 'video/mp4'},
			status: 200,
		});
	}, diagnostic => diagnostics.push(diagnostic));
	await resolver.cleanupRestartArtifacts();

	const media = await resolver.resolveHttps(
		'https://www.facebook.com/redirect',
		'video',
		'message-1',
		snapshot,
		2.5,
	);
	assert.equal(requests.every(request => request.init.method === 'GET'), true);
	assert.equal(requests.every(request => request.init.redirect === 'manual'), true);
	assert.equal(requests.every(request => request.init.credentials === 'include'), true);
	assert.deepEqual(diagnostics, [{
		byteLength: 3,
		durationSeconds: 2.5,
		kind: 'video',
		mimeType: 'video/mp4',
		outcome: 'ready',
		sourceType: 'https',
	}]);
	assert.equal(JSON.stringify(diagnostics).includes('secret'), false);

	let handedOffPath;
	await resolver.withFile(media.handleId, 'message-1', snapshot, async filePath => {
		handedOffPath = filePath;
		const entries = await readdir(directory);
		assert.equal(entries.length, 1);
	});
	assert.ok(handedOffPath);
	assert.deepEqual(await readdir(directory), []);
});

test('local inspection retains the exact handle until provider handoff', async () => {
	const directory = await fixtureDirectory();
	const resolver = new MessengerMediaResolver(directory, async () => new Response(new Uint8Array([1, 2, 3]), {
		headers: {'content-length': '3', 'content-type': 'audio/mp4'},
		status: 200,
	}));
	const media = await resolver.resolveHttps(
		'https://www.facebook.com/voice-message',
		'audio',
		'message-voice',
		snapshot,
	);

	await resolver.inspectFile(media.handleId, 'message-voice', snapshot, async filePath => {
		const entries = await readdir(directory);
		assert.equal(entries.includes(path.basename(filePath)), true);
	});
	assert.deepEqual(resolver.describeHandle(media.handleId, 'message-voice', snapshot), media);
	await resolver.withFile(media.handleId, 'message-voice', snapshot, async () => {});
	assert.deepEqual(await readdir(directory), []);
});

test('HTTPS media rejects external redirects, MIME mismatches, and oversized bodies', async () => {
	const directory = await fixtureDirectory();
	const external = new MessengerMediaResolver(directory, async () => new Response(null, {
		headers: {location: 'https://evil.example/file'},
		status: 302,
	}));
	await assert.rejects(
		external.resolveHttps('https://facebook.com/file', 'audio', 'message-1', snapshot),
		error => error instanceof MediaResolverError && error.code === 'unsupported-source',
	);

	const wrongMime = new MessengerMediaResolver(directory, async () => new Response(new Uint8Array([1]), {
		headers: {'content-type': 'text/html'},
		status: 200,
	}));
	await assert.rejects(
		wrongMime.resolveHttps('https://facebook.com/file', 'audio', 'message-1', snapshot),
		error => error instanceof MediaResolverError && error.code === 'mime-mismatch',
	);

	const oversized = new MessengerMediaResolver(directory, async () => new Response(new Uint8Array([1]), {
		headers: {'content-length': String(26 * 1024 * 1024), 'content-type': 'audio/mp4'},
		status: 200,
	}));
	await assert.rejects(
		oversized.resolveHttps('https://facebook.com/file', 'audio', 'message-1', snapshot),
		error => error instanceof MediaResolverError && error.code === 'oversized',
	);

	for (const response of [
		new Response(new Uint8Array([1, 2]), {
			headers: {'content-type': 'video/mp4'},
			status: 206,
		}),
		new Response(new Uint8Array([1, 2]), {
			headers: {'content-length': '1000', 'content-type': 'video/mp4'},
			status: 200,
		}),
	]) {
		const partial = new MessengerMediaResolver(directory, async () => response);
		// eslint-disable-next-line no-await-in-loop
		await assert.rejects(
			partial.resolveHttps('https://facebook.com/file', 'video', 'message-1', snapshot),
			error => error instanceof MediaResolverError && error.code === 'network',
		);
	}

	const timeout = new MessengerMediaResolver(directory, async (_url, init) => new Promise((_resolve, reject) => {
		init.signal.addEventListener('abort', () => {
			reject(new Error('aborted'));
		}, {once: true});
	}), () => undefined, 5);
	await assert.rejects(
		timeout.resolveHttps('https://facebook.com/file', 'audio', 'message-1', snapshot),
		error => error instanceof MediaResolverError && error.code === 'aborted',
	);
});

test('blob handles are conversation-bound and cleanup removes cancel and restart artifacts', async () => {
	const directory = await fixtureDirectory();
	const resolver = new MessengerMediaResolver(directory, async () => {
		throw new Error('unexpected fetch');
	});
	await resolver.cleanupRestartArtifacts();
	const media = await resolver.resolveBlob(
		new Uint8Array([4, 5, 6]).buffer,
		'audio/ogg; codecs=opus',
		'audio',
		'message-voice',
		snapshot,
	);
	await assert.rejects(
		resolver.resolveBlob(
			new ArrayBuffer(0),
			'audio/ogg',
			'audio',
			'message-empty',
			snapshot,
		),
		error => error instanceof MediaResolverError && error.code === 'network',
	);
	await assert.rejects(
		resolver.resolveBlob(
			new ArrayBuffer((25 * 1024 * 1024) + 1),
			'audio/ogg',
			'audio',
			'message-oversized',
			snapshot,
		),
		error => error instanceof MediaResolverError && error.code === 'oversized',
	);
	await assert.rejects(
		resolver.withFile(media.handleId, 'message-voice', {...snapshot, conversationId: 'messenger-thread:other'}, async () => {}),
		error => error instanceof MediaResolverError && error.code === 'stale-handle',
	);
	const entries = await readdir(directory);
	assert.equal(entries.length, 1);
	await resolver.releaseAll();
	assert.deepEqual(await readdir(directory), []);

	await writeFile(path.join(directory, 'orphan.mp4'), new Uint8Array([7]));
	await resolver.cleanupRestartArtifacts();
	assert.deepEqual(await readdir(directory), []);

	const resolving = resolver.resolveBlob(
		new Uint8Array([8, 9]).buffer,
		'audio/ogg',
		'audio',
		'message-cancelled',
		snapshot,
	);
	const cleanup = resolver.releaseAll();
	await assert.rejects(
		resolving,
		error => error instanceof MediaResolverError && error.code === 'aborted',
	);
	await cleanup;
	assert.deepEqual(await readdir(directory), []);
});
