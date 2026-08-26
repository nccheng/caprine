import {randomUUID} from 'node:crypto';
import {
	mkdir,
	readFile,
	readdir,
	rm,
} from 'node:fs/promises';
import path from 'node:path';
import {
	allowedVideoInputFormats,
	BoundedProcessRunner,
	findMacVideoTools,
	VideoMetadata,
	VideoToolError,
	VideoToolPaths,
} from './video-toolchain';

export const maximumVideoAnalysisFrames = 180;
export const maximumVideoAnalysisFrameBytes = 512 * 1024;
export const maximumVideoAnalysisBytes = 48 * 1024 * 1024;
export const maximumVideoFocusedFrames = 48;
export const maximumVideoFocusIntervals = 6;
export const videoSceneChangeThreshold = 0.35;

export const videoFrameSamplingBands = [
	{endSeconds: 15, framesPerSecond: 4},
	{endSeconds: 60, framesPerSecond: 2},
	{endSeconds: 300, framesPerSecond: 1},
	{endSeconds: null, framesPerSecond: 0.5},
] as const;

export type VideoFrameCoverage = 'balanced' | 'sparse';
export type VideoFrameReason = 'closing' | 'opening' | 'sample' | 'scene-change';
export type VideoFramePreprocessingPhase =
	| 'checking-tools'
	| 'detecting-scenes'
	| 'extracting-frames'
	| 'deduplicating-frames'
	| 'assembling-artifact';

export type VideoFrameProgress = {
	completed: number;
	phase: VideoFramePreprocessingPhase;
	total: number;
};

export type VideoTranscriptState = {
	status: 'no-audio';
} | {
	segments: ReadonlyArray<{
		endSeconds: number;
		startSeconds: number;
		text: string;
	}>;
	status: 'completed';
};

export type VideoAnalysisFrame = {
	bytes: Uint8Array;
	mimeType: 'image/jpeg';
	reasons: VideoFrameReason[];
	sourceMessageId: string;
	timestampSeconds: number;
};

export type VideoPreprocessingArtifact = {
	coverage: VideoFrameCoverage;
	frameCount: number;
	frameTimeline: VideoAnalysisFrame[];
	metadata: VideoMetadata;
	samplingConfiguration: {
		bands: typeof videoFrameSamplingBands;
		maximumFrames: typeof maximumVideoAnalysisFrames;
		sceneChangeThreshold: typeof videoSceneChangeThreshold;
	};
	transcript: VideoTranscriptState;
};

type ProcessResult = {stderr: string; stdout: string};
type ProcessRunner = {
	run(executable: string, arguments_: readonly string[], signal?: AbortSignal): Promise<ProcessResult>;
};
type LocateVideoTools = () => Promise<VideoToolPaths>;

export type PreprocessVideoOptions = {
	isCurrent?: () => boolean;
	onProgress?: (progress: Readonly<VideoFrameProgress>) => void;
	signal?: AbortSignal;
};

export type VideoPreprocessingRequest = {
	metadata: Readonly<VideoMetadata>;
	sourceMessageId: string;
	transcript: Readonly<VideoTranscriptState>;
};

export type VideoFocusIntervalRequest = {
	endSeconds: number;
	startSeconds: number;
};

type CandidateFrame = {
	pts: number;
	reasons: Set<VideoFrameReason>;
	timestampSeconds: number;
};

type ShowInfoFrame = {
	pts: number;
	timestampSeconds: number;
};

const maximumTranscriptSegments = 1000;
const maximumTranscriptCharacters = 100_000;
const perceptualDuplicateDistance = 5;
const signatureBytesPerFrame = 64;
const sceneChangeReserve = maximumVideoAnalysisFrames - 2;

function failIfUnavailable(options: Readonly<PreprocessVideoOptions>): void {
	if (options.signal?.aborted) {
		throw new VideoToolError('cancelled', 'Video preprocessing was canceled.');
	}

	if (options.isCurrent && !options.isCurrent()) {
		throw new VideoToolError('stale-media', 'The selected video no longer belongs to the current conversation.');
	}
}

function report(
	options: Readonly<PreprocessVideoOptions>,
	phase: VideoFramePreprocessingPhase,
	completed: number,
	total: number,
): void {
	options.onProgress?.({completed, phase, total});
}

