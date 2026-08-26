import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {promisify} from 'node:util';
import {ConversationSnapshot} from './ai-assist-state';
import {MediaKind} from './media-contract';
import {ResolvedMedia, MessengerMediaResolver, MediaResolverError} from './media-resolver';
import {VideoAudioExtractor, VideoToolError} from './video-toolchain';

export const openAiTranscriptionModel = 'whisper-1';
export const maximumTranscriptionBytes = 20 * 1024 * 1024;
export const maximumTranscriptionDurationSeconds = 5 * 60;
export const maximumTranscriptionItems = 2;
export const maximumTranscriptSegments = 1000;
export const maximumTranscriptCharacters = 100_000;

const openAiTranscriptionEndpoint = 'https://api.openai.com/v1/audio/transcriptions';
const defaultTimeoutMilliseconds = 60_000;
const defaultMaximumAttempts = 2;
const defaultRetryDelayMilliseconds = 250;
const maximumProviderResponseCharacters = 1_000_000;

export type TranscriptSegment = {
	startSeconds: number;
	endSeconds: number;
	text: string;
};

export type OpenAiTranscription = {
	model: typeof openAiTranscriptionModel;
	segments: TranscriptSegment[];
};

export type MediaTranscription = OpenAiTranscription & {
	mediaSha256: string;
	source: {
		byteLength: number;
		durationSeconds: number;
		kind: MediaKind;
		messageId: string;
		mimeType: string;
	};
};

export type NoAudioMediaTranscription = {
	status: 'no-audio';
	source: {
		byteLength: number;
		durationSeconds: number;
		kind: 'video';
		messageId: string;
		mimeType: string;
	};
};

export type MediaTranscriptionResult = MediaTranscription | NoAudioMediaTranscription;
export type MediaTranscriptionPhase = 'extracting-audio' | 'transcribing';

export const transcriptCacheSchemaVersion = 1;

export type TranscriptCacheRecord = {
	model: typeof openAiTranscriptionModel;
	schemaVersion: typeof transcriptCacheSchemaVersion;
	segments: TranscriptSegment[];
};

export type TranscriptCacheStore = {
	deleteTranscriptCache(mediaSha256: string): void;
	getTranscriptCacheGeneration(): number;
	loadTranscriptCache(mediaSha256: string): unknown;
	saveTranscriptCache(mediaSha256: string, record: TranscriptCacheRecord, expectedGeneration: number): void;
};

export const transcriptionErrorCodes = [
	'authentication',
	'cancelled',
	'duration-exceeded',
	'invalid-consent',
	'item-limit',
	'local-tools-unavailable',
	'malformed-cache',
	'malformed-response',
	'missing-key',
	'oversized',
	'provider-unavailable',
	'rate-limit',
	'stale-media',
	'timeout',
	'unsupported-media',
] as const;

export type TranscriptionErrorCode = typeof transcriptionErrorCodes[number];

export class TranscriptionError extends Error {
	constructor(
		readonly code: TranscriptionErrorCode,
		message: string,
	) {
		super(message);
		this.name = 'TranscriptionError';
	}
}

type OpenAiTranscriptionClientOptions = {
	fetchImplementation?: typeof fetch;
	maximumAttempts?: number;
	retryDelayMilliseconds?: number;
	timeoutMilliseconds?: number;
};

export type MediaTranscriptionRequest = {
	consent: 'transcribe-and-review';
	items: ReadonlyArray<{
		handleId: string;
		messageId: string;
	}>;
	snapshot: Readonly<ConversationSnapshot>;
};

type MediaHandleStore = Pick<MessengerMediaResolver, 'describeHandle' | 'releaseHandle' | 'withFile'>;
type MediaDurationInspector = (filePath: string) => Promise<number>;
type TranscribableMediaFile = {
	bytes: Uint8Array;
	durationSeconds: number;
	media: ResolvedMedia;
	providerMimeType: string;
};
type ResolvedMediaFile = TranscribableMediaFile | {
	durationSeconds: number;
	media: ResolvedMedia & {kind: 'video'};
	status: 'no-audio';
};
type MediaFilesContext<T> = {
	callback: (files: ResolvedMediaFile[]) => Promise<T>;
	files: ResolvedMediaFile[];
	index: number;
	inspectDuration: MediaDurationInspector;
	mediaHandles: MediaHandleStore;
	onPhase?: (phase: MediaTranscriptionPhase) => void;
	request: Readonly<MediaTranscriptionRequest>;
	signal?: AbortSignal;
	videoAudioExtractor: VideoAudioExtractor;
};

