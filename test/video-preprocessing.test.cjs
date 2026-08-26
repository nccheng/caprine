const assert = require('node:assert/strict');
const {mkdtemp, readdir, writeFile} = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
	adaptiveVideoSampleTimestamps,
	maximumVideoAnalysisFrames,
	parseShowInfoTimestamps,
	VideoFramePreprocessor,
	videoFrameSamplingBands,
} = require('../dist-js/video-preprocessing.js');
const {VideoToolError} = require('../dist-js/video-toolchain.js');

const tools = async () => ({
	ffmpeg: '/opt/homebrew/bin/ffmpeg',
	ffprobe: '/opt/homebrew/bin/ffprobe',
});

function metadata(overrides = {}) {
	return {
		audioTrackAvailable: true,
		container: 'mov',
		durationSeconds: 12,
		frameRate: 10,
		height: 720,
		videoCodec: 'h264',
		width: 1280,
		...overrides,
	};
}

function request(metadataOverrides = {}, transcript, sourceMessageId = 'message-video') {
	return {
		metadata: metadata(metadataOverrides),
		sourceMessageId,
		transcript: transcript ?? {status: 'no-audio'},
	};
}

function showInfo(timestamps) {
	return timestamps.map((timestamp, index) => `[Parsed_showinfo_1] n: ${index} pts: ${Math.round(timestamp * 1000)} pts_time:${timestamp} duration:1`).join('\n');
}

function selectFrameIndexes(arguments_) {
	const filter = arguments_[arguments_.indexOf('-vf') + 1];
	return [...filter.matchAll(/eq\(n\\,(\d+)\)/gu)].map(match => Number(match[1]));
}

function distinctSignature(index) {
	let state = ((index + 1) * 2_654_435_761) % 4_294_967_296;
	return Uint8Array.from({length: 64}, () => {
		state = ((state * 1_664_525) + 1_013_904_223) % 4_294_967_296;
		return state < 2_147_483_648 ? 0 : 255;
	});
}

async function fixtureRunner(options = {}) {
	const invocations = [];
	return {
		invocations,
		async run(executable, arguments_, signal) {
			invocations.push({arguments_, executable, signal});
			if (options.failOnCall === invocations.length) {
				throw options.failure ?? new VideoToolError('process-failed', 'sanitized failure');
			}

			if (arguments_.at(-1) === '-') {
				return {stderr: showInfo(options.sceneTimestamps ?? []), stdout: ''};
			}

			if (arguments_.at(-1).endsWith('signatures.gray')) {
				const count = Number(arguments_[arguments_.indexOf('-frames:v') + 1]);
				const signatureFactory = options.signatureFactory ?? distinctSignature;
				const bytes = new Uint8Array(count * 64);
				for (let index = 0; index < count; index += 1) {
					bytes.set(signatureFactory(index), index * 64);
				}

				await writeFile(arguments_.at(-1), bytes);
				return {stderr: '', stdout: ''};
			}

			const frameIndexes = selectFrameIndexes(arguments_);
			const outputPattern = arguments_.at(-1);
			await Promise.all(frameIndexes.map(async (_frameIndex, index) => {
				const output = outputPattern.replace('%03d', String(index + 1).padStart(3, '0'));
				await writeFile(output, Uint8Array.from([255, 216, index % 256, 255, 217]));
			}));

			if (options.afterExtraction) {
				options.afterExtraction();
			}

			return {stderr: showInfo(frameIndexes.map(index => index / (options.frameRate ?? 10))), stdout: ''};
		},
	};
}

async function withInput(callback) {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'caprine-video-frames-test-'));
	const filePath = path.join(directory, 'source.mp4');
	await writeFile(filePath, Uint8Array.from([1, 2, 3]));
	await callback({directory, filePath});
}

async function expectCode(promise, code) {
	await assert.rejects(promise, error => {
		assert.ok(error instanceof VideoToolError);
		assert.equal(error.code, code);
		assert.equal(error.message.includes('/private/'), false);
		return true;
	});
}