function validateMetadata(metadata: Readonly<VideoMetadata>): void {
	if (!Number.isFinite(metadata.durationSeconds)
		|| metadata.durationSeconds <= 0
		|| !Number.isFinite(metadata.frameRate)
		|| metadata.frameRate <= 0
		|| !Number.isSafeInteger(metadata.width)
		|| metadata.width <= 0
		|| !Number.isSafeInteger(metadata.height)
		|| metadata.height <= 0) {
		throw new VideoToolError('malformed-metadata', 'The video metadata could not be read.');
	}
}

function cloneTranscript(transcript: Readonly<VideoTranscriptState>, durationSeconds: number): VideoTranscriptState {
	if (transcript.status === 'no-audio') {
		return {status: 'no-audio'};
	}

	if (transcript.segments.length > maximumTranscriptSegments) {
		throw new VideoToolError('malformed-metadata', 'The video transcript is invalid.');
	}

	let characters = 0;
	let previousEnd = 0;
	const segments = transcript.segments.map(segment => {
		const text = segment.text.replaceAll(/\r\n?/g, '\n').trim();
		characters += text.length;
		if (!text
			|| text.length > 20_000
			|| !Number.isFinite(segment.startSeconds)
			|| !Number.isFinite(segment.endSeconds)
			|| segment.startSeconds < previousEnd
			|| segment.endSeconds < segment.startSeconds
			|| segment.endSeconds > durationSeconds) {
			throw new VideoToolError('malformed-metadata', 'The video transcript is invalid.');
		}

		previousEnd = segment.endSeconds;
		return {
			endSeconds: segment.endSeconds,
			startSeconds: segment.startSeconds,
			text,
		};
	});
	if (characters > maximumTranscriptCharacters) {
		throw new VideoToolError('malformed-metadata', 'The video transcript is invalid.');
	}

	return {segments, status: 'completed'};
}

function samplingInterval(seconds: number): number {
	for (const band of videoFrameSamplingBands) {
		if (band.endSeconds === null || seconds < band.endSeconds) {
			return 1 / band.framesPerSecond;
		}
	}

	return 2;
}

export function adaptiveVideoSampleTimestamps(durationSeconds: number): number[] {
	if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
		throw new VideoToolError('malformed-metadata', 'The video duration is invalid.');
	}

	const timestamps = [0];
	let timestamp = 0;
	while (timestamp < durationSeconds) {
		timestamp += samplingInterval(timestamp);
		if (timestamp >= durationSeconds) {
			break;
		}

		timestamps.push(timestamp);
		if (timestamps.length > 100_000) {
			throw new VideoToolError('output-too-large', 'The video sampling plan is too large.');
		}
	}

	timestamps.push(Math.max(0, durationSeconds - 0.001));
	return timestamps;
}

export function parseShowInfoTimestamps(stderr: string): number[] {
	return parseShowInfoFrames(stderr).map(frame => frame.timestampSeconds);
}

