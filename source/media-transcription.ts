import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {promisify} from 'node:util';
import {ConversationSnapshot} from './ai-assist-state';
import {ResolvedMedia, MessengerMediaResolver, MediaResolverError} from './media-resolver';

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
		kind: 'audio';
		messageId: string;
		mimeType: string;
	};
};

export const transcriptionErrorCodes = [
	'authentication',
	'cancelled',
	'duration-exceeded',
	'invalid-consent',
	'item-limit',
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
type ResolvedMediaFile = {
	bytes: Uint8Array;
	durationSeconds: number;
	media: ResolvedMedia & {kind: 'audio'};
};
type MediaFilesContext<T> = {
	callback: (files: ResolvedMediaFile[]) => Promise<T>;
	files: ResolvedMediaFile[];
	index: number;
	inspectDuration: MediaDurationInspector;
	mediaHandles: MediaHandleStore;
	request: Readonly<MediaTranscriptionRequest>;
};

const execFileAsync = promisify(execFile);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
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

function validateMedia(media: ResolvedMedia): asserts media is ResolvedMedia & {kind: 'audio'} {
	if (media.kind !== 'audio' || !transcriptionFileExtension(media.mimeType)) {
		throw new TranscriptionError('unsupported-media', 'This media item is not a supported voice message.');
	}

	if (media.byteLength <= 0 || media.byteLength > maximumTranscriptionBytes) {
		throw new TranscriptionError('oversized', 'Audio exceeds the 20 MB transcription limit.');
	}
}

async function inspectAudioDuration(filePath: string): Promise<number> {
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
	const {callback, files, index, inspectDuration, mediaHandles, request} = context;
	if (index === request.items.length) {
		return callback(files);
	}

	const item = request.items[index];
	return mediaHandles.withFile(item.handleId, item.messageId, request.snapshot, async (filePath, media) => {
		validateMedia(media);
		const [fileBytes, durationSeconds] = await Promise.all([
			readFile(filePath),
			inspectDuration(filePath),
		]);
		const bytes = new Uint8Array(fileBytes);
		if (bytes.byteLength !== media.byteLength || bytes.byteLength > maximumTranscriptionBytes) {
			throw new TranscriptionError('stale-media', 'The selected media changed before transcription.');
		}

		validateDuration(durationSeconds);
		files.push({bytes, durationSeconds, media});
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

	throw new TranscriptionError('stale-media', 'The selected media is no longer available for transcription.');
}

export class MediaTranscriptionService {
	constructor(
		private readonly mediaHandles: MediaHandleStore,
		private readonly client: OpenAiTranscriptionClient,
		private readonly currentSnapshot: () => Readonly<ConversationSnapshot> | undefined,
		private readonly inspectDuration: MediaDurationInspector = inspectAudioDuration,
	) {}

	async transcribeBatch(
		apiKey: string,
		request: Readonly<MediaTranscriptionRequest>,
		signal?: AbortSignal,
	): Promise<MediaTranscription[]> {
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
					if (!sameSnapshot(request.snapshot, this.currentSnapshot())) {
						throw new TranscriptionError('stale-media', 'The selected media no longer belongs to this conversation.');
					}

					for (const item of request.items) {
						this.mediaHandles.describeHandle(item.handleId, item.messageId, request.snapshot);
					}

					const transcriptions: MediaTranscription[] = [];
					for (const [index, file] of files.entries()) {
						const item = request.items[index];
						this.mediaHandles.describeHandle(item.handleId, item.messageId, request.snapshot);
						// eslint-disable-next-line no-await-in-loop
						const transcript = await this.client.transcribe(apiKey, file.bytes, file.media.mimeType, signal);
						if (!sameSnapshot(request.snapshot, this.currentSnapshot())) {
							throw new TranscriptionError('stale-media', 'The conversation changed before transcription completed.');
						}

						this.mediaHandles.describeHandle(item.handleId, item.messageId, request.snapshot);
						transcriptions.push({
							...transcript,
							mediaSha256: createHash('sha256').update(file.bytes).digest('hex'),
							source: {
								byteLength: file.media.byteLength,
								durationSeconds: file.durationSeconds,
								kind: 'audio',
								messageId: file.media.messageId,
								mimeType: file.media.mimeType,
							},
						});
					}

					return transcriptions;
				},
				files: [],
				index: 0,
				inspectDuration: this.inspectDuration,
				mediaHandles: this.mediaHandles,
				request,
			});
		} catch (error) {
			mapResolverError(error);
		} finally {
			await Promise.all(request.items.map(async item => this.mediaHandles.releaseHandle(item.handleId).catch(() => undefined)));
		}
	}
}
