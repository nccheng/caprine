/* eslint-disable camelcase, unicorn/prefer-event-target */
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {mkdtemp, readdir, writeFile} = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {PassThrough} = require('node:stream');
const test = require('node:test');
const {
	BoundedProcessRunner,
	allowedVideoInputFormats,
	findMacVideoTools,
	maximumVideoDurationSeconds,
	parseFfprobeMetadata,
	VideoAudioExtractor,
	VideoMetadataInspector,
	VideoToolError,
} = require('../dist-js/video-toolchain.js');

function expectCode(promise, code) {
	return assert.rejects(promise, error => {
		assert.ok(error instanceof VideoToolError);
		assert.equal(error.code, code);
		return true;
	});
}

function fakeChildProcess(onSpawn) {
	const child = new EventEmitter();
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.kills = [];
	child.kill = signal => {
		child.kills.push(signal);
		return true;
	};

	setImmediate(() => {
		onSpawn(child);
	});
	return child;
}

function validProbe(overrides = {}) {
	return JSON.stringify({
		format: {
			duration: '12.5',
			format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
			...overrides.format,
		},
		streams: overrides.streams ?? [
			{
				avg_frame_rate: '30000/1001',
				codec_name: 'h264',
				codec_type: 'video',
				height: 1080,
				width: 1920,
			},
			{codec_name: 'aac', codec_type: 'audio'},
		],
	});
}

test('macOS video tool discovery searches PATH before common Homebrew locations and requires a pair', async () => {
	const pathAttempts = [];
	const fromPath = await findMacVideoTools({
		async accessImplementation(filePath) {
			pathAttempts.push(filePath);
			if (!filePath.startsWith('/custom/bin/')) {
				throw new Error('missing');
			}
		},
		pathValue: 'relative:/custom/bin',
	});
	assert.deepEqual(fromPath, {
		ffmpeg: '/custom/bin/ffmpeg',
		ffprobe: '/custom/bin/ffprobe',
	});
	assert.equal(pathAttempts.some(filePath => filePath.startsWith('relative/')), false);

	const fromHomebrew = await findMacVideoTools({
		async accessImplementation(filePath) {
			if (!filePath.startsWith('/opt/homebrew/bin/')) {
				throw new Error('missing');
			}
		},
		pathValue: '/partial',
	});
	assert.deepEqual(fromHomebrew, {
		ffmpeg: '/opt/homebrew/bin/ffmpeg',
		ffprobe: '/opt/homebrew/bin/ffprobe',
	});
	const splitPath = await findMacVideoTools({
		async accessImplementation(filePath) {
			if (filePath !== '/ffmpeg-only/ffmpeg' && filePath !== '/ffprobe-only/ffprobe') {
				throw new Error('missing');
			}
		},
		pathValue: '/ffmpeg-only:/ffprobe-only',
	});
	assert.deepEqual(splitPath, {
		ffmpeg: '/ffmpeg-only/ffmpeg',
		ffprobe: '/ffprobe-only/ffprobe',
	});

	await expectCode(findMacVideoTools({
		async accessImplementation() {
			throw new Error('missing');
		},
		pathValue: '',
	}), 'tools-unavailable');
});

test('bounded process runner uses no shell and returns bounded output', async () => {
	let captured;
	const runner = new BoundedProcessRunner({
		spawnImplementation(executable, arguments_, options) {
			captured = {arguments_, executable, options};
			return fakeChildProcess(child => {
				child.stdout.end('{"ok":true}');
				child.stderr.end('notice');
				child.emit('close', 0);
			});
		},
		timeoutMilliseconds: 100,
	});
	const result = await runner.run('/opt/homebrew/bin/ffprobe', ['-v', 'error']);
	assert.deepEqual(result, {stderr: 'notice', stdout: '{"ok":true}'});
	assert.equal(captured.executable, '/opt/homebrew/bin/ffprobe');
	assert.deepEqual(captured.arguments_, ['-v', 'error']);
	assert.equal(captured.options.shell, false);
	assert.deepEqual(captured.options.stdio, ['ignore', 'pipe', 'pipe']);
});

