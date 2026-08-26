import {
	OpenAiAnswer,
	OpenAiClient,
	OpenAiImageInput,
	OpenAiJsonSchema,
	OpenAiRequestError,
	OpenAiVideoFrameInput,
	WebSearchMode,
} from './openai-client';
import {
	maximumVideoAnalysisFrames,
	VideoAnalysisFrame,
	VideoPreprocessingArtifact,
} from './video-preprocessing';
import type {ReviewedTranscriptItem} from './reviewed-transcripts';

export const maximumVideoFocusIntervals = 6;
export const maximumVideoFocusedFrames = 48;
export const maximumVideoTimelineEvents = 120;
export const maximumVideoTimelineNotes = 60;
export const maximumVideoQuestionCharacters = 20_000;

export type VideoFocusInterval = {
	endSeconds: number;
	reason: string;
	startSeconds: number;
};

export type VideoTimelineEvent = {
	description: string;
	endSeconds: number;
	startSeconds: number;
	timestamps: number[];
};

export type VideoTimelineScan = {
	events: VideoTimelineEvent[];
	focusIntervals: VideoFocusInterval[];
	uncertaintyNotes: string[];
};

export type VideoUnderstandingProgress = {
	coverage: VideoPreprocessingArtifact['coverage'];
	frameCount: number;
	phase: 'extracting-focus' | 'pass-1' | 'pass-2';
	transcriptAvailable: boolean;
};

export type VideoUnderstandingResult = {
	answer: OpenAiAnswer;
	coverage: VideoPreprocessingArtifact['coverage'];
	focusedFrameCount: number;
	sampledFrameCount: number;
	timeline: VideoTimelineScan;
	transcriptAvailable: boolean;
};

export type VideoUnderstandingRequest = {
	apiKey: string;
	artifact: Readonly<VideoPreprocessingArtifact>;
	question: string;
	reviewedImages?: ReadonlyArray<Readonly<OpenAiImageInput>>;
	savedTimeline?: ReadonlyArray<Readonly<VideoTimelineEvent>>;
	sourceAvailable?: boolean;
	webSearchMode: WebSearchMode;
};

export type VideoUnderstandingOptions = {
	isCurrent?: () => boolean;
	onProgress?: (progress: Readonly<VideoUnderstandingProgress>) => void;
	signal?: AbortSignal;
};

export type VideoUnderstandingProvider = {
	answer(
		apiKey: string,
		prompt: string,
		mode: WebSearchMode,
		frames: ReadonlyArray<Readonly<OpenAiVideoFrameInput>>,
		signal?: AbortSignal,
	): Promise<OpenAiAnswer>;

	scan(
		apiKey: string,
		prompt: string,
		frames: ReadonlyArray<Readonly<OpenAiVideoFrameInput>>,
		signal?: AbortSignal,
	): Promise<unknown>;
};

export type VideoFocusExtractor = {
	extract(
		intervals: ReadonlyArray<Readonly<VideoFocusInterval>>,
		signal?: AbortSignal,
	): Promise<ReadonlyArray<Readonly<VideoAnalysisFrame>>>;
};

export function videoTranscriptForReview(
	item: Readonly<ReviewedTranscriptItem>,
): VideoPreprocessingArtifact['transcript'] {
	if (item.status === 'no-audio') {
		return {status: 'no-audio'};
	}

	const segments = item.editedSegments ?? item.originalSegments;
	if (item.status !== 'completed' || !segments || segments.length === 0) {
		throw new OpenAiRequestError('malformed-response', 'The reviewed video transcript is unavailable. Refresh context and try again.');
	}

	return {
		segments: segments.map(segment => ({...segment})),
		status: 'completed',
	};
}