test('adaptive sampling follows the fixed duration bands and includes the closing boundary', () => {
	assert.deepEqual(videoFrameSamplingBands, [
		{endSeconds: 15, framesPerSecond: 4},
		{endSeconds: 60, framesPerSecond: 2},
		{endSeconds: 300, framesPerSecond: 1},
		{endSeconds: null, framesPerSecond: 0.5},
	]);
	const timestamps = adaptiveVideoSampleTimestamps(305);
	assert.deepEqual(timestamps.slice(0, 4), [0, 0.25, 0.5, 0.75]);
	assert.ok(timestamps.includes(15));
	assert.ok(timestamps.includes(15.5));
	assert.ok(timestamps.includes(60));
	assert.ok(timestamps.includes(61));
	assert.ok(timestamps.includes(300));
	assert.ok(timestamps.includes(302));
	assert.equal(timestamps.at(-1), 304.999);
});

test('showinfo parsing accepts bounded finite timestamps and rejects malformed values', () => {
	assert.deepEqual(parseShowInfoTimestamps(showInfo([0, 1.25, 9.5])), [0, 1.25, 9.5]);
	assert.throws(
		() => parseShowInfoTimestamps('[showinfo] pts_time:-1'),
		error => error instanceof VideoToolError && error.code === 'process-failed',
	);
});

test('preprocessor assembles a bounded timestamped transcript artifact and cleans all derived files', async () => {
	await withInput(async ({directory, filePath}) => {
		const runner = await fixtureRunner({sceneTimestamps: [3, 8]});
		const progress = [];
		const preprocessor = new VideoFramePreprocessor(runner, tools);
		const artifact = await preprocessor.preprocess(filePath, request({}, {
			segments: [{endSeconds: 2, startSeconds: 1, text: '  Hello\r\nvideo  '}],
			status: 'completed',
		}, 'message-video-1'), {
			onProgress(value) {
				progress.push(value);
			},
		});

		assert.equal(artifact.coverage, 'balanced');
		assert.equal(artifact.frameCount, artifact.frameTimeline.length);
		assert.ok(artifact.frameCount <= maximumVideoAnalysisFrames);
		assert.deepEqual(artifact.transcript, {
			segments: [{endSeconds: 2, startSeconds: 1, text: 'Hello\nvideo'}],
			status: 'completed',
		});
		assert.ok(artifact.frameTimeline[0].reasons.includes('opening'));
		assert.ok(artifact.frameTimeline.at(-1).reasons.includes('closing'));
		assert.deepEqual(artifact.frameTimeline.filter(frame => frame.reasons.includes('scene-change')).map(frame => frame.timestampSeconds), [3, 8]);
		assert.ok(artifact.frameTimeline.every(frame => frame.mimeType === 'image/jpeg' && frame.sourceMessageId === 'message-video-1'));
		assert.ok(artifact.frameTimeline.every((frame, index) => index === 0 || frame.timestampSeconds > artifact.frameTimeline[index - 1].timestampSeconds));
		assert.deepEqual(await readdir(directory), ['source.mp4']);
		assert.deepEqual(progress.map(item => item.phase), [
			'checking-tools',
			'detecting-scenes',
			'detecting-scenes',
			'extracting-frames',
			'extracting-frames',
			'deduplicating-frames',
			'deduplicating-frames',
			'assembling-artifact',
		]);
		assert.equal(JSON.stringify(progress).includes('source.mp4'), false);
		assert.equal(JSON.stringify(progress).includes('Hello'), false);

		const [sceneInvocation, extractionInvocation, signatureInvocation] = runner.invocations;
		assert.ok(runner.invocations.every(invocation => invocation.executable === '/opt/homebrew/bin/ffmpeg'));
		assert.deepEqual(sceneInvocation.arguments_.slice(0, 12), [
			'-nostdin',
			'-v',
			'info',
			'-protocol_whitelist',
			'file',
			'-format_whitelist',
			'avi,flv,matroska,mov,mpeg,mpegts,ogg,webm',
			'-i',
			filePath,
			'-map',
			'0:v:0',
			'-vf',
		]);
		assert.ok(sceneInvocation.arguments_.includes('select=\'gt(scene\\,0.35)\',showinfo'));
		assert.equal(extractionInvocation.arguments_.includes('-fps_mode'), true);
		assert.equal(extractionInvocation.arguments_.includes('-q:v'), true);
		assert.equal(path.dirname(path.dirname(extractionInvocation.arguments_.at(-1))), directory);
		assert.equal(signatureInvocation.arguments_.at(-1).startsWith(directory), true);
	});
});