const execFileAsync = promisify(execFile);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function normalizeCachedTranscript(value: unknown): OpenAiTranscription {
	if (!isRecord(value)
		|| value.schemaVersion !== transcriptCacheSchemaVersion
		|| value.model !== openAiTranscriptionModel
		|| !Array.isArray(value.segments)) {
		throw new TranscriptionError('malformed-cache', 'The saved transcript is invalid. Choose Transcribe and review again to retry.');
	}

	try {
		return {
			model: openAiTranscriptionModel,
			segments: normalizeTranscriptSegments({
				segments: value.segments.map(segment => {
					if (!isRecord(segment)) {
						throw new TranscriptionError('malformed-cache', 'The saved transcript is invalid. Choose Transcribe and review again to retry.');
					}

					return {
						end: segment.endSeconds,
						start: segment.startSeconds,
						text: segment.text,
					};
				}),
			}),
		};
	} catch {
		throw new TranscriptionError('malformed-cache', 'The saved transcript is invalid. Choose Transcribe and review again to retry.');
	}
}

function evictCachedTranscript(cache: TranscriptCacheStore, mediaSha256: string): void {
	try {
		cache.deleteTranscriptCache(mediaSha256);
	} catch {}
}

function sameSnapshot(left: Readonly<ConversationSnapshot>, right: Readonly<ConversationSnapshot> | undefined): boolean {
	return Boolean(right)
		&& left.captureGeneration === right!.captureGeneration
		&& left.conversationId === right!.conversationId
		&& left.messengerWebContentsId === right!.messengerWebContentsId
		&& left.sessionId === right!.sessionId;
}

function transcriptionFileExtension(mimeType: string): string | undefined {
	switch (mimeType) {
		case 'audio/flac':
		case 'audio/x-flac': {
			return 'flac';
		}

		case 'audio/mpeg':
		case 'audio/mp3': {
			return 'mp3';
		}

		case 'audio/mp4': {
			return 'mp4';
		}

		case 'audio/m4a':
		case 'audio/x-m4a': {
			return 'm4a';
		}

		case 'audio/ogg': {
			return 'ogg';
		}

		case 'audio/wav':
		case 'audio/x-wav': {
			return 'wav';
		}

		case 'audio/webm': {
			return 'webm';
		}

		default: {
			return undefined;
		}
	}
}

function validateClientInput(apiKey: string, bytes: Uint8Array, mimeType: string): string {
	if (!apiKey) {
		throw new TranscriptionError('missing-key', 'Add an OpenAI API key in Settings first.');
	}

	if (bytes.byteLength === 0 || bytes.byteLength > maximumTranscriptionBytes) {
		throw new TranscriptionError('oversized', 'Audio exceeds the transcription limit.');
	}

	const extension = transcriptionFileExtension(mimeType);
	if (!extension) {
		throw new TranscriptionError('unsupported-media', 'This audio format is not supported for transcription.');
	}

	return extension;
}

function errorForStatus(status: number): TranscriptionError {
	if (status === 401 || status === 403) {
		return new TranscriptionError('authentication', 'OpenAI rejected the API key. Replace it in Settings.');
	}

	if (status === 413) {
		return new TranscriptionError('oversized', 'Audio exceeds the transcription limit.');
	}

	if (status === 429) {
		return new TranscriptionError('rate-limit', 'OpenAI is rate limiting transcription requests. Wait a moment and try again.');
	}

	if (status >= 500) {
		return new TranscriptionError('provider-unavailable', 'OpenAI transcription is unavailable right now. Try again later.');
	}

	return new TranscriptionError('unsupported-media', 'OpenAI could not transcribe this audio format.');
}

function isRetryableStatus(status: number): boolean {
	return status === 429 || status >= 500;
}

async function waitForRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		if (signal.aborted) {
			reject(new DOMException('Aborted', 'AbortError'));
			return;
		}

		const timeout = setTimeout(() => {
			signal.removeEventListener('abort', abort);
			resolve();
		}, milliseconds);
		const abort = (): void => {
			clearTimeout(timeout);
			reject(new DOMException('Aborted', 'AbortError'));
		};

		signal.addEventListener('abort', abort, {once: true});
	});
}