export function parseShowInfoFrames(stderr: string): ShowInfoFrame[] {
	const frames: ShowInfoFrame[] = [];
	for (const match of stderr.matchAll(/\bpts:\s*(-?\d+)\s+pts_time:([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\b/giu)) {
		const pts = Number(match[1]);
		const timestampSeconds = Number(match[2]);
		if (!Number.isSafeInteger(pts) || pts < 0 || !Number.isFinite(timestampSeconds) || timestampSeconds < 0) {
			throw new VideoToolError('process-failed', 'Video frame timestamps could not be read.');
		}

		frames.push({pts, timestampSeconds});
	}

	return frames;
}

function mergeCandidate(
	candidates: Map<number, CandidateFrame>,
	metadata: Readonly<VideoMetadata>,
	frame: Readonly<ShowInfoFrame>,
	reason: VideoFrameReason,
): void {
	if (frame.timestampSeconds > metadata.durationSeconds) {
		throw new VideoToolError('process-failed', 'Video frame timestamps could not be read.');
	}

	const existing = candidates.get(frame.pts);
	if (existing) {
		existing.reasons.add(reason);
		return;
	}

	candidates.set(frame.pts, {
		pts: frame.pts,
		reasons: new Set([reason]),
		timestampSeconds: frame.timestampSeconds,
	});
}

function evenlySelect<T>(values: readonly T[], count: number): T[] {
	if (count <= 0 || values.length === 0) {
		return [];
	}

	if (values.length <= count) {
		return [...values];
	}

	if (count === 1) {
		return [values[Math.floor(values.length / 2)]];
	}

	return Array.from({length: count}, (_, index) => values[Math.round(index * (values.length - 1) / (count - 1))]);
}

function candidateFrames(
	metadata: Readonly<VideoMetadata>,
	boundaryFrames: readonly ShowInfoFrame[],
	sceneFrames: readonly ShowInfoFrame[],
	sampleFrames: readonly ShowInfoFrame[],
): CandidateFrame[] {
	const candidates = new Map<number, CandidateFrame>();
	if (boundaryFrames.length === 0 || boundaryFrames.length > 2) {
		throw new VideoToolError('process-failed', 'Video boundary frames could not be read.');
	}

	mergeCandidate(candidates, metadata, boundaryFrames[0], 'opening');
	mergeCandidate(candidates, metadata, boundaryFrames.at(-1)!, 'closing');

	const uniqueScenePts = new Set(sceneFrames.map(frame => frame.pts));
	if (uniqueScenePts.size > sceneChangeReserve) {
		throw new VideoToolError('output-too-large', 'This video has too many scene changes for bounded analysis.');
	}

	for (const frame of sceneFrames) {
		mergeCandidate(candidates, metadata, frame, 'scene-change');
	}

	const remaining = maximumVideoAnalysisFrames - candidates.size;
	const samples = sampleFrames.filter(frame => !candidates.has(frame.pts));
	for (const frame of evenlySelect(samples, remaining)) {
		mergeCandidate(candidates, metadata, frame, 'sample');
	}

	return [...candidates.values()].sort((left, right) => left.timestampSeconds - right.timestampSeconds);
}

function samplingSelectionExpression(durationSeconds: number, maximumSamples: number): string {
	const plannedSamples = adaptiveVideoSampleTimestamps(durationSeconds).length;
	const intervalMultiplier = Math.max(1, plannedSamples / Math.max(1, maximumSamples));
	return `isnan(prev_selected_t)+gte(t-prev_selected_t\\,${intervalMultiplier}*if(lt(t\\,15)\\,0.25\\,if(lt(t\\,60)\\,0.5\\,if(lt(t\\,300)\\,1\\,2))))`;
}

function selectExpression(candidates: readonly CandidateFrame[]): string {
	return candidates.map(candidate => `eq(pts\\,${candidate.pts})`).join('+');
}

function hammingDistance(left: Uint8Array, right: Uint8Array): number {
	return left.reduce((distance, value, index) => distance + (value === right[index] ? 0 : 1), 0);
}

function averageHash(signature: Uint8Array): Uint8Array {
	if (signature.byteLength !== signatureBytesPerFrame) {
		throw new VideoToolError('process-failed', 'Video frame signatures could not be read.');
	}

	const average = signature.reduce((total, value) => total + value, 0) / signature.byteLength;
	return signature.map(value => value >= average ? 1 : 0);
}

function isProtected(candidate: Readonly<CandidateFrame>): boolean {
	return candidate.reasons.has('opening')
		|| candidate.reasons.has('closing')
		|| candidate.reasons.has('scene-change');
}

async function readFrames(
	directory: string,
	candidates: readonly CandidateFrame[],
	timestamps: readonly number[],
): Promise<Array<{bytes: Uint8Array; candidate: CandidateFrame; signature: Uint8Array; timestampSeconds: number}>> {
	const directoryEntries = await readdir(directory);
	const names = directoryEntries.filter(name => /^\d{3}\.jpg$/u.test(name)).sort();
	if (names.length !== candidates.length || timestamps.length !== candidates.length) {
		throw new VideoToolError('process-failed', 'Video frames could not be extracted completely.');
	}

	const signatureBytes = new Uint8Array(await readFile(path.join(directory, 'signatures.gray')));
	if (signatureBytes.byteLength !== candidates.length * signatureBytesPerFrame) {
		throw new VideoToolError('process-failed', 'Video frame signatures could not be read.');
	}

	const frameFiles = await Promise.all(names.map(async name => new Uint8Array(await readFile(path.join(directory, name)))));
	let totalBytes = 0;
	return frameFiles.map((bytes, index) => {
		totalBytes += bytes.byteLength;
		if (bytes.byteLength === 0
			|| bytes.byteLength > maximumVideoAnalysisFrameBytes
			|| totalBytes > maximumVideoAnalysisBytes) {
			throw new VideoToolError('output-too-large', 'Extracted video frames exceed the analysis limit.');
		}

		if (bytes[0] !== 0xFF
			|| bytes[1] !== 0xD8
			|| bytes.at(-2) !== 0xFF
			|| bytes.at(-1) !== 0xD9) {
			throw new VideoToolError('process-failed', 'Video frame output could not be read.');
		}

		return {
			bytes,
			candidate: candidates[index],
			signature: averageHash(signatureBytes.slice(index * signatureBytesPerFrame, (index + 1) * signatureBytesPerFrame)),
			timestampSeconds: timestamps[index],
		};
	});
}

async function readFocusedFrames(
	directory: string,
	timestamps: readonly number[],
	sourceMessageId: string,
): Promise<VideoAnalysisFrame[]> {
	const directoryEntries = await readdir(directory);
	const names = directoryEntries.filter(name => /^focus-\d{3}\.jpg$/u.test(name)).sort();
	if (names.length === 0 || names.length !== timestamps.length || names.length > maximumVideoFocusedFrames) {
		throw new VideoToolError('process-failed', 'Focused video frames could not be extracted completely.');
	}

	let totalBytes = 0;
	return Promise.all(names.map(async (name, index) => {
		const bytes = new Uint8Array(await readFile(path.join(directory, name)));
		totalBytes += bytes.byteLength;
		if (bytes.byteLength === 0
			|| bytes.byteLength > maximumVideoAnalysisFrameBytes
			|| totalBytes > maximumVideoAnalysisBytes
			|| bytes[0] !== 0xFF
			|| bytes[1] !== 0xD8
			|| bytes.at(-2) !== 0xFF
			|| bytes.at(-1) !== 0xD9) {
			throw new VideoToolError('output-too-large', 'Focused video frames exceed the analysis limit.');
		}

		return {
			bytes,
			mimeType: 'image/jpeg',
			reasons: ['sample'],
			sourceMessageId,
			timestampSeconds: timestamps[index],
		};
	}));
}

function normalizeReasons(reasons: ReadonlySet<VideoFrameReason>): VideoFrameReason[] {
	const order: VideoFrameReason[] = ['opening', 'closing', 'scene-change', 'sample'];
	return order.filter(reason => reasons.has(reason));
}

export class VideoFramePreprocessor {
	constructor(
		private readonly runner: ProcessRunner = new BoundedProcessRunner(),
		private readonly locateVideoTools: LocateVideoTools = findMacVideoTools,
	) {}

	async preprocess(
		filePath: string,
		request: Readonly<VideoPreprocessingRequest>,
		options: PreprocessVideoOptions = {},
	): Promise<VideoPreprocessingArtifact> {
		const {metadata, sourceMessageId, transcript} = request;
		if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || filePath.includes('\u0000')) {
			throw new VideoToolError('unsupported-video', 'This video file cannot be processed.');
		}

		if (!sourceMessageId
			|| sourceMessageId.length > 512
			|| [...sourceMessageId].some(character => character.codePointAt(0)! < 32)) {
			throw new VideoToolError('malformed-metadata', 'The source message identifier is invalid.');
		}

		validateMetadata(metadata);
		const frozenTranscript = cloneTranscript(transcript, metadata.durationSeconds);
		failIfUnavailable(options);
		report(options, 'checking-tools', 0, 0);
		const tools = await this.locateVideoTools();
		failIfUnavailable(options);

		const outputDirectory = path.join(path.dirname(filePath), `video-frames-${randomUUID()}`);
		await mkdir(outputDirectory, {mode: 0o700});
		try {
			report(options, 'detecting-scenes', 0, sceneChangeReserve);
			const sceneResult = await this.runFfmpeg(tools.ffmpeg, [
				'-nostdin',
				'-v',
				'info',
				'-protocol_whitelist',
				'file',
				'-format_whitelist',
				allowedVideoInputFormats,
				'-i',
				filePath,
				'-map',
				'0:v:0',
				'-vf',
				`select='gt(scene\\,${videoSceneChangeThreshold})',showinfo`,
				'-an',
				'-frames:v',
				String(sceneChangeReserve + 1),
				'-f',
				'null',
				'-',
			], options);
			const sceneFrames = parseShowInfoFrames(sceneResult.stderr);
			if (new Set(sceneFrames.map(frame => frame.pts)).size > sceneChangeReserve) {
				throw new VideoToolError('output-too-large', 'This video has too many scene changes for bounded analysis.');
			}

			report(options, 'detecting-scenes', sceneFrames.length, sceneChangeReserve);
			const closingTarget = Math.max(0, metadata.durationSeconds - Math.max(1 / metadata.frameRate, 0.001));
			const boundaryResult = await this.runFfmpeg(tools.ffmpeg, [
				'-nostdin',
				'-v',
				'info',
				'-protocol_whitelist',
				'file',
				'-format_whitelist',
				allowedVideoInputFormats,
				'-i',
				filePath,
				'-map',
				'0:v:0',
				'-vf',
				`select='eq(n\\,0)+gte(t\\,${closingTarget})',showinfo`,
				'-an',
				'-frames:v',
				'2',
				'-f',
				'null',
				'-',
			], options);
			const boundaryFrames = parseShowInfoFrames(boundaryResult.stderr);
			if (boundaryFrames.length === 0 || boundaryFrames.length > 2) {
				throw new VideoToolError('process-failed', 'Video boundary frames could not be read.');
			}

			const protectedPts = new Set([...sceneFrames, ...boundaryFrames].map(frame => frame.pts));
			const maximumSamples = maximumVideoAnalysisFrames - protectedPts.size;
			let sampleFrames: ShowInfoFrame[] = [];
			if (maximumSamples > 0) {
				const samplingResult = await this.runFfmpeg(tools.ffmpeg, [
					'-nostdin',
					'-v',
					'info',
					'-protocol_whitelist',
					'file',
					'-format_whitelist',
					allowedVideoInputFormats,
					'-i',
					filePath,
					'-map',
					'0:v:0',
					'-vf',
					`select='${samplingSelectionExpression(metadata.durationSeconds, maximumSamples)}',showinfo`,
					'-an',
					'-frames:v',
					String(maximumVideoAnalysisFrames + 1),
					'-f',
					'null',
					'-',
				], options);
				sampleFrames = parseShowInfoFrames(samplingResult.stderr);
				if (sampleFrames.length > maximumVideoAnalysisFrames) {
					throw new VideoToolError('output-too-large', 'This video has too many sample frames for bounded analysis.');
				}
			}

			const candidates = candidateFrames(metadata, boundaryFrames, sceneFrames, sampleFrames);
			const outputPattern = path.join(outputDirectory, '%03d.jpg');
			report(options, 'extracting-frames', 0, candidates.length);
			const extractionResult = await this.runFfmpeg(tools.ffmpeg, [
				'-nostdin',
				'-v',
				'info',
				'-protocol_whitelist',
				'file',
				'-format_whitelist',
				allowedVideoInputFormats,
				'-i',
				filePath,
				'-map',
				'0:v:0',
				'-vf',
				`select='${selectExpression(candidates)}',scale=w='min(640\\,iw)':h=-2:flags=lanczos,showinfo`,
				'-an',
				'-fps_mode',
				'vfr',
				'-frames:v',
				String(candidates.length),
				'-q:v',
				'5',
				'-f',
				'image2',
				outputPattern,
			], options);
			const extractedTimestamps = parseShowInfoTimestamps(extractionResult.stderr);
			failIfUnavailable(options);
			report(options, 'extracting-frames', candidates.length, candidates.length);

			const signaturePath = path.join(outputDirectory, 'signatures.gray');
			await this.runFfmpeg(tools.ffmpeg, [
				'-nostdin',
				'-v',
				'error',
				'-f',
				'image2',
				'-start_number',
				'1',
				'-i',
				outputPattern,
				'-vf',
				'scale=8:8:flags=area,format=gray',
				'-frames:v',
				String(candidates.length),
				'-f',
				'rawvideo',
				signaturePath,
			], options);
			failIfUnavailable(options);

			report(options, 'deduplicating-frames', 0, candidates.length);
			const extracted = await readFrames(outputDirectory, candidates, extractedTimestamps);
			const retained: typeof extracted = [];
			for (const frame of extracted) {
				const duplicate = retained.some(candidate => hammingDistance(candidate.signature, frame.signature) <= perceptualDuplicateDistance);
				if (isProtected(frame.candidate) || !duplicate) {
					retained.push(frame);
				}
			}

			if (retained.length === 0 || retained.length > maximumVideoAnalysisFrames) {
				throw new VideoToolError('output-too-large', 'Video frame analysis did not produce a bounded timeline.');
			}

			for (let index = 0; index < retained.length; index += 1) {
				const timestamp = retained[index].timestampSeconds;
				if (!Number.isFinite(timestamp)
					|| timestamp < 0
					|| timestamp > metadata.durationSeconds
					|| (index > 0 && timestamp <= retained[index - 1].timestampSeconds)) {
					throw new VideoToolError('process-failed', 'Video frame timestamps are invalid.');
				}
			}

			report(options, 'deduplicating-frames', candidates.length, candidates.length);
			failIfUnavailable(options);
			report(options, 'assembling-artifact', retained.length, retained.length);
			failIfUnavailable(options);
			return {
				coverage: metadata.durationSeconds > 300 ? 'sparse' : 'balanced',
				frameCount: retained.length,
				frameTimeline: retained.map(frame => ({
					bytes: frame.bytes,
					mimeType: 'image/jpeg',
					reasons: normalizeReasons(frame.candidate.reasons),
					sourceMessageId,
					timestampSeconds: frame.timestampSeconds,
				})),
				metadata: {...metadata},
				samplingConfiguration: {
					bands: videoFrameSamplingBands,
					maximumFrames: maximumVideoAnalysisFrames,
					sceneChangeThreshold: videoSceneChangeThreshold,
				},
				transcript: frozenTranscript,
			};
		} finally {
			await rm(outputDirectory, {force: true, recursive: true});
		}
	}

	async extractFocusedFrames(
		filePath: string,
		sourceMessageId: string,
		durationSeconds: number,
		intervals: ReadonlyArray<Readonly<VideoFocusIntervalRequest>>,
		options: PreprocessVideoOptions = {},
	): Promise<VideoAnalysisFrame[]> {
		if (typeof filePath !== 'string'
			|| !path.isAbsolute(filePath)
			|| filePath.includes('\u0000')
			|| !sourceMessageId
			|| sourceMessageId.length > 512
			|| !Number.isFinite(durationSeconds)
			|| durationSeconds <= 0
			|| intervals.length === 0
			|| intervals.length > maximumVideoFocusIntervals) {
			throw new VideoToolError('malformed-metadata', 'Focused video extraction parameters are invalid.');
		}

		for (const interval of intervals) {
			if (!Number.isFinite(interval.startSeconds)
				|| !Number.isFinite(interval.endSeconds)
				|| interval.startSeconds < 0
				|| interval.endSeconds < interval.startSeconds
				|| interval.endSeconds > durationSeconds
				|| interval.endSeconds - interval.startSeconds > 1.5) {
				throw new VideoToolError('malformed-metadata', 'Focused video extraction intervals are invalid.');
			}
		}

		failIfUnavailable(options);
		const tools = await this.locateVideoTools();
		const outputDirectory = path.join(path.dirname(filePath), `video-focus-${randomUUID()}`);
		await mkdir(outputDirectory, {mode: 0o700});
		try {
			const selection = intervals
				.map(interval => `between(t\\,${interval.startSeconds}\\,${interval.endSeconds})`)
				.join('+');
			const outputPattern = path.join(outputDirectory, 'focus-%03d.jpg');
			const result = await this.runFfmpeg(tools.ffmpeg, [
				'-nostdin',
				'-v',
				'info',
				'-protocol_whitelist',
				'file',
				'-format_whitelist',
				allowedVideoInputFormats,
				'-i',
				filePath,
				'-map',
				'0:v:0',
				'-vf',
				`fps=4,select='${selection}',scale=w='min(1280\\,iw)':h=-2:flags=lanczos,showinfo`,
				'-an',
				'-fps_mode',
				'vfr',
				'-frames:v',
				String(maximumVideoFocusedFrames + 1),
				'-q:v',
				'3',
				'-f',
				'image2',
				outputPattern,
			], options);
			const timestamps = parseShowInfoTimestamps(result.stderr);
			if (timestamps.length > maximumVideoFocusedFrames) {
				throw new VideoToolError('output-too-large', 'Focused video analysis selected too many frames.');
			}

			failIfUnavailable(options);
			return await readFocusedFrames(outputDirectory, timestamps, sourceMessageId);
		} finally {
			await rm(outputDirectory, {force: true, recursive: true});
		}
	}

	private async runFfmpeg(
		executable: string,
		arguments_: readonly string[],
		options: Readonly<PreprocessVideoOptions>,
	): Promise<ProcessResult> {
		failIfUnavailable(options);
		try {
			const result = await this.runner.run(executable, arguments_, options.signal);
			failIfUnavailable(options);
			return result;
		} catch (error) {
			if (error instanceof VideoToolError
				&& error.code === 'process-failed'
				&& error.exitCode !== undefined) {
				throw new VideoToolError('unsupported-video', 'This video file is corrupt or unsupported.');
			}

			throw error;
		}
	}
}
