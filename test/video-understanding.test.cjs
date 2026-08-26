const assert = require('node:assert/strict');
const test = require('node:test');
const {
	buildOpenAiVideoInput,
	OpenAiClient,
	OpenAiRequestError,
} = require('../dist-js/openai-client.js');
const {
	maximumVideoFocusedFrames,
	VideoUnderstandingService,
	videoTranscriptForReview,
} = require('../dist-js/video-understanding.js');

function frame(timestampSeconds, byte = 1) {
	return {
		bytes: Uint8Array.of(0xFF, 0xD8, byte, 0xFF, 0xD9),
		mimeType: 'image/jpeg',
		reasons: ['sample'],
		sourceMessageId: 'message-video',
		timestampSeconds,
	};
}

function artifact(overrides = {}) {
	const frameTimeline = overrides.frameTimeline ?? [frame(0, 1), frame(5, 2), frame(9.999, 3)];
	return {
		coverage: 'balanced',
		frameCount: frameTimeline.length,
		frameTimeline,
		metadata: {
			audioTrackAvailable: true,
			container: 'mov',
			durationSeconds: 10,
			frameRate: 30,
			height: 720,
			videoCodec: 'h264',
			width: 1280,
		},
		samplingConfiguration: {
			bands: [
				{endSeconds: 15, framesPerSecond: 4},
				{endSeconds: 60, framesPerSecond: 2},
				{endSeconds: 300, framesPerSecond: 1},
				{endSeconds: null, framesPerSecond: 0.5},
			],
			maximumFrames: 180,
			sceneChangeThreshold: 0.35,
		},
		transcript: {
			segments: [{endSeconds: 3, startSeconds: 1, text: 'Alex says the box is red.'}],
			status: 'completed',
		},
		...overrides,
	};
}

function answer(text = 'Alex lifts it [Video 00:05].') {
	return {
		text,
		webSearch: {
			citations: [], mode: 'off', ran: false, sources: [],
		},
	};
}

function responseText(text, searched = false) {
	const output = searched
		? [{action: {sources: [], type: 'search'}, status: 'completed', type: 'web_search_call'}]
		: [];
	output.push({content: [{text, type: 'output_text'}], type: 'message'});
	return new Response(JSON.stringify({output}), {status: 200});
}

test('video input builder sends ordered JPEG frames with explicit economical or focused detail', () => {
	assert.deepEqual(buildOpenAiVideoInput('Question', [{
		bytes: Uint8Array.of(1, 2, 3),
		detail: 'low',
		label: '[Video 00:00] sampled frame',
		mimeType: 'image/jpeg',
	}]), [{
		content: [
			{text: 'Question', type: 'input_text'},
			{text: '[Video 00:00] sampled frame', type: 'input_text'},
			{
				detail: 'low',
				// Provider-owned request field names are snake_case.
				// eslint-disable-next-line camelcase
				image_url: 'data:image/jpeg;base64,AQID',
				type: 'input_image',
			},
		],
		role: 'user',
	}]);
});

test('reviewed transcript edits replace original video transcript text before provider handoff', () => {
	const transcript = videoTranscriptForReview({
		editedSegments: [{endSeconds: 2, startSeconds: 1, text: 'redacted wording'}],
		originalSegments: [{endSeconds: 2, startSeconds: 1, text: 'private original'}],
		status: 'completed',
	});
	assert.equal(transcript.segments[0].text, 'redacted wording');
	assert.doesNotMatch(JSON.stringify(transcript), /private original/u);
});