export function normalizeTranscriptSegments(value: unknown): TranscriptSegment[] {
	if (!isRecord(value)
		|| !Array.isArray(value.segments)
		|| value.segments.length === 0
		|| value.segments.length > maximumTranscriptSegments) {
		throw new TranscriptionError('malformed-response', 'OpenAI returned an unreadable timestamped transcript. Try again.');
	}

	let previousEnd = 0;
	let transcriptCharacters = 0;
	return value.segments.map(segment => {
		if (!isRecord(segment)
			|| typeof segment.start !== 'number'
			|| !Number.isFinite(segment.start)
			|| segment.start < previousEnd
			|| typeof segment.end !== 'number'
			|| !Number.isFinite(segment.end)
			|| segment.end <= segment.start
			|| segment.end > maximumTranscriptionDurationSeconds
			|| typeof segment.text !== 'string') {
			throw new TranscriptionError('malformed-response', 'OpenAI returned an unreadable timestamped transcript. Try again.');
		}

		const text = segment.text.trim();
		transcriptCharacters += text.length;
		if (!text || transcriptCharacters > maximumTranscriptCharacters) {
			throw new TranscriptionError('malformed-response', 'OpenAI returned an unreadable timestamped transcript. Try again.');
		}

		previousEnd = segment.end;
		return {
			endSeconds: segment.end,
			startSeconds: segment.start,
			text,
		};
	});
}

export class OpenAiTranscriptionClient {
	private readonly fetchImplementation: typeof fetch;
	private readonly maximumAttempts: number;
	private readonly retryDelayMilliseconds: number;
	private readonly timeoutMilliseconds: number;

	constructor(options: OpenAiTranscriptionClientOptions = {}) {
		this.fetchImplementation = options.fetchImplementation ?? fetch;
		this.maximumAttempts = options.maximumAttempts ?? defaultMaximumAttempts;
		this.retryDelayMilliseconds = options.retryDelayMilliseconds ?? defaultRetryDelayMilliseconds;
		this.timeoutMilliseconds = options.timeoutMilliseconds ?? defaultTimeoutMilliseconds;
		if (!Number.isSafeInteger(this.maximumAttempts) || this.maximumAttempts < 1 || this.maximumAttempts > defaultMaximumAttempts) {
			throw new TypeError(`Transcription attempts must be between 1 and ${defaultMaximumAttempts}.`);
		}
	}

	async transcribe(
		apiKey: string,
		bytes: Uint8Array,
		mimeType: string,
		signal?: AbortSignal,
	): Promise<OpenAiTranscription> {
		const extension = validateClientInput(apiKey, bytes, mimeType);

		const requestController = new AbortController();
		let timedOut = false;
		const cancelRequest = (): void => {
			requestController.abort();
		};

		if (signal?.aborted) {
			cancelRequest();
		} else {
			signal?.addEventListener('abort', cancelRequest, {once: true});
		}

		const timeout = setTimeout(() => {
			timedOut = true;
			requestController.abort();
		}, this.timeoutMilliseconds);
		try {
			let lastError: TranscriptionError | undefined;
			for (let attempt = 1; attempt <= this.maximumAttempts; attempt += 1) {
				try {
					const form = new FormData();
					form.append('file', new Blob([bytes], {type: mimeType}), `messenger-audio.${extension}`);
					form.append('model', openAiTranscriptionModel);
					form.append('response_format', 'verbose_json');
					form.append('timestamp_granularities[]', 'segment');
					form.append('temperature', '0');
					// eslint-disable-next-line no-await-in-loop
					const response = await this.fetchImplementation(openAiTranscriptionEndpoint, {
						body: form,
						headers: {Authorization: `Bearer ${apiKey}`},
						method: 'POST',
						redirect: 'error',
						signal: requestController.signal,
					});
					if (!response.ok && attempt < this.maximumAttempts && isRetryableStatus(response.status)) {
						// eslint-disable-next-line no-await-in-loop
						await waitForRetry(this.retryDelayMilliseconds, requestController.signal);
						continue;
					}

					if (!response.ok) {
						lastError = errorForStatus(response.status);
						throw lastError;
					}

					// eslint-disable-next-line no-await-in-loop
					const responseText = await response.text();
					if (responseText.length === 0 || responseText.length > maximumProviderResponseCharacters) {
						throw new TranscriptionError('malformed-response', 'OpenAI returned an unreadable timestamped transcript. Try again.');
					}

					let value: unknown;
					try {
						value = JSON.parse(responseText);
					} catch {
						throw new TranscriptionError('malformed-response', 'OpenAI returned an unreadable timestamped transcript. Try again.');
					}

					return {model: openAiTranscriptionModel, segments: normalizeTranscriptSegments(value)};
				} catch (error) {
					if (error instanceof TranscriptionError) {
						throw error;
					}

					if (requestController.signal.aborted) {
						break;
					}

					lastError = new TranscriptionError('provider-unavailable', 'Could not reach OpenAI transcription. Check your connection and try again.');
					if (attempt < this.maximumAttempts) {
						// eslint-disable-next-line no-await-in-loop
						await waitForRetry(this.retryDelayMilliseconds, requestController.signal);
						continue;
					}

					throw lastError;
				}
			}

			if (signal?.aborted) {
				throw new TranscriptionError('cancelled', 'Transcription cancelled.');
			}

			if (timedOut) {
				throw new TranscriptionError('timeout', 'OpenAI took too long to transcribe this audio. Try again.');
			}

			throw lastError ?? new TranscriptionError('provider-unavailable', 'Could not reach OpenAI transcription. Check your connection and try again.');
		} finally {
			clearTimeout(timeout);
			signal?.removeEventListener('abort', cancelRequest);
		}
	}
}

