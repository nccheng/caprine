import {randomUUID} from 'node:crypto';
import {
	mkdir,
	readdir,
	rm,
	writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {ConversationSnapshot} from './ai-assist-state';
import {
	maximumMediaBytes,
	MediaKind,
	MediaSourceType,
} from './media-contract';

export const mediaResolverTimeoutMs = 30_000;

export type MediaDiagnostic = {
	byteLength?: number;
	durationSeconds?: number;
	kind: MediaKind;
	mimeType?: string;
	outcome: 'ready' | 'unavailable' | 'unsupported';
	sourceType: MediaSourceType;
};

export type ResolvedMedia = {
	byteLength: number;
	durationSeconds?: number;
	handleId: string;
	kind: MediaKind;
	messageId: string;
	mimeType: string;
	sourceType: Exclude<MediaSourceType, 'segmented'>;
};

type StoredMedia = ResolvedMedia & {
	filePath: string;
	snapshot: ConversationSnapshot;
};

export class MediaResolverError extends Error {
	constructor(
		readonly code: 'aborted' | 'mime-mismatch' | 'network' | 'oversized' | 'stale-handle' | 'unsupported-source',
		message: string,
	) {
		super(message);
		this.name = 'MediaResolverError';
	}
}

type MediaFetch = (url: string, init: RequestInit) => Promise<Response>;

function sameSnapshot(left: Readonly<ConversationSnapshot>, right: Readonly<ConversationSnapshot>): boolean {
	return left.captureGeneration === right.captureGeneration
		&& left.conversationId === right.conversationId
		&& left.messengerWebContentsId === right.messengerWebContentsId
		&& left.sessionId === right.sessionId;
}

function normalizedMimeType(value: string | undefined): string | undefined {
	const normalized = value?.split(';', 1)[0]?.trim().toLowerCase();
	return normalized && normalized.length <= 100 ? normalized : undefined;
}

function validateMimeType(value: string | undefined, kind: MediaKind): string {
	if (!value || !value.startsWith(`${kind}/`)) {
		throw new MediaResolverError('mime-mismatch', `Expected ${kind} media bytes.`);
	}

	return value;
}

function extensionForMimeType(mimeType: string): string {
	const subtype = mimeType.split('/')[1]?.replaceAll(/[^a-z\d]/g, '').slice(0, 12);
	return subtype || 'bin';
}

export function isAllowedMessengerMediaUrl(value: string): boolean {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}

	if (url.protocol !== 'https:' || url.username || url.password) {
		return false;
	}

	const hostname = url.hostname.toLowerCase();
	return hostname === 'facebook.com'
		|| hostname.endsWith('.facebook.com')
		|| hostname === 'fbcdn.net'
		|| hostname.endsWith('.fbcdn.net')
		|| hostname === 'fbsbx.com'
		|| hostname.endsWith('.fbsbx.com');
}

async function readBoundedBody(response: Response, maximumBytes: number): Promise<Uint8Array> {
	const advertisedLength = response.headers.get('content-length');
	if (advertisedLength !== null) {
		const length = Number(advertisedLength);
		if (!Number.isSafeInteger(length) || length < 0 || length > maximumBytes) {
			throw new MediaResolverError('oversized', 'Media exceeds the processing limit.');
		}
	}

	if (!response.body) {
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.byteLength > maximumBytes) {
			throw new MediaResolverError('oversized', 'Media exceeds the processing limit.');
		}

		return bytes;
	}

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let byteLength = 0;
	try {
		// eslint-disable-next-line no-constant-condition
		while (true) {
			// eslint-disable-next-line no-await-in-loop
			const {done, value} = await reader.read();
			if (done) {
				break;
			}

			byteLength += value.byteLength;
			if (byteLength > maximumBytes) {
				throw new MediaResolverError('oversized', 'Media exceeds the processing limit.');
			}

			chunks.push(value);
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}

	const bytes = new Uint8Array(byteLength);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}

	return bytes;
}

export class MessengerMediaResolver {
	private readonly handles = new Map<string, StoredMedia>();

	constructor(
		private readonly temporaryDirectory: string,
		private readonly fetchMedia: MediaFetch,
		private readonly reportDiagnostic: (diagnostic: MediaDiagnostic) => void = () => undefined,
		private readonly timeoutMs = mediaResolverTimeoutMs,
	) {}

	async cleanupRestartArtifacts(): Promise<void> {
		await mkdir(this.temporaryDirectory, {mode: 0o700, recursive: true});
		for (const entry of await readdir(this.temporaryDirectory, {withFileTypes: true})) {
			// eslint-disable-next-line no-await-in-loop
			await rm(path.join(this.temporaryDirectory, entry.name), {force: true, recursive: entry.isDirectory()});
		}
	}

