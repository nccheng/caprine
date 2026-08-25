import {spawn} from 'node:child_process';
import {constants as fileSystemConstants} from 'node:fs';
import {access} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

export const maximumVideoToolOutputBytes = 1024 * 1024;
export const maximumVideoDurationSeconds = 24 * 60 * 60;
export const defaultVideoToolTimeoutMilliseconds = 30_000;
export const allowedVideoInputFormats = 'avi,flv,matroska,mov,mpeg,mpegts,ogg,webm';

export const videoToolErrorCodes = [
	'cancelled',
	'malformed-metadata',
	'output-too-large',
	'process-failed',
	'timeout',
	'tools-unavailable',
	'unsupported-video',
] as const;

export type VideoToolErrorCode = typeof videoToolErrorCodes[number];

export class VideoToolError extends Error {
	constructor(
		readonly code: VideoToolErrorCode,
		message: string,
		readonly exitCode?: number,
	) {
		super(message);
		this.name = 'VideoToolError';
	}
}

export type VideoToolPaths = {
	ffmpeg: string;
	ffprobe: string;
};

export type VideoMetadata = {
	audioTrackAvailable: boolean;
	container: string;
	durationSeconds: number;
	frameRate: number;
	height: number;
	videoCodec: string;
	width: number;
};

export type VideoMetadataPhase = 'checking-tools' | 'inspecting-metadata';

type AccessImplementation = (filePath: string, mode?: number) => Promise<void>;
type LocateVideoTools = (options?: FindMacVideoToolsOptions) => Promise<VideoToolPaths>;
type ProcessResult = {stderr: string; stdout: string};
type ProcessRunner = {
	run(executable: string, arguments_: readonly string[], signal?: AbortSignal): Promise<ProcessResult>;
};

type FindMacVideoToolsOptions = {
	accessImplementation?: AccessImplementation;
	pathValue?: string;
};

type BoundedProcessRunnerOptions = {
	maximumOutputBytes?: number;
	spawnImplementation?: typeof spawn;
	timeoutMilliseconds?: number;
};

type InspectVideoOptions = {
	onPhase?: (phase: VideoMetadataPhase) => void;
	signal?: AbortSignal;
};

const commonMacVideoToolDirectories = ['/opt/homebrew/bin', '/usr/local/bin'];

function uniqueAbsoluteDirectories(pathValue: string): string[] {
	const directories = [...pathValue.split(path.delimiter), ...commonMacVideoToolDirectories];
	return [...new Set(directories.filter(directory => path.isAbsolute(directory)))];
}

async function isExecutable(filePath: string, accessImplementation: AccessImplementation): Promise<boolean> {
	try {
		await accessImplementation(filePath, fileSystemConstants.X_OK);
		return true;
	} catch {
		return false;
	}
}

async function findExecutable(
	name: 'ffmpeg' | 'ffprobe',
	directories: readonly string[],
	accessImplementation: AccessImplementation,
): Promise<string | undefined> {
	for (const directory of directories) {
		const filePath = path.join(directory, name);
		// eslint-disable-next-line no-await-in-loop
		if (await isExecutable(filePath, accessImplementation)) {
			return filePath;
		}
	}

	return undefined;
}

export async function findMacVideoTools(options: FindMacVideoToolsOptions = {}): Promise<VideoToolPaths> {
	const accessImplementation = options.accessImplementation ?? access;
	const pathValue = options.pathValue ?? process.env.PATH ?? '';
	const directories = uniqueAbsoluteDirectories(pathValue);
	const [ffmpeg, ffprobe] = await Promise.all([
		findExecutable('ffmpeg', directories, accessImplementation),
		findExecutable('ffprobe', directories, accessImplementation),
	]);
	if (ffmpeg && ffprobe) {
		return {ffmpeg, ffprobe};
	}

	throw new VideoToolError(
		'tools-unavailable',
		'Install ffmpeg with Homebrew (`brew install ffmpeg`) and try again.',
	);
}