const timelineSchema: OpenAiJsonSchema = {
	name: 'video_timeline_scan',
	schema: {
		additionalProperties: false,
		properties: {
			events: {
				items: {
					additionalProperties: false,
					properties: {
						description: {type: 'string'},
						endSeconds: {type: 'number'},
						startSeconds: {type: 'number'},
						timestamps: {items: {type: 'number'}, type: 'array'},
					},
					required: ['description', 'endSeconds', 'startSeconds', 'timestamps'],
					type: 'object',
				},
				type: 'array',
			},
			focusIntervals: {
				items: {
					additionalProperties: false,
					properties: {
						endSeconds: {type: 'number'},
						reason: {type: 'string'},
						startSeconds: {type: 'number'},
					},
					required: ['endSeconds', 'reason', 'startSeconds'],
					type: 'object',
				},
				type: 'array',
			},
			uncertaintyNotes: {items: {type: 'string'}, type: 'array'},
		},
		required: ['events', 'focusIntervals', 'uncertaintyNotes'],
		type: 'object',
	},
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function boundedText(value: unknown, maximum = 4000): value is string {
	return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
}

function validTime(value: unknown, durationSeconds: number): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= durationSeconds;
}

function parseTimelineScan(value: unknown, durationSeconds: number): VideoTimelineScan {
	if (!isRecord(value)
		|| Object.keys(value).length !== 3
		|| !Array.isArray(value.events)
		|| value.events.length > maximumVideoTimelineEvents
		|| !Array.isArray(value.focusIntervals)
		|| value.focusIntervals.length > maximumVideoFocusIntervals
		|| !Array.isArray(value.uncertaintyNotes)
		|| value.uncertaintyNotes.length > maximumVideoTimelineNotes) {
		throw new OpenAiRequestError('malformed-response', 'OpenAI returned an unreadable video timeline. Try again.');
	}

	const events = value.events.map(event => {
		if (!isRecord(event)
			|| Object.keys(event).length !== 4
			|| !boundedText(event.description)
			|| !validTime(event.startSeconds, durationSeconds)
			|| !validTime(event.endSeconds, durationSeconds)
			|| event.endSeconds < event.startSeconds
			|| !Array.isArray(event.timestamps)
			|| event.timestamps.length === 0
			|| event.timestamps.length > 20
			|| !event.timestamps.every(timestamp => validTime(timestamp, durationSeconds))) {
			throw new OpenAiRequestError('malformed-response', 'OpenAI returned video claims without valid timestamp evidence. Try again.');
		}

		return {
			description: event.description,
			endSeconds: event.endSeconds,
			startSeconds: event.startSeconds,
			timestamps: [...event.timestamps] as number[],
		};
	});

	const focusIntervals = value.focusIntervals.map(interval => {
		if (!isRecord(interval)
			|| Object.keys(interval).length !== 3
			|| !boundedText(interval.reason, 1000)
			|| !validTime(interval.startSeconds, durationSeconds)
			|| !validTime(interval.endSeconds, durationSeconds)
			|| interval.endSeconds < interval.startSeconds) {
			throw new OpenAiRequestError('malformed-response', 'OpenAI returned invalid video focus intervals. Try again.');
		}

		return {
			endSeconds: interval.endSeconds,
			reason: interval.reason,
			startSeconds: interval.startSeconds,
		};
	});

	if (!value.uncertaintyNotes.every(note => boundedText(note, 2000))) {
		throw new OpenAiRequestError('malformed-response', 'OpenAI returned invalid video uncertainty notes. Try again.');
	}

	return {
		events,
		focusIntervals,
		uncertaintyNotes: [...value.uncertaintyNotes] as string[],
	};
}

function failIfUnavailable(options: Readonly<VideoUnderstandingOptions>): void {
	if (options.signal?.aborted) {
		throw new OpenAiRequestError('cancelled', 'Video analysis cancelled.');
	}

	if (options.isCurrent && !options.isCurrent()) {
		throw new OpenAiRequestError('cancelled', 'The selected video no longer belongs to the current conversation.');
	}
}