	async resolveHttps(
		url: string,
		kind: MediaKind,
		messageId: string,
		snapshot: Readonly<ConversationSnapshot>,
		durationSeconds?: number,
		externalSignal?: AbortSignal,
	): Promise<ResolvedMedia> {
		if (!isAllowedMessengerMediaUrl(url)) {
			this.report({
				durationSeconds,
				kind,
				outcome: 'unsupported',
				sourceType: 'https',
			});
			throw new MediaResolverError('unsupported-source', 'Messenger media host is not allowed.');
		}

		const abortController = new AbortController();
		const abort = (): void => {
			abortController.abort();
		};

		externalSignal?.addEventListener('abort', abort, {once: true});
		const timeout = setTimeout(abort, this.timeoutMs);
		try {
			let currentUrl = url;
			let response: Response | undefined;
			for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
				if (!isAllowedMessengerMediaUrl(currentUrl)) {
					throw new MediaResolverError('unsupported-source', 'Messenger media redirect host is not allowed.');
				}

				// eslint-disable-next-line no-await-in-loop
				response = await this.fetchMedia(currentUrl, {
					credentials: 'include',
					method: 'GET',
					redirect: 'manual',
					signal: abortController.signal,
				});
				if (![301, 302, 303, 307, 308].includes(response.status)) {
					break;
				}

				const location = response.headers.get('location');
				if (!location || redirectCount === 3) {
					throw new MediaResolverError('network', 'Messenger media redirect could not be followed safely.');
				}

				currentUrl = new URL(location, currentUrl).href;
			}

			if (!response?.ok) {
				throw new MediaResolverError('network', 'Messenger media could not be fetched.');
			}

			const mimeType = validateMimeType(
				normalizedMimeType(response.headers.get('content-type') ?? undefined),
				kind,
			);
			const bytes = await readBoundedBody(response, maximumMediaBytes[kind]);
			return await this.store(bytes, mimeType, kind, messageId, snapshot, 'https', durationSeconds);
		} catch (error) {
			const resolverError = error instanceof MediaResolverError
				? error
				: new MediaResolverError(
					abortController.signal.aborted ? 'aborted' : 'network',
					abortController.signal.aborted ? 'Media resolution was cancelled.' : 'Messenger media could not be fetched.',
				);
			this.report({
				durationSeconds,
				kind,
				outcome: 'unavailable',
				sourceType: 'https',
			});
			throw resolverError;
		} finally {
			clearTimeout(timeout);
			externalSignal?.removeEventListener('abort', abort);
		}
	}

	async resolveBlob(
		buffer: ArrayBuffer,
		mimeTypeValue: string,
		kind: MediaKind,
		messageId: string,
		snapshot: Readonly<ConversationSnapshot>,
		durationSeconds?: number,
	): Promise<ResolvedMedia> {
		try {
			const mimeType = validateMimeType(normalizedMimeType(mimeTypeValue), kind);
			if (buffer.byteLength > maximumMediaBytes[kind]) {
				throw new MediaResolverError('oversized', 'Media exceeds the processing limit.');
			}

			return await this.store(
				new Uint8Array(buffer),
				mimeType,
				kind,
				messageId,
				snapshot,
				'blob',
				durationSeconds,
			);
		} catch (error) {
			this.report({
				durationSeconds,
				kind,
				outcome: 'unavailable',
				sourceType: 'blob',
			});
			throw error;
		}
	}

	reportUnsupported(kind: MediaKind, durationSeconds?: number): void {
		this.report({
			durationSeconds,
			kind,
			outcome: 'unsupported',
			sourceType: 'segmented',
		});
	}

	async withFile<T>(
		handleId: string,
		messageId: string,
		snapshot: Readonly<ConversationSnapshot>,
		callback: (filePath: string, media: ResolvedMedia) => Promise<T>,
	): Promise<T> {
		const stored = this.handles.get(handleId);
		if (!stored || stored.messageId !== messageId || !sameSnapshot(stored.snapshot, snapshot)) {
			throw new MediaResolverError('stale-handle', 'Media handle no longer belongs to this conversation.');
		}

		try {
			const {filePath, snapshot: _snapshot, ...media} = stored;
			return await callback(filePath, media);
		} finally {
			await this.release(handleId);
		}
	}

	async releaseAll(): Promise<void> {
		await Promise.all([...this.handles].map(async ([handleId]) => this.release(handleId)));
	}

	private async store(
		bytes: Uint8Array,
		mimeType: string,
		kind: MediaKind,
		messageId: string,
		snapshot: Readonly<ConversationSnapshot>,
		sourceType: ResolvedMedia['sourceType'],
		durationSeconds?: number,
	): Promise<ResolvedMedia> {
		await mkdir(this.temporaryDirectory, {mode: 0o700, recursive: true});
		const handleId = randomUUID();
		const filePath = path.join(this.temporaryDirectory, `${handleId}.${extensionForMimeType(mimeType)}`);
		await writeFile(filePath, bytes, {flag: 'wx', mode: 0o600});
		const stored: StoredMedia = {
			byteLength: bytes.byteLength,
			...(durationSeconds === undefined ? {} : {durationSeconds}),
			filePath,
			handleId,
			kind,
			messageId,
			mimeType,
			snapshot: {...snapshot},
			sourceType,
		};
		this.handles.set(handleId, stored);
		this.report({
			byteLength: bytes.byteLength,
			durationSeconds,
			kind,
			mimeType,
			outcome: 'ready',
			sourceType,
		});
		const {filePath: _filePath, snapshot: _snapshot, ...resolved} = stored;
		return resolved;
	}

	private async release(handleId: string): Promise<void> {
		const stored = this.handles.get(handleId);
		this.handles.delete(handleId);
		if (stored) {
			await rm(stored.filePath, {force: true});
		}
	}

	private report(diagnostic: MediaDiagnostic): void {
		this.reportDiagnostic(diagnostic);
	}
}