export class BoundedProcessRunner implements ProcessRunner {
	private readonly maximumOutputBytes: number;
	private readonly spawnImplementation: typeof spawn;
	private readonly timeoutMilliseconds: number;

	constructor(options: BoundedProcessRunnerOptions = {}) {
		this.maximumOutputBytes = options.maximumOutputBytes ?? maximumVideoToolOutputBytes;
		this.spawnImplementation = options.spawnImplementation ?? spawn;
		this.timeoutMilliseconds = options.timeoutMilliseconds ?? defaultVideoToolTimeoutMilliseconds;
		if (!Number.isSafeInteger(this.maximumOutputBytes) || this.maximumOutputBytes <= 0) {
			throw new RangeError('maximumOutputBytes must be a positive safe integer');
		}

		if (!Number.isSafeInteger(this.timeoutMilliseconds) || this.timeoutMilliseconds <= 0) {
			throw new RangeError('timeoutMilliseconds must be a positive safe integer');
		}
	}

	async run(executable: string, arguments_: readonly string[], signal?: AbortSignal): Promise<ProcessResult> {
		if (!path.isAbsolute(executable)) {
			throw new VideoToolError('process-failed', 'The video tool could not be started.');
		}

		if (signal?.aborted) {
			throw new VideoToolError('cancelled', 'Video inspection was canceled.');
		}

		return new Promise<ProcessResult>((resolve, reject) => {
			const child = this.spawnImplementation(executable, [...arguments_], {
				shell: false,
				stdio: ['ignore', 'pipe', 'pipe'],
				windowsHide: true,
			});
			const stdoutChunks: Uint8Array[] = [];
			const stderrChunks: Uint8Array[] = [];
			let outputBytes = 0;
			let settled = false;

			const cleanup = (): void => {
				clearTimeout(timeout);
				signal?.removeEventListener('abort', abort);
			};

			const finish = (error?: VideoToolError, result?: ProcessResult): void => {
				if (settled) {
					return;
				}

				settled = true;
				cleanup();
				if (error) {
					reject(error);
					return;
				}

				resolve(result!);
			};

			const terminate = (error: VideoToolError): void => {
				child.kill('SIGKILL');
				finish(error);
			};

			const capture = (chunks: Uint8Array[], value: Uint8Array | string): void => {
				if (settled) {
					return;
				}

				const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
				outputBytes += chunk.byteLength;
				if (outputBytes > this.maximumOutputBytes) {
					terminate(new VideoToolError('output-too-large', 'The video tool returned too much data.'));
					return;
				}

				chunks.push(chunk);
			};

			const abort = (): void => {
				terminate(new VideoToolError('cancelled', 'Video inspection was canceled.'));
			};

			const timeout = setTimeout(() => {
				terminate(new VideoToolError('timeout', 'Video inspection timed out.'));
			}, this.timeoutMilliseconds);

			child.stdout.on('data', value => {
				capture(stdoutChunks, value);
			});
			child.stderr.on('data', value => {
				capture(stderrChunks, value);
			});
			child.once('error', () => {
				finish(new VideoToolError('process-failed', 'The video tool could not be started.'));
			});
			child.once('close', code => {
				if (code !== 0) {
					finish(new VideoToolError('process-failed', 'The video tool could not inspect this file.', code ?? undefined));
					return;
				}

				finish(undefined, {
					stderr: Buffer.concat(stderrChunks).toString('utf8'),
					stdout: Buffer.concat(stdoutChunks).toString('utf8'),
				});
			});
			signal?.addEventListener('abort', abort, {once: true});
			if (signal?.aborted) {
				abort();
			}
		});
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function boundedString(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}

	const normalized = value.trim();
	const hasControlCharacter = [...normalized].some(character => {
		const codePoint = character.codePointAt(0)!;
		return codePoint < 32 || codePoint === 127;
	});
	return normalized && normalized.length <= 128 && !hasControlCharacter
		? normalized
		: undefined;
}

function positiveNumber(value: unknown, maximum: number): number | undefined {
	let number = Number.NaN;
	if (typeof value === 'number') {
		number = value;
	} else if (typeof value === 'string') {
		number = Number(value);
	}

	return Number.isFinite(number) && number > 0 && number <= maximum ? number : undefined;
}

function frameRate(value: unknown): number | undefined {
	if (typeof value !== 'string' || !/^\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?$/.test(value)) {
		return undefined;
	}

	const [numerator, denominator = '1'] = value.split('/');
	return positiveNumber(Number(numerator) / Number(denominator), 1000);
}

export function parseFfprobeMetadata(serialized: string): VideoMetadata {
	if (!serialized || Buffer.byteLength(serialized, 'utf8') > maximumVideoToolOutputBytes) {
		throw new VideoToolError('malformed-metadata', 'The video metadata could not be read.');
	}

	let value: unknown;
	try {
		value = JSON.parse(serialized);
	} catch {
		throw new VideoToolError('malformed-metadata', 'The video metadata could not be read.');
	}

	if (!isRecord(value)
		|| !isRecord(value.format)
		|| !Array.isArray(value.streams)
		|| value.streams.length === 0
		|| value.streams.length > 128) {
		throw new VideoToolError('malformed-metadata', 'The video metadata could not be read.');
	}

	const videoStream = value.streams.find(stream => isRecord(stream) && stream.codec_type === 'video');
	if (!isRecord(videoStream)) {
		throw new VideoToolError('unsupported-video', 'This file does not contain a supported video track.');
	}

	const durationSeconds = positiveNumber(value.format.duration ?? videoStream.duration, maximumVideoDurationSeconds);
	const width = positiveNumber(videoStream.width, 32_768);
	const height = positiveNumber(videoStream.height, 32_768);
	const parsedFrameRate = frameRate(videoStream.avg_frame_rate ?? videoStream.r_frame_rate);
	const container = boundedString(value.format.format_name);
	const videoCodec = boundedString(videoStream.codec_name);
	if (!durationSeconds
		|| !width
		|| !height
		|| !Number.isSafeInteger(width)
		|| !Number.isSafeInteger(height)
		|| !parsedFrameRate
		|| !container
		|| !videoCodec) {
		throw new VideoToolError('malformed-metadata', 'The video metadata could not be read.');
	}

	return {
		audioTrackAvailable: value.streams.some(stream => isRecord(stream) && stream.codec_type === 'audio'),
		container,
		durationSeconds,
		frameRate: parsedFrameRate,
		height,
		videoCodec,
		width,
	};
}

export class VideoMetadataInspector {
	constructor(
		private readonly runner: ProcessRunner = new BoundedProcessRunner(),
		private readonly locateVideoTools: LocateVideoTools = findMacVideoTools,
	) {}

	async inspect(filePath: string, options: InspectVideoOptions = {}): Promise<VideoMetadata> {
		if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || filePath.includes('\u0000')) {
			throw new VideoToolError('unsupported-video', 'This video file cannot be inspected.');
		}

		if (options.signal?.aborted) {
			throw new VideoToolError('cancelled', 'Video inspection was canceled.');
		}

		options.onPhase?.('checking-tools');
		const tools = await this.locateVideoTools();
		if (options.signal?.aborted) {
			throw new VideoToolError('cancelled', 'Video inspection was canceled.');
		}

		options.onPhase?.('inspecting-metadata');
		let result: ProcessResult;
		try {
			result = await this.runner.run(tools.ffprobe, [
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
				filePath,
			], options.signal);
		} catch (error: unknown) {
			if (error instanceof VideoToolError
				&& error.code === 'process-failed'
				&& error.exitCode !== undefined) {
				throw new VideoToolError('unsupported-video', 'This video file is corrupt or unsupported.');
			}

			throw error;
		}

		return parseFfprobeMetadata(result.stdout);
	}
}