test('OpenAI video requests use strict structured Pass 1 and preserve Always web semantics in Pass 2', async () => {
	const bodies = [];
	const client = new OpenAiClient({
		async fetchImplementation(_url, options) {
			const body = JSON.parse(options.body);
			bodies.push(body);
			return responseText(
				body.text.format
					? JSON.stringify({events: [], focusIntervals: [], uncertaintyNotes: []})
					: 'Answer [Video 00:01].',
				body.tools !== undefined,
			);
		},
	});
	const sampledFrame = {
		bytes: Uint8Array.of(0xFF, 0xD8, 1, 0xFF, 0xD9),
		detail: 'low',
		label: '[Video 00:01] sampled frame',
		mimeType: 'image/jpeg',
	};
	const scan = await client.createStructuredVideoTimeline('sk-private', 'Scan', [sampledFrame], {
		name: 'timeline',
		schema: {
			additionalProperties: false,
			properties: {events: {items: {type: 'string'}, type: 'array'}},
			required: ['events'],
			type: 'object',
		},
	});
	assert.deepEqual(scan, {events: [], focusIntervals: [], uncertaintyNotes: []});
	await client.createVideoAnswer('sk-private', 'Answer', 'always', [{...sampledFrame, detail: 'high'}]);
	assert.deepEqual(bodies[0].text.format, {
		name: 'timeline',
		schema: {
			additionalProperties: false,
			properties: {events: {items: {type: 'string'}, type: 'array'}},
			required: ['events'],
			type: 'object',
		},
		strict: true,
		type: 'json_schema',
	});
	assert.equal(bodies[0].input[0].content[2].detail, 'low');
	assert.equal('tools' in bodies[0], false);
	assert.equal(bodies[1].input[0].content[2].detail, 'high');
	assert.deepEqual(bodies[1].tools, [{type: 'web_search'}]);
	assert.equal(bodies[1].tool_choice, 'required');
});

test('two-pass analysis scans every broad frame, re-extracts bounded focused frames, and reports honest progress', async () => {
	const calls = [];
	const intervals = [];
	const provider = {
		async scan(_apiKey, prompt, frames) {
			calls.push({frames, prompt, type: 'scan'});
			return {
				events: [{
					description: 'A person reaches for a box.', endSeconds: 5.2, startSeconds: 4.8, timestamps: [5],
				}],
				focusIntervals: [{endSeconds: 5.8, reason: 'Fast hand motion and small label.', startSeconds: 4.2}],
				uncertaintyNotes: ['The label is too small in broad frames.'],
			};
		},
		async answer(_apiKey, prompt, mode, frames) {
			calls.push({
				frames, mode, prompt, type: 'answer',
			});
			return answer();
		},
	};
	const extractor = {
		async extract(value) {
			intervals.push(...value);
			return [frame(4.75, 4), frame(5, 5), frame(5.25, 6)];
		},
	};
	const progress = [];
	const result = await new VideoUnderstandingService(provider, extractor).analyze({
		apiKey: 'sk-private',
		artifact: artifact(),
		question: 'What does Alex do with the box?',
		webSearchMode: 'off',
	}, {
		onProgress(value) {
			progress.push(value);
		},
	});

	assert.equal(calls[0].frames.length, 3);
	assert.ok(calls[0].frames.every(item => item.detail === 'low'));
	assert.match(calls[0].prompt, /beginning|sampled-video timeline/u);
	assert.match(calls[0].prompt, /Alex says the box is red/u);
	assert.equal(intervals.length, 1);
	assert.ok(intervals[0].endSeconds - intervals[0].startSeconds <= 1.5);
	assert.equal(calls[1].frames.length, 3);
	assert.ok(calls[1].frames.every(item => item.detail === 'high'));
	assert.match(calls[1].prompt, /\[Video 00:12\]/u);
	assert.match(calls[1].prompt, /\[Web 1\]/u);
	assert.deepEqual(progress.map(item => item.phase), ['pass-1', 'extracting-focus', 'pass-2']);
	assert.equal(result.sampledFrameCount, 3);
	assert.equal(result.focusedFrameCount, 3);
	assert.equal(result.transcriptAvailable, true);
	assert.equal(result.answer.text, 'Alex lifts it [Video 00:05].');
});