function timestamp(seconds: number): string {
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds - (minutes * 60);
	return `${String(minutes).padStart(2, '0')}:${remainder.toFixed(3).padStart(6, '0')}`;
}

function transcriptText(artifact: Readonly<VideoPreprocessingArtifact>): string {
	if (artifact.transcript.status === 'no-audio') {
		return 'No audio track or speech transcript is available.';
	}

	return artifact.transcript.segments
		.map(segment => `[${timestamp(segment.startSeconds)}–${timestamp(segment.endSeconds)}] ${segment.text}`)
		.join('\n');
}

function validateArtifact(artifact: Readonly<VideoPreprocessingArtifact>): void {
	if (!Number.isFinite(artifact.metadata.durationSeconds)
		|| artifact.metadata.durationSeconds <= 0
		|| !['balanced', 'sparse'].includes(artifact.coverage)
		|| artifact.frameCount !== artifact.frameTimeline.length
		|| artifact.frameCount === 0
		|| artifact.frameCount > maximumVideoAnalysisFrames) {
		throw new OpenAiRequestError('input-too-large', 'The current sampled-video artifact is unavailable or malformed.');
	}

	let previousTimestamp = -1;
	let bytes = 0;
	const sourceMessageId = artifact.frameTimeline[0]?.sourceMessageId;
	for (const frame of artifact.frameTimeline) {
		bytes += frame.bytes.byteLength;
		if (frame.mimeType !== 'image/jpeg'
			|| !(frame.bytes instanceof Uint8Array)
			|| frame.bytes.byteLength === 0
			|| frame.bytes.byteLength > 512 * 1024
			|| frame.sourceMessageId !== sourceMessageId
			|| !validTime(frame.timestampSeconds, artifact.metadata.durationSeconds)
			|| frame.timestampSeconds <= previousTimestamp) {
			throw new OpenAiRequestError('input-too-large', 'The current sampled-video artifact is unavailable or malformed.');
		}

		previousTimestamp = frame.timestampSeconds;
	}

	if (bytes > 48 * 1024 * 1024) {
		throw new OpenAiRequestError('input-too-large', 'The current sampled-video artifact exceeds the analysis limit.');
	}
}

function frameInputs(
	frames: ReadonlyArray<Readonly<VideoAnalysisFrame>>,
	detail: OpenAiVideoFrameInput['detail'],
): OpenAiVideoFrameInput[] {
	return frames.map(frame => ({
		bytes: frame.bytes,
		detail,
		label: `[Video ${timestamp(frame.timestampSeconds)}] sampled frame`,
		mimeType: frame.mimeType,
	}));
}

function reviewedImageInputs(images: ReadonlyArray<Readonly<OpenAiImageInput>>): OpenAiVideoFrameInput[] {
	return images.map((image, index) => ({
		bytes: image.bytes,
		detail: 'high',
		label: `Reviewed context image ${index + 1} — ${image.label}`,
		mimeType: image.mimeType,
	}));
}

function buildScanPrompt(request: Readonly<VideoUnderstandingRequest>): string {
	return [
		'Analyze the complete bounded sampled-video timeline and transcript.',
		`User question: ${request.question}`,
		`Video duration: ${request.artifact.metadata.durationSeconds.toFixed(3)} seconds.`,
		`Sampling coverage: ${request.artifact.coverage}; ${request.artifact.frameCount} sampled frames. This is sampled coverage, not every source frame.`,
		'For every event, provide one or more timestamps that directly support the video observation.',
		`Choose at most ${maximumVideoFocusIntervals} short focus intervals only where denser frames could resolve important or uncertain details for the question.`,
		'Do not use web knowledge in this pass and do not infer unseen frames.',
		'Timestamped transcript:',
		transcriptText(request.artifact),
	].join('\n\n');
}