test('silent long video is sparse, capped at 180 frames, and retains boundaries', async () => {
	await withInput(async ({directory, filePath}) => {
		const runner = await fixtureRunner({frameRate: 2});
		const artifact = await new VideoFramePreprocessor(runner, tools).preprocess(
			filePath,
			request({audioTrackAvailable: false, durationSeconds: 601, frameRate: 2}, {status: 'no-audio'}, 'message-video-long'),
		);
		assert.equal(artifact.coverage, 'sparse');
		assert.equal(artifact.frameCount, maximumVideoAnalysisFrames);
		assert.deepEqual(artifact.transcript, {status: 'no-audio'});
		assert.ok(artifact.frameTimeline[0].reasons.includes('opening'));
		assert.ok(artifact.frameTimeline.at(-1).reasons.includes('closing'));
		assert.deepEqual(await readdir(directory), ['source.mp4']);
	});
});

test('perceptual duplicate removal keeps opening, closing, and scene-change frames', async () => {
	await withInput(async ({filePath}) => {
		const runner = await fixtureRunner({
			sceneTimestamps: [3, 8],
			signatureFactory() {
				return new Uint8Array(64).fill(40);
			},
		});
		const artifact = await new VideoFramePreprocessor(runner, tools).preprocess(
			filePath,
			request({}, {status: 'no-audio'}, 'message-static'),
		);
		assert.equal(artifact.frameCount, 4);
		assert.deepEqual(artifact.frameTimeline.flatMap(frame => frame.reasons), ['opening', 'scene-change', 'scene-change', 'closing']);
	});
});

test('scene overflow fails closed before extraction and removes the owned directory', async () => {
	await withInput(async ({directory, filePath}) => {
		const runner = await fixtureRunner({sceneTimestamps: Array.from({length: 179}, (_, index) => index + 0.25)});
		await expectCode(new VideoFramePreprocessor(runner, tools).preprocess(
			filePath,
			request({durationSeconds: 200}, {status: 'no-audio'}, 'message-cuts'),
		), 'output-too-large');
		assert.equal(runner.invocations.length, 1);
		assert.deepEqual(await readdir(directory), ['source.mp4']);
	});
});

test('corrupt, timed-out, canceled, stale, and interrupted preprocessing are typed and cleaned', async () => {
	await Promise.all([
		[new VideoToolError('process-failed', 'sanitized', 2), 'unsupported-video'],
		[new VideoToolError('timeout', 'sanitized'), 'timeout'],
		[new VideoToolError('cancelled', 'sanitized'), 'cancelled'],
	].map(async ([failure, expectedCode]) => withInput(async ({directory, filePath}) => {
		const runner = await fixtureRunner({failOnCall: 2, failure});
		await expectCode(new VideoFramePreprocessor(runner, tools).preprocess(
			filePath,
			request({}, {status: 'no-audio'}, 'message-failure'),
		), expectedCode);
		assert.deepEqual(await readdir(directory), ['source.mp4']);
	})));

	await withInput(async ({directory, filePath}) => {
		let current = true;
		const runner = await fixtureRunner({
			afterExtraction() {
				current = false;
			},
		});
		await expectCode(new VideoFramePreprocessor(runner, tools).preprocess(
			filePath,
			request({}, {status: 'no-audio'}, 'message-stale'),
			{isCurrent: () => current},
		), 'stale-media');
		assert.deepEqual(await readdir(directory), ['source.mp4']);
	});

	const cancellation = new AbortController();
	cancellation.abort();
	await expectCode(new VideoFramePreprocessor({
		async run() {
			throw new Error('must not run');
		},
	}, tools).preprocess('/private/tmp/source.mp4', request({}, {status: 'no-audio'}, 'message-cancel'), {
		signal: cancellation.signal,
	}), 'cancelled');
});

test('invalid metadata, transcript, source message, and extracted timestamp order fail closed', async () => {
	const runner = await fixtureRunner();
	await expectCode(new VideoFramePreprocessor(runner, tools).preprocess(
		'/private/tmp/source.mp4',
		request({durationSeconds: Number.NaN}),
	), 'malformed-metadata');
	await expectCode(new VideoFramePreprocessor(runner, tools).preprocess(
		'/private/tmp/source.mp4',
		request({}, {segments: [{endSeconds: 13, startSeconds: 1, text: 'outside duration'}], status: 'completed'}),
	), 'malformed-metadata');
	await expectCode(new VideoFramePreprocessor(runner, tools).preprocess(
		'/private/tmp/source.mp4', request({}, {status: 'no-audio'}, 'bad\nmessage'),
	), 'malformed-metadata');
});