function validateMedia(media: ResolvedMedia): void {
	if (media.kind === 'audio' && !transcriptionFileExtension(media.mimeType)) {
		throw new TranscriptionError('unsupported-media', 'This media item is not supported audio.');
	}

	if (media.kind === 'video' && !media.mimeType.startsWith('video/')) {
		throw new TranscriptionError('unsupported-media', 'This media item is not a supported video.');
	}

	if (media.byteLength <= 0 || (media.kind === 'audio' && media.byteLength > maximumTranscriptionBytes)) {
		throw new TranscriptionError('oversized', 'Audio exceeds the 20 MB transcription limit.');
	}
}

export async function inspectAudioDuration(filePath: string): Promise<number> {
	try {
		const {stdout} = await execFileAsync('/usr/bin/afinfo', [filePath], {
			encoding: 'utf8',
			maxBuffer: 100_000,
			timeout: 10_000,
		});
		const match = /^estimated duration:\s*([0-9]+(?:\.[0-9]+)?)\s*sec\s*$/imu.exec(stdout);
		const durationSeconds = Number(match?.[1]);
		if (Number.isFinite(durationSeconds) && durationSeconds > 0) {
			return durationSeconds;
		}
	} catch {}

	throw new TranscriptionError('unsupported-media', 'Voice-message duration could not be verified locally.');
}

function validateDuration(durationSeconds: number): void {
	if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
		throw new TranscriptionError('unsupported-media', 'Voice-message duration could not be verified locally.');
	}

	if (durationSeconds > maximumTranscriptionDurationSeconds) {
		throw new TranscriptionError('duration-exceeded', 'Audio exceeds the 5 minute transcription limit.');
	}
}

async function withMediaFiles<T>(context: MediaFilesContext<T>): Promise<T> {
	const {callback, files, index, inspectDuration, mediaHandles, onPhase, request, signal, videoAudioExtractor} = context;
	if (signal?.aborted) {
		throw new TranscriptionError('cancelled', 'Transcription cancelled.');
	}

	if (index === request.items.length) {
		return callback(files);
	}

	const item = request.items[index];
	return mediaHandles.withFile(item.handleId, item.messageId, request.snapshot, async (filePath, media) => {
		validateMedia(media);
		if (media.kind === 'video') {
			const videoMedia = media as ResolvedMedia & {kind: 'video'};
			const extraction = await videoAudioExtractor.extract(filePath, {
				onPhase(phase) {
					if (phase === 'extracting-audio') {
						onPhase?.(phase);
					}
				},
				signal,
			});
			if (!extraction.audioTrackAvailable) {
				files.push({durationSeconds: extraction.durationSeconds, media: videoMedia, status: 'no-audio'});
				return withMediaFiles({...context, index: index + 1});
			}

			validateDuration(extraction.durationSeconds);
			files.push({
				bytes: extraction.bytes,
				durationSeconds: extraction.durationSeconds,
				media: videoMedia,
				providerMimeType: extraction.mimeType,
			});
			return withMediaFiles({...context, index: index + 1});
		}

		const [fileBytes, durationSeconds] = await Promise.all([
			readFile(filePath),
			inspectDuration(filePath),
		]);
		const bytes = new Uint8Array(fileBytes);
		if (bytes.byteLength !== media.byteLength || bytes.byteLength > maximumTranscriptionBytes) {
			throw new TranscriptionError('stale-media', 'The selected media changed before transcription.');
		}

		validateDuration(durationSeconds);
		files.push({
			bytes,
			durationSeconds,
			media,
			providerMimeType: media.mimeType,
		});
		return withMediaFiles({...context, index: index + 1});
	});
}

