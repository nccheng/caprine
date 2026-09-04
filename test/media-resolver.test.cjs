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

test('Facebook Reel pages omit credentials before authenticated bounded media resolution', async () => {
	const directory = await fixtureDirectory();
	const diagnostics = [];
	const requests = [];
	const reelId = '1744555046768453';
	const directUrl = 'https://video.xx.fbcdn.net/reel-fixture.mp4?token=private';
	const html = `<html><script type="application/json">{"video_id":"${reelId}","browser_native_hd_url":"${directUrl}"}</script></html>`;
	const resolver = new MessengerMediaResolver(directory, async (url, init) => {
		requests.push({init, url});
		if (requests.length === 1) {
			return new Response(null, {
				headers: {location: `https://m.facebook.com/reel/${reelId}/?mibextid=fixture`},
				status: 302,
			});
		}

		if (requests.length === 2) {
			return new Response(html, {
				headers: {'content-length': String(Buffer.byteLength(html)), 'content-type': 'text/html; charset=utf-8'},
				status: 200,
			});
		}

		return new Response(new Uint8Array([1, 2, 3, 4]), {
			headers: {'content-length': '4', 'content-type': 'video/mp4'},
			status: 200,
		});
	}, diagnostic => diagnostics.push(diagnostic));

	const media = await resolver.resolveFacebookReel(
		`http://facebook.com/reel/${reelId}/?tracking=removed`,
		'message-reel',
		snapshot,
		6,
	);
	assert.deepEqual(requests.map(request => request.url), [
		`https://m.facebook.com/watch/?v=${reelId}`,
		`https://m.facebook.com/reel/${reelId}/?mibextid=fixture`,
		directUrl,
	]);
	assert.equal(requests.slice(0, 2).every(request => request.init.credentials === 'omit'), true);
	assert.equal(requests[2].init.credentials, 'include');
	assert.equal(requests.every(request => request.init.redirect === 'manual'), true);
	assert.deepEqual(requests[0].init.headers, {
		accept: 'text/html,application/xhtml+xml',
		'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
	});
	assert.deepEqual(requests[1].init.headers, requests[0].init.headers);
	assert.equal(requests[2].init.headers, undefined);
	assert.equal(media.kind, 'video');
	assert.equal(media.byteLength, 4);
	assert.equal(JSON.stringify(diagnostics).includes('private'), false);

	await resolver.withFile(media.handleId, 'message-reel', snapshot, async () => {});
	assert.deepEqual(await readdir(directory), []);
});

test('Reel introduction pages follow only same-video canonical pages before resolving bytes', async () => {
	const directory = await fixtureDirectory();
	const requests = [];
	const reelId = '1744555046768453';
	const canonical = `https://www.facebook.com/creator/videos/description/${reelId}/?tracking=private`;
	const resolver = new MessengerMediaResolver(directory, async (url, init) => {
		requests.push({url, init});
		if (requests.length === 1) {
			return new Response(`<meta content="${canonical}" property="og:url">`, {headers: {'content-type': 'text/html'}});
		}

		if (requests.length === 2) {
			return new Response(`{"video_id":"${reelId}","playable_url":"https://video.xx.fbcdn.net/reel.mp4"}`, {headers: {'content-type': 'text/html'}});
		}

		return new Response(new Uint8Array([1, 2, 3]), {headers: {'content-type': 'video/mp4'}});
	});
	const media = await resolver.resolveFacebookReel(`https://www.facebook.com/reel/${reelId}`, 'reel', snapshot);
	assert.equal(media.byteLength, 3);
	assert.equal(requests[1].url, `https://www.facebook.com/creator/videos/${reelId}/`);
	assert.match(requests[1].init.headers['user-agent'], /Macintosh/);
	assert.ok(requests.slice(0, 2).every(({init}) => init.credentials === 'omit'));
	await resolver.releaseAll();
});

test('Reel page redirects accept same-ID creator videos and reject wrong targets without fetching them', async () => {
	const reelId = '1744555046768453';
	for (const target of [
		`https://m.facebook.com/creator/videos/${reelId}/`,
		'https://m.facebook.com/creator/videos/9999999999/',
		`https://evil.example/creator/videos/${reelId}/`,
		`https://user:secret@m.facebook.com/creator/videos/${reelId}/`,
	]) {
		// eslint-disable-next-line no-await-in-loop
		const directory = await fixtureDirectory();
		const requests = [];
		const resolver = new MessengerMediaResolver(directory, async url => {
			requests.push(url);
			return requests.length === 1
				? new Response(null, {status: 302, headers: {location: target}})
				: new Response('<html>No media</html>', {headers: {'content-type': 'text/html'}});
		});
		// eslint-disable-next-line no-await-in-loop
		await assert.rejects(resolver.resolveFacebookReel(`https://www.facebook.com/reel/${reelId}`, 'reel', snapshot), {code: 'unsupported-source'});
		assert.equal(requests.length, target === `https://m.facebook.com/creator/videos/${reelId}/` ? 2 : 1);
	}
});

test('Reel canonical cycles and mixed page chains remain bounded', async () => {
	const directory = await fixtureDirectory();
	const reelId = '1744555046768453';
	for (const cycle of [true, false]) {
		let requests = 0;
		const resolver = new MessengerMediaResolver(directory, async () => {
			requests++;
			const creator = cycle ? 'creator' : `creator${requests}`;
			return new Response(`<link rel='canonical' href='https://m.facebook.com/${creator}/videos/${reelId}/'>`, {headers: {'content-type': 'text/html'}});
		});
		// eslint-disable-next-line no-await-in-loop
		await assert.rejects(resolver.resolveFacebookReel(`https://www.facebook.com/reel/${reelId}`, 'reel', snapshot), {code: 'unsupported-source'});
		assert.equal(requests, cycle ? 2 : 4);
	}
});

test('Facebook Reel resolution fails closed for login redirects and unbound page media', async () => {
	const directory = await fixtureDirectory();
	const reelUrl = 'https://www.facebook.com/reel/1744555046768453';
	const loginRedirect = new MessengerMediaResolver(directory, async () => new Response(null, {
		headers: {location: 'https://www.facebook.com/login/'},
		status: 302,
	}));
	await assert.rejects(
		loginRedirect.resolveFacebookReel(reelUrl, 'message-reel', snapshot),
		error => error instanceof MediaResolverError && error.code === 'unsupported-source',
	);

	const wrongReelHtml = '{"video_id":"9999999999999999","playable_url":"https://video.xx.fbcdn.net/wrong.mp4"}';
	const wrongReel = new MessengerMediaResolver(directory, async () => new Response(wrongReelHtml, {
		headers: {'content-type': 'text/html'},
		status: 200,
	}));
	await assert.rejects(
		wrongReel.resolveFacebookReel(reelUrl, 'message-reel', snapshot),
		error => error instanceof MediaResolverError && error.code === 'unsupported-source',
	);

	const wrongMime = new MessengerMediaResolver(directory, async () => new Response('not a Reel page', {
		headers: {'content-type': 'application/json'},
		status: 200,
	}));
	await assert.rejects(
		wrongMime.resolveFacebookReel(reelUrl, 'message-reel', snapshot),
		error => error instanceof MediaResolverError && error.code === 'mime-mismatch',
	);
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