test('silent sparse videos remain analyzable and disclose zero newly extracted frames', async () => {
	const provider = {
		async scan() {
			return {events: [], focusIntervals: [], uncertaintyNotes: ['Sparse sampling limits confidence.']};
		},
		async answer(_apiKey, prompt, _mode, frames) {
			assert.match(prompt, /No audio track/u);
			assert.match(prompt, /sparse/u);
			assert.equal(frames.length, 3);
			return answer('Visible motion occurs [Video 00:05].');
		},
	};
	const result = await new VideoUnderstandingService(provider, {
		async extract() {
			assert.fail('No focus extraction should run without selected intervals.');
		},
	}).analyze({
		apiKey: 'sk-private',
		artifact: artifact({coverage: 'sparse', transcript: {status: 'no-audio'}}),
		question: 'What moves?',
		webSearchMode: 'off',
	});
	assert.equal(result.coverage, 'sparse');
	assert.equal(result.focusedFrameCount, 0);
	assert.equal(result.transcriptAvailable, false);
});

test('timeline claims without timestamps and oversized focused extraction fail closed', async () => {
	const invalidProvider = {
		async scan() {
			return {
				events: [{
					description: 'Unsupported claim', endSeconds: 1, startSeconds: 0, timestamps: [],
				}],
				focusIntervals: [],
				uncertaintyNotes: [],
			};
		},
		async answer() {
			assert.fail('Malformed pass 1 must not reach pass 2.');
		},
	};
	await assert.rejects(
		new VideoUnderstandingService(invalidProvider, {
			async extract() {
				return [];
			},
		}).analyze({
			apiKey: 'sk-private', artifact: artifact(), question: 'Question?', webSearchMode: 'off',
		}),
		error => error instanceof OpenAiRequestError && error.code === 'malformed-response',
	);

	const provider = {
		async scan() {
			return {
				events: [{
					description: 'Fast event', endSeconds: 2, startSeconds: 1, timestamps: [1.5],
				}],
				focusIntervals: [{endSeconds: 2, reason: 'Fast event', startSeconds: 1}],
				uncertaintyNotes: [],
			};
		},
		async answer() {
			assert.fail('Oversized focused frames must not reach final answer.');
		},
	};
	await assert.rejects(
		new VideoUnderstandingService(provider, {
			async extract() {
				return Array.from({length: maximumVideoFocusedFrames + 1}, (_, index) => frame(index / 10));
			},
		}).analyze({
			apiKey: 'sk-private', artifact: artifact(), question: 'Question?', webSearchMode: 'off',
		}),
		error => error instanceof OpenAiRequestError && error.code === 'input-too-large',
	);
});

test('final video answers require valid in-range timestamp evidence', async () => {
	for (const invalidAnswer of ['Unattributed visual claim.', 'Claim [Video 00:99].']) {
		const provider = {
			async scan() {
				return {events: [], focusIntervals: [], uncertaintyNotes: []};
			},
			async answer() {
				return answer(invalidAnswer);
			},
		};
		// eslint-disable-next-line no-await-in-loop
		await assert.rejects(
			new VideoUnderstandingService(provider, {
				async extract() {
					return [];
				},
			}).analyze({
				apiKey: 'sk-private', artifact: artifact(), question: 'Question?', webSearchMode: 'off',
			}),
			error => error instanceof OpenAiRequestError && error.code === 'malformed-response',
		);
	}
});

test('cancellation and stale conversation checks stop between passes', async () => {
	const controller = new AbortController();
	const provider = {
		async scan() {
			controller.abort();
			return {events: [], focusIntervals: [], uncertaintyNotes: []};
		},
		async answer() {
			assert.fail('Cancelled analysis must not reach pass 2.');
		},
	};
	await assert.rejects(
		new VideoUnderstandingService(provider, {
			async extract() {
				return [];
			},
		}).analyze({
			apiKey: 'sk-private', artifact: artifact(), question: 'Question?', webSearchMode: 'off',
		}, {signal: controller.signal}),
		error => error instanceof OpenAiRequestError && error.code === 'cancelled',
	);
});