function mapResolverError(error: unknown): never {
	if (error instanceof TranscriptionError) {
		throw error;
	}

	if (error instanceof MediaResolverError) {
		if (error.code === 'oversized') {
			throw new TranscriptionError('oversized', 'Audio exceeds the transcription limit.');
		}

		if (error.code === 'aborted') {
			throw new TranscriptionError('cancelled', 'Transcription cancelled.');
		}

		throw new TranscriptionError('stale-media', 'The selected media no longer belongs to this conversation.');
	}

	if (error instanceof VideoToolError) {
		switch (error.code) {
			case 'cancelled': {
				throw new TranscriptionError('cancelled', 'Transcription cancelled.');
			}

			case 'duration-exceeded': {
				throw new TranscriptionError('duration-exceeded', error.message);
			}

			case 'output-too-large': {
				throw new TranscriptionError('oversized', 'Extracted video audio exceeds the transcription limit.');
			}

			case 'timeout': {
				throw new TranscriptionError('timeout', 'Video audio extraction timed out. Try again.');
			}

			case 'tools-unavailable': {
				throw new TranscriptionError('local-tools-unavailable', error.message);
			}

			default: {
				throw new TranscriptionError('unsupported-media', 'This video audio track is corrupt or unsupported.');
			}
		}
	}

	throw new TranscriptionError('stale-media', 'The selected media is no longer available for transcription.');
}

export class MediaTranscriptionService {
	private readonly inspectDuration: MediaDurationInspector;
	private readonly transcriptCache?: TranscriptCacheStore;
	private readonly videoAudioExtractor: VideoAudioExtractor;

	constructor(
		private readonly mediaHandles: MediaHandleStore,
		private readonly client: OpenAiTranscriptionClient,
		private readonly currentSnapshot: () => Readonly<ConversationSnapshot> | undefined,
		options: MediaDurationInspector | {
			inspectDuration?: MediaDurationInspector;
			transcriptCache?: TranscriptCacheStore;
			videoAudioExtractor?: VideoAudioExtractor;
		} = {},
	) {
		if (typeof options === 'function') {
			this.inspectDuration = options;
			this.videoAudioExtractor = new VideoAudioExtractor();
			return;
		}

		this.inspectDuration = options.inspectDuration ?? inspectAudioDuration;
		this.transcriptCache = options.transcriptCache;
		this.videoAudioExtractor = options.videoAudioExtractor ?? new VideoAudioExtractor();
	}

