const assert = require('node:assert/strict');
const {mkdtemp, readdir, writeFile} = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
	adaptiveVideoSampleTimestamps,
	maximumVideoAnalysisFrames,
	maximumVideoFocusedFrames,
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

function timestampFrame(timestamp) {
	return {pts: Math.round(timestamp * 1000), timestampSeconds: timestamp};
}

function showInfoFrames(frames) {
	return frames.map((frame, index) => `[Parsed_showinfo_1] n: ${index} pts: ${frame.pts} pts_time:${frame.timestampSeconds} duration:1`).join('\n');
}

function showInfo(timestamps) {
	return showInfoFrames(timestamps.map(timestamp => timestampFrame(timestamp)));
}

function samplingInterval(timestamp) {
	if (timestamp < 15) {
		return 0.25;
	}

	if (timestamp < 60) {
		return 0.5;
	}

	return timestamp < 300 ? 1 : 2;
}

function sampledTimestamps(durationSeconds, intervalMultiplier) {
	const planned = adaptiveVideoSampleTimestamps(durationSeconds);
	const selected = [];
	for (const timestamp of planned) {
		const interval = samplingInterval(timestamp);
		if (selected.length === 0 || timestamp - selected.at(-1) >= intervalMultiplier * interval) {
			selected.push(timestamp);
		}
	}

	return selected;
}

function selectFramePts(arguments_) {
	const filter = arguments_[arguments_.indexOf('-vf') + 1];
	return [...filter.matchAll(/eq\(pts\\,(\d+)\)/gu)].map(match => Number(match[1]));
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
	const timestampsByPts = new Map();
	const remember = frames => {
		for (const frame of frames) {
			timestampsByPts.set(frame.pts, frame.timestampSeconds);
		}

		return frames;
	};

	return {
		invocations,
		async run(executable, arguments_, signal) {
			invocations.push({arguments_, executable, signal});
			if (options.failOnCall === invocations.length) {
				throw options.failure ?? new VideoToolError('process-failed', 'sanitized failure');
			}

			if (arguments_.at(-1) === '-') {
				const filter = arguments_[arguments_.indexOf('-vf') + 1];
				let frames;
				if (filter.includes('gt(scene')) {
					frames = options.sceneFrames ?? (options.sceneTimestamps ?? []).map(timestamp => timestampFrame(timestamp));
				} else if (filter.includes('eq(n\\,0)')) {
					const durationSeconds = options.durationSeconds ?? 12;
					const frameRate = options.frameRate ?? 10;
					frames = options.boundaryFrames ?? [
						timestampFrame(0),
						timestampFrame(Math.max(0, durationSeconds - (1 / frameRate))),
					];
				} else {
					const match = /gte\(t-prev_selected_t\\,([\d.]+)\*/u.exec(filter);
					const intervalMultiplier = Number(match?.[1] ?? 1);
					frames = options.sampleFrames ?? sampledTimestamps(
						options.durationSeconds ?? 12,
						intervalMultiplier,
					).map(timestamp => timestampFrame(timestamp));
				}

				return {stderr: showInfoFrames(remember(frames)), stdout: ''};
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

			const framePts = selectFramePts(arguments_);
			const outputPattern = arguments_.at(-1);
			await Promise.all(framePts.map(async (_framePts, index) => {
				const output = outputPattern.replace('%03d', String(index + 1).padStart(3, '0'));
				await writeFile(output, Uint8Array.from([255, 216, index % 256, 255, 217]));
			}));

			if (options.afterExtraction) {
				options.afterExtraction();
			}

			return {
				stderr: showInfoFrames(framePts.map(pts => ({
					pts,
					timestampSeconds: timestampsByPts.get(pts) ?? (pts / 1000),
				}))),
				stdout: '',
			};
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
		() => parseShowInfoTimestamps('[showinfo] pts: -1 pts_time:-1'),
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

		const [sceneInvocation, boundaryInvocation, samplingInvocation, extractionInvocation, signatureInvocation] = runner.invocations;
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
		assert.ok(boundaryInvocation.arguments_[boundaryInvocation.arguments_.indexOf('-vf') + 1].includes('eq(n\\,0)'));
		assert.ok(samplingInvocation.arguments_[samplingInvocation.arguments_.indexOf('-vf') + 1].includes('prev_selected_t'));
		assert.equal(extractionInvocation.arguments_.includes('-fps_mode'), true);
		assert.equal(extractionInvocation.arguments_.includes('-q:v'), true);
		assert.equal(path.dirname(path.dirname(extractionInvocation.arguments_.at(-1))), directory);
		assert.equal(signatureInvocation.arguments_.at(-1).startsWith(directory), true);
	});
});

test('silent long video is sparse, capped at 180 frames, and retains boundaries', async () => {
	await withInput(async ({directory, filePath}) => {
		const runner = await fixtureRunner({
			durationSeconds: 601,
			frameRate: 2,
			sampleFrames: Array.from({length: 179}, (_, index) => timestampFrame((index + 1) * 600 / 180)),
		});
		const artifact = await new VideoFramePreprocessor(runner, tools).preprocess(
			filePath,
			request({audioTrackAvailable: false, durationSeconds: 601, frameRate: 2}, {status: 'no-audio'}, 'message-video-long'),
		);
		assert.equal(artifact.coverage, 'sparse');
		assert.equal(artifact.frameCount, maximumVideoAnalysisFrames);
		const extraction = runner.invocations.find(invocation => invocation.arguments_.at(-1).endsWith('%03d.jpg'));
		const filter = extraction.arguments_[extraction.arguments_.indexOf('-vf') + 1];
		let expression = /^select='([^']+)'/u.exec(filter)[1].replaceAll(/eq\(pts\\,\d+\)/gu, 'x');
		for (let depth = 0; depth < 8; depth += 1) {
			expression = expression.replaceAll('(x+x)', 'x');
		}

		assert.equal(expression, 'x', '180 frame choices must form a shallow balanced expression');
		assert.deepEqual(artifact.transcript, {status: 'no-audio'});
		assert.ok(artifact.frameTimeline[0].reasons.includes('opening'));
		assert.ok(artifact.frameTimeline.at(-1).reasons.includes('closing'));
		assert.deepEqual(await readdir(directory), ['source.mp4']);
	});
});