test('bounded process runner terminates oversized, timed-out, and canceled work and maps nonzero exit', async () => {
	let oversizedChild;
	const oversized = new BoundedProcessRunner({
		maximumOutputBytes: 4,
		spawnImplementation() {
			oversizedChild = fakeChildProcess(child => {
				child.stdout.write('12345');
			});
			return oversizedChild;
		},
		timeoutMilliseconds: 100,
	});
	await expectCode(oversized.run('/tool', []), 'output-too-large');
	assert.deepEqual(oversizedChild.kills, ['SIGKILL']);

	let timeoutChild;
	const timed = new BoundedProcessRunner({
		spawnImplementation() {
			timeoutChild = fakeChildProcess(() => {});
			return timeoutChild;
		},
		timeoutMilliseconds: 5,
	});
	await expectCode(timed.run('/tool', []), 'timeout');
	assert.deepEqual(timeoutChild.kills, ['SIGKILL']);

	let canceledChild;
	const cancellation = new AbortController();
	const canceled = new BoundedProcessRunner({
		spawnImplementation() {
			canceledChild = fakeChildProcess(() => {});
			return canceledChild;
		},
		timeoutMilliseconds: 100,
	});
	const cancellationResult = canceled.run('/tool', [], cancellation.signal);
	cancellation.abort();
	await expectCode(cancellationResult, 'cancelled');
	assert.deepEqual(canceledChild.kills, ['SIGKILL']);

	const failed = new BoundedProcessRunner({
		spawnImplementation() {
			return fakeChildProcess(child => {
				child.stderr.end('/private/source/video.mp4: corrupt');
				child.emit('close', 2);
			});
		},
		timeoutMilliseconds: 100,
	});
	await assert.rejects(failed.run('/tool', []), error => {
		assert.ok(error instanceof VideoToolError);
		assert.equal(error.code, 'process-failed');
		assert.equal(error.exitCode, 2);
		assert.equal(error.message.includes('/private/source'), false);
		return true;
	});

	const spawnFailed = new BoundedProcessRunner({
		spawnImplementation() {
			return fakeChildProcess(child => {
				child.emit('error', new Error('/private/tool path'));
			});
		},
		timeoutMilliseconds: 100,
	});
	await assert.rejects(spawnFailed.run('/tool', []), error => {
		assert.ok(error instanceof VideoToolError);
		assert.equal(error.code, 'process-failed');
		assert.equal(error.exitCode, undefined);
		assert.equal(error.message.includes('/private/tool'), false);
		return true;
	});
});

test('ffprobe parser normalizes bounded audio-bearing and silent video metadata', () => {
	assert.deepEqual(parseFfprobeMetadata(validProbe()), {
		audioTrackAvailable: true,
		container: 'mov,mp4,m4a,3gp,3g2,mj2',
		durationSeconds: 12.5,
		frameRate: 30_000 / 1001,
		height: 1080,
		videoCodec: 'h264',
		width: 1920,
	});
	const silent = parseFfprobeMetadata(validProbe({
		streams: [{
			avg_frame_rate: '24/1',
			codec_name: 'hevc',
			codec_type: 'video',
			height: 720,
			width: 1280,
		}],
	}));
	assert.equal(silent.audioTrackAvailable, false);
});

test('ffprobe parser rejects malformed, non-finite, unsupported, and out-of-range metadata', () => {
	for (const [serialized, code] of [
		['not-json', 'malformed-metadata'],
		[JSON.stringify({format: {}, streams: []}), 'malformed-metadata'],
		[validProbe({streams: [{codec_name: 'aac', codec_type: 'audio'}]}), 'unsupported-video'],
		[validProbe({format: {duration: 'NaN'}}), 'malformed-metadata'],
		[validProbe({format: {duration: String(maximumVideoDurationSeconds + 1)}}), 'malformed-metadata'],
		[validProbe({
			streams: [{
				avg_frame_rate: '30/0',
				codec_name: 'h264',
				codec_type: 'video',
				height: 1080,
				width: 1920,
			}],
		}), 'malformed-metadata'],
	]) {
		assert.throws(
			() => parseFfprobeMetadata(serialized),
			error => error instanceof VideoToolError && error.code === code,
		);
	}
});

test('metadata inspector emits only fixed phases and invokes ffprobe with fixed arguments', async () => {
	const phases = [];
	let invocation;
	const inspector = new VideoMetadataInspector({
		async run(executable, arguments_, signal) {
			invocation = {arguments_, executable, signal};
			return {stderr: '', stdout: validProbe()};
		},
	}, async () => ({
		ffmpeg: '/opt/homebrew/bin/ffmpeg',
		ffprobe: '/opt/homebrew/bin/ffprobe',
	}));
	const cancellation = new AbortController();
	await inspector.inspect('/private/tmp/caprine-media/video.mp4', {
		onPhase(phase) {
			phases.push(phase);
		},
		signal: cancellation.signal,
	});
	assert.deepEqual(phases, ['checking-tools', 'inspecting-metadata']);
	assert.equal(invocation.executable, '/opt/homebrew/bin/ffprobe');
	assert.equal(invocation.signal, cancellation.signal);
	assert.deepEqual(invocation.arguments_, [
		'-v',
		'error',
		'-protocol_whitelist',
		'file',
		'-format_whitelist',
		allowedVideoInputFormats,
		'-print_format',
		'json',
		'-show_format',
		'-show_streams',
		'/private/tmp/caprine-media/video.mp4',
	]);
	for (const forbiddenFormat of ['concat', 'dash', 'hls', 'webm_dash_manifest']) {
		assert.equal(allowedVideoInputFormats.split(',').includes(forbiddenFormat), false);
	}

	await expectCode(inspector.inspect('relative.mp4'), 'unsupported-video');
	cancellation.abort();
	await expectCode(inspector.inspect('/private/tmp/video.mp4', {signal: cancellation.signal}), 'cancelled');
});