function buildAnswerPrompt(request: Readonly<VideoUnderstandingRequest>, scan: Readonly<VideoTimelineScan>, focusedFrameCount: number): string {
	return [
		'Answer the user from the sampled video evidence below.',
		`User question: ${request.question}`,
		`Coverage: ${request.artifact.coverage}; ${request.artifact.frameCount} broad sampled frames and ${focusedFrameCount} newly extracted focused frames.`,
		'This is full sampled-video understanding, not literal examination of every original frame. State material uncertainty and sparse coverage honestly.',
		'Every claim grounded in the video must include one or more markers exactly like [Video 00:12].',
		'The final answer must contain at least one valid [Video mm:ss] evidence marker, and every marker must refer to a timestamp inside this video.',
		'Externally browsed facts must use [Web 1], [Web 2], and so on, and must never be presented as something visible or audible in the video.',
		'Use both transcript and visual frames when they are relevant. Silent or no-speech video can be answered visually.',
		...(request.sourceAvailable === false ? [
			'The original temporary video is no longer available. Answer only from saved transcript/keyframes and state that new frames require selecting the source video again.',
		] : []),
		'Pass 1 structured timeline:',
		JSON.stringify(scan),
		'Timestamped transcript:',
		transcriptText(request.artifact),
	].join('\n\n');
}

function targetedTimestamp(question: string, durationSeconds: number): number | undefined {
	const match = /(?:^|\D)(\d{1,3}):([0-5]\d(?:\.\d{1,3})?)(?:\D|$)/u.exec(question);
	if (!match) {
		return;
	}

	const seconds = (Number(match[1]) * 60) + Number(match[2]);
	return Number.isFinite(seconds) && seconds <= durationSeconds ? seconds : undefined;
}