test('variable-frame-rate scene changes retain their exact presentation timestamp identity', async () => {
	await withInput(async ({filePath}) => {
		const runner = await fixtureRunner({
			boundaryFrames: [
				{pts: 1, timestampSeconds: 0},
				{pts: 900, timestampSeconds: 11.9},
			],
			sampleFrames: [],
			sceneFrames: [{pts: 123, timestampSeconds: 3}],
		});
		const artifact = await new VideoFramePreprocessor(runner, tools).preprocess(
			filePath,
			request({}, {status: 'no-audio'}, 'message-vfr'),
		);
		assert.deepEqual(
			artifact.frameTimeline.filter(frame => frame.reasons.includes('scene-change')).map(frame => frame.timestampSeconds),
			[3],
		);
		const extraction = runner.invocations.find(invocation => invocation.arguments_.at(-1).endsWith('%03d.jpg'));
		const filter = extraction.arguments_[extraction.arguments_.indexOf('-vf') + 1];
		assert.ok(filter.includes('eq(pts\\,123)'));
		assert.equal(filter.includes('eq(n\\,30)'), false);
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

test('final progress callbacks cannot return canceled or stale artifacts', async () => {
	await withInput(async ({directory, filePath}) => {
		const cancellation = new AbortController();
		const runner = await fixtureRunner();
		await expectCode(new VideoFramePreprocessor(runner, tools).preprocess(
			filePath,
			request({}, {status: 'no-audio'}, 'message-final-cancel'),
			{
				onProgress(progress) {
					if (progress.phase === 'assembling-artifact') {
						cancellation.abort();
					}
				},
				signal: cancellation.signal,
			},
		), 'cancelled');
		assert.deepEqual(await readdir(directory), ['source.mp4']);
	});

	await withInput(async ({directory, filePath}) => {
		let current = true;
		const runner = await fixtureRunner();
		await expectCode(new VideoFramePreprocessor(runner, tools).preprocess(
			filePath,
			request({}, {status: 'no-audio'}, 'message-final-stale'),
			{
				isCurrent: () => current,
				onProgress(progress) {
					if (progress.phase === 'assembling-artifact') {
						current = false;
					}
				},
			},
		), 'stale-media');
		assert.deepEqual(await readdir(directory), ['source.mp4']);
	});
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

test('focused extraction re-reads denser high-resolution frames only inside bounded pass-2 intervals', async () => {
	await withInput(async ({directory, filePath}) => {
		const invocations = [];
		const runner = {
			async run(executable, arguments_) {
				invocations.push({arguments_, executable});
				const outputPattern = arguments_.at(-1);
				for (const index of [0, 1, 2]) {
					// eslint-disable-next-line no-await-in-loop
					await writeFile(
						outputPattern.replace('%03d', String(index + 1).padStart(3, '0')),
						Uint8Array.from([255, 216, index, 255, 217]),
					);
				}

				return {stderr: showInfo([4.75, 5, 5.25]), stdout: ''};
			},
		};
		const frames = await new VideoFramePreprocessor(runner, tools).extractFocusedFrames(
			filePath,
			'message-video-focus',
			10,
			[{endSeconds: 5.5, startSeconds: 4.5}],
		);
		assert.deepEqual(frames.map(item => item.timestampSeconds), [4.75, 5, 5.25]);
		assert.ok(frames.every(item => item.sourceMessageId === 'message-video-focus'));
		const filter = invocations[0].arguments_[invocations[0].arguments_.indexOf('-vf') + 1];
		assert.match(filter, /^fps=4,select=/u);
		assert.match(filter, /scale=w='min\(1280\\,iw\)'/u);
		assert.equal(invocations[0].arguments_[invocations[0].arguments_.indexOf('-frames:v') + 1], String(maximumVideoFocusedFrames + 1));
		assert.deepEqual(await readdir(directory), ['source.mp4']);
	});
});