test('metadata inspector distinguishes corrupt input from tool start failure', async () => {
	const tools = async () => ({
		ffmpeg: '/opt/homebrew/bin/ffmpeg',
		ffprobe: '/opt/homebrew/bin/ffprobe',
	});
	const corrupt = new VideoMetadataInspector({
		async run() {
			throw new VideoToolError('process-failed', 'sanitized failure', 2);
		},
	}, tools);
	await expectCode(corrupt.inspect('/private/tmp/corrupt.mp4'), 'unsupported-video');

	const unavailableTool = new VideoMetadataInspector({
		async run() {
			throw new VideoToolError('process-failed', 'sanitized failure');
		},
	}, tools);
	await expectCode(unavailableTool.inspect('/private/tmp/video.mp4'), 'process-failed');
});

test('video audio extractor uses fixed bounded ffmpeg arguments and removes its owned output', async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'caprine-video-audio-test-'));
	const inputPath = path.join(directory, 'source.mp4');
	await writeFile(inputPath, new Uint8Array([1, 2, 3]));
	const phases = [];
	let invocation;
	const extractor = new VideoAudioExtractor({
		async inspect(_filePath, options) {
			options.onPhase('checking-tools');
			options.onPhase('inspecting-metadata');
			return {
				audioTrackAvailable: true,
				container: 'mov',
				durationSeconds: 12.5,
				frameRate: 30,
				height: 720,
				videoCodec: 'h264',
				width: 1280,
			};
		},
	}, {
		async run(executable, arguments_, signal) {
			invocation = {arguments_, executable, signal};
			await writeFile(arguments_.at(-1), new Uint8Array([9, 8, 7]));
			return {stderr: '', stdout: ''};
		},
	}, async () => ({ffmpeg: '/opt/homebrew/bin/ffmpeg', ffprobe: '/opt/homebrew/bin/ffprobe'}));
	const cancellation = new AbortController();
	const result = await extractor.extract(inputPath, {
		onPhase: phase => phases.push(phase),
		signal: cancellation.signal,
	});

	assert.deepEqual(phases, ['checking-tools', 'inspecting-metadata', 'extracting-audio']);
	assert.deepEqual(result, {
		audioTrackAvailable: true,
		bytes: new Uint8Array([9, 8, 7]),
		durationSeconds: 12.5,
		mimeType: 'audio/mpeg',
	});
	assert.equal(invocation.executable, '/opt/homebrew/bin/ffmpeg');
	assert.equal(invocation.signal, cancellation.signal);
	assert.deepEqual(invocation.arguments_.slice(0, -1), [
		'-nostdin',
		'-v',
		'error',
		'-protocol_whitelist',
		'file',
		'-format_whitelist',
		allowedVideoInputFormats,
		'-i',
		inputPath,
		'-map',
		'0:a:0',
		'-vn',
		'-ac',
		'1',
		'-ar',
		'16000',
		'-b:a',
		'64k',
		'-t',
		'300',
		'-f',
		'mp3',
	]);
	assert.equal(path.dirname(invocation.arguments_.at(-1)), directory);
	assert.deepEqual(await readdir(directory), ['source.mp4']);
});

test('video audio extractor reports silent video without starting ffmpeg', async () => {
	let processCalls = 0;
	const extractor = new VideoAudioExtractor({
		async inspect() {
			return {
				audioTrackAvailable: false,
				container: 'webm',
				durationSeconds: 3,
				frameRate: 24,
				height: 720,
				videoCodec: 'vp9',
				width: 1280,
			};
		},
	}, {
		async run() {
			processCalls += 1;
			throw new Error('unexpected process');
		},
	});
	assert.deepEqual(await extractor.extract('/private/tmp/caprine-video.webm'), {
		audioTrackAvailable: false,
		durationSeconds: 3,
	});
	assert.equal(processCalls, 0);
});