	async transcribeBatch(
		apiKey: string | (() => string),
		request: Readonly<MediaTranscriptionRequest>,
		signal?: AbortSignal,
		onPhase?: (phase: MediaTranscriptionPhase) => void,
	): Promise<MediaTranscriptionResult[]> {
		try {
			if (request.consent !== 'transcribe-and-review') {
				throw new TranscriptionError('invalid-consent', 'Choose Transcribe and review before sending media to OpenAI.');
			}

			if (request.items.length === 0 || request.items.length > maximumTranscriptionItems) {
				throw new TranscriptionError('item-limit', `At most ${maximumTranscriptionItems} audio or video items can be transcribed in one AI request.`);
			}

			const uniqueHandles = new Set(request.items.map(item => item.handleId));
			if (uniqueHandles.size !== request.items.length) {
				throw new TranscriptionError('item-limit', 'Each selected media item can be transcribed only once per AI request.');
			}

			if (!sameSnapshot(request.snapshot, this.currentSnapshot())) {
				throw new TranscriptionError('stale-media', 'The selected media no longer belongs to this conversation.');
			}

			if (signal?.aborted) {
				throw new TranscriptionError('cancelled', 'Transcription cancelled.');
			}

			for (const item of request.items) {
				const media = this.mediaHandles.describeHandle(item.handleId, item.messageId, request.snapshot);
				validateMedia(media);
			}

			return await withMediaFiles({
				callback: async files => {
					if (signal?.aborted) {
						throw new TranscriptionError('cancelled', 'Transcription cancelled.');
					}

					if (!sameSnapshot(request.snapshot, this.currentSnapshot())) {
						throw new TranscriptionError('stale-media', 'The selected media no longer belongs to this conversation.');
					}

					for (const item of request.items) {
						this.mediaHandles.describeHandle(item.handleId, item.messageId, request.snapshot);
					}

					const transcriptions: MediaTranscriptionResult[] = [];
					const pendingCacheWrites: Array<{mediaSha256: string; record: TranscriptCacheRecord}> = [];
					const transcriptCacheGeneration = this.transcriptCache?.getTranscriptCacheGeneration();
					let providerApiKey: string | undefined;
					for (const [index, file] of files.entries()) {
						const item = request.items[index];
						this.mediaHandles.describeHandle(item.handleId, item.messageId, request.snapshot);
						if ('status' in file) {
							transcriptions.push({
								source: {
									byteLength: file.media.byteLength,
									durationSeconds: file.durationSeconds,
									kind: 'video',
									messageId: file.media.messageId,
									mimeType: file.media.mimeType,
								},
								status: 'no-audio',
							});
							continue;
						}

						const mediaSha256 = createHash('sha256').update(file.bytes).digest('hex');
						let cacheHit = false;
						let transcript: OpenAiTranscription | undefined;
						if (this.transcriptCache) {
							let cached: unknown;
							try {
								cached = this.transcriptCache.loadTranscriptCache(mediaSha256);
							} catch {
								evictCachedTranscript(this.transcriptCache, mediaSha256);
								throw new TranscriptionError('malformed-cache', 'The saved transcript is invalid. Choose Transcribe and review again to retry.');
							}

							if (cached !== undefined) {
								try {
									transcript = normalizeCachedTranscript(cached);
									cacheHit = true;
								} catch (error) {
									evictCachedTranscript(this.transcriptCache, mediaSha256);
									throw error;
								}
							}
						}

						if (!transcript) {
							providerApiKey ??= typeof apiKey === 'function' ? apiKey() : apiKey;
							onPhase?.('transcribing');
							// eslint-disable-next-line no-await-in-loop
							transcript = await this.client.transcribe(providerApiKey, file.bytes, file.providerMimeType, signal);
						}

						if (signal?.aborted) {
							throw new TranscriptionError('cancelled', 'Transcription cancelled.');
						}

						if (!sameSnapshot(request.snapshot, this.currentSnapshot())) {
							throw new TranscriptionError('stale-media', 'The conversation changed before transcription completed.');
						}

						this.mediaHandles.describeHandle(item.handleId, item.messageId, request.snapshot);
						if (!cacheHit) {
							pendingCacheWrites.push({
								mediaSha256,
								record: {
									model: transcript.model,
									schemaVersion: transcriptCacheSchemaVersion,
									segments: transcript.segments.map(segment => ({...segment})),
								},
							});
						}

						transcriptions.push({
							...transcript,
							mediaSha256,
							source: {
								byteLength: file.bytes.byteLength,
								durationSeconds: file.durationSeconds,
								kind: file.media.kind,
								messageId: file.media.messageId,
								mimeType: file.providerMimeType,
							},
						});
					}

					if (this.transcriptCache && transcriptCacheGeneration !== undefined) {
						for (const pendingWrite of pendingCacheWrites) {
							try {
								this.transcriptCache.saveTranscriptCache(
									pendingWrite.mediaSha256,
									pendingWrite.record,
									transcriptCacheGeneration,
								);
							} catch {}
						}
					}

					return transcriptions;
				},
				files: [],
				index: 0,
				inspectDuration: this.inspectDuration,
				mediaHandles: this.mediaHandles,
				onPhase,
				request,
				signal,
				videoAudioExtractor: this.videoAudioExtractor,
			});
		} catch (error) {
			mapResolverError(error);
		} finally {
			await Promise.all(request.items.map(async item => this.mediaHandles.releaseHandle(item.handleId).catch(() => undefined)));
		}
	}
}