function validateVideoAnswer(answer: Readonly<OpenAiAnswer>, durationSeconds: number): void {
	const markerPattern = /\[Video ([0-9]{2,}):([0-9]{2}(?:\.[0-9]{1,3})?)\]/gu;
	const matches = [...answer.text.matchAll(markerPattern)];
	if (matches.length === 0 || (answer.text.match(/\[Video/gu)?.length ?? 0) !== matches.length) {
		throw new OpenAiRequestError('malformed-response', 'OpenAI returned a video answer without valid timestamp evidence. Try again.');
	}

	for (const match of matches) {
		const minutes = Number(match[1]);
		const seconds = Number(match[2]);
		const timestampSeconds = (minutes * 60) + seconds;
		if (seconds >= 60 || !Number.isFinite(timestampSeconds) || timestampSeconds > durationSeconds) {
			throw new OpenAiRequestError('malformed-response', 'OpenAI returned a video answer with out-of-range timestamp evidence. Try again.');
		}
	}
}

function fallbackFocusedFrames(artifact: Readonly<VideoPreprocessingArtifact>): VideoAnalysisFrame[] {
	const frames = artifact.frameTimeline;
	const indices = new Set([0, Math.floor((frames.length - 1) / 2), frames.length - 1]);
	return [...indices].sort((left, right) => left - right).map(index => frames[index]);
}

function boundedFocusIntervals(
	intervals: ReadonlyArray<Readonly<VideoFocusInterval>>,
	durationSeconds: number,
): VideoFocusInterval[] {
	return intervals.map(interval => {
		const midpoint = (interval.startSeconds + interval.endSeconds) / 2;
		const startSeconds = Math.max(0, midpoint - 0.75);
		const endSeconds = Math.min(durationSeconds, startSeconds + 1.5);
		return {
			endSeconds,
			reason: interval.reason,
			startSeconds: Math.max(0, endSeconds - 1.5),
		};
	});
}

export class OpenAiVideoUnderstandingProvider implements VideoUnderstandingProvider {
	constructor(private readonly client: OpenAiClient) {}

	async scan(
		apiKey: string,
		prompt: string,
		frames: ReadonlyArray<Readonly<OpenAiVideoFrameInput>>,
		signal?: AbortSignal,
	): Promise<unknown> {
		return this.client.createStructuredVideoTimeline(apiKey, prompt, frames, timelineSchema, signal);
	}

	async answer(
		apiKey: string,
		prompt: string,
		mode: WebSearchMode,
		frames: ReadonlyArray<Readonly<OpenAiVideoFrameInput>>,
		signal?: AbortSignal,
	): Promise<OpenAiAnswer> {
		return this.client.createVideoAnswer(apiKey, prompt, mode, frames, signal);
	}
}

export class VideoUnderstandingService {
	constructor(
		private readonly provider: VideoUnderstandingProvider,
		private readonly focusExtractor: VideoFocusExtractor,
	) {}

	async analyze(
		request: Readonly<VideoUnderstandingRequest>,
		options: VideoUnderstandingOptions = {},
	): Promise<VideoUnderstandingResult> {
		if (!request.question.trim() || request.question.length > maximumVideoQuestionCharacters) {
			throw new OpenAiRequestError('input-too-large', `Video questions are limited to ${maximumVideoQuestionCharacters.toLocaleString()} characters.`);
		}

		validateArtifact(request.artifact);
		const transcriptAvailable = request.artifact.transcript.status === 'completed';
		const progress = (phase: VideoUnderstandingProgress['phase'], frameCount: number): void => {
			options.onProgress?.({
				coverage: request.artifact.coverage,
				frameCount,
				phase,
				transcriptAvailable,
			});
		};

		failIfUnavailable(options);
		const requestedTimestamp = request.savedTimeline
			? targetedTimestamp(request.question, request.artifact.metadata.durationSeconds)
			: undefined;
		let timeline: VideoTimelineScan;
		if (requestedTimestamp === undefined) {
			progress('pass-1', request.artifact.frameCount);
			const rawScan = await this.provider.scan(
				request.apiKey,
				buildScanPrompt(request),
				frameInputs(request.artifact.frameTimeline, 'low'),
				options.signal,
			);
			failIfUnavailable(options);
			timeline = parseTimelineScan(rawScan, request.artifact.metadata.durationSeconds);
		} else {
			timeline = {
				events: request.savedTimeline!.map(event => ({...event, timestamps: [...event.timestamps]})),
				focusIntervals: request.sourceAvailable === false ? [] : [{
					endSeconds: Math.min(request.artifact.metadata.durationSeconds, requestedTimestamp + 0.75),
					reason: `Targeted follow-up around ${timestamp(requestedTimestamp)}`,
					startSeconds: Math.max(0, requestedTimestamp - 0.75),
				}],
				uncertaintyNotes: request.sourceAvailable === false
					? ['Original source unavailable; no new frames were extracted.']
					: [],
			};
		}

		progress('extracting-focus', 0);
		const extracted = timeline.focusIntervals.length > 0
			? await this.focusExtractor.extract(
				boundedFocusIntervals(timeline.focusIntervals, request.artifact.metadata.durationSeconds),
				options.signal,
			)
			: [];
		failIfUnavailable(options);
		if (extracted.length > maximumVideoFocusedFrames) {
			throw new OpenAiRequestError('input-too-large', `Focused video analysis is limited to ${maximumVideoFocusedFrames} frames.`);
		}

		const focusedFrames = extracted.length > 0 ? [...extracted] : fallbackFocusedFrames(request.artifact);
		progress('pass-2', focusedFrames.length);
		const answer = await this.provider.answer(
			request.apiKey,
			buildAnswerPrompt(request, timeline, extracted.length),
			request.webSearchMode,
			[
				...frameInputs(focusedFrames, 'high'),
				...reviewedImageInputs(request.reviewedImages ?? []),
			],
			options.signal,
		);
		failIfUnavailable(options);
		validateVideoAnswer(answer, request.artifact.metadata.durationSeconds);
		return {
			answer,
			coverage: request.artifact.coverage,
			focusedFrameCount: extracted.length,
			sampledFrameCount: request.artifact.frameCount,
			timeline,
			transcriptAvailable,
		};
	}
}
