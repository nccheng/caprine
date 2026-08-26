import {nativeImage} from 'electron';
import {ConversationSnapshot} from './ai-assist-state';
import {
	maximumMessengerImageCaptureDimension,
	maximumMessengerImageCapturePixelBytes,
	MessengerImageCaptureDescription,
	MessengerImageCaptureStore,
} from './messenger-image-capture';

export const maximumProcessedMessengerImageDimension = 2048;
export const maximumProcessedMessengerImageBytes = 20 * 1024 * 1024;
export const processedMessengerImageMimeType = 'image/png' as const;

export type MessengerImageNormalizationFailureReason =
	| 'aborted'
	| 'conversation-changed'
	| 'invalid-output'
	| 'invalid-source'
	| 'normalization-failed'
	| 'oversized-output'
	| 'oversized-source'
	| 'source-unavailable';

export type ProcessedMessengerImageDescription = {
	byteLength: number;
	handleId: string;
	height: number;
	messageId: string;
	mimeType: typeof processedMessengerImageMimeType;
	snapshot: Readonly<ConversationSnapshot>;
	status: 'processed';
	width: number;
};

export type MessengerImageNormalizationResult =
	| ProcessedMessengerImageDescription
	| {reason: MessengerImageNormalizationFailureReason; status: 'unavailable'};

export type MessengerImageNormalizerInput = {
	bytes: Uint8Array;
	height: number;
	signal: AbortSignal;
	targetHeight: number;
	targetWidth: number;
	width: number;
};

export type MessengerImageNormalizerOutput = {
	bytes: Uint8Array;
	height: number;
	mimeType: typeof processedMessengerImageMimeType;
	width: number;
};

export type MessengerImageNormalizer = (
	input: Readonly<MessengerImageNormalizerInput>,
) => Promise<MessengerImageNormalizerOutput>;

type NativeImageLike = {
	getSize: () => {height: number; width: number};
	isEmpty: () => boolean;
	resize: (options: {
		height: number;
		quality: 'best';
		width: number;
	}) => NativeImageLike;
	toPNG: () => Uint8Array;
};

type NativeImageFactory = {
	createFromBitmap: (
		bitmap: Uint8Array,
		options: {height: number; scaleFactor: number; width: number},
	) => NativeImageLike;
};

type CaptureStore = Pick<MessengerImageCaptureStore, 'describeHandle' | 'releaseHandle' | 'withCapture'>;

type StoredProcessedImage = {
	abortListener: () => void;
	bytes: Uint8Array;
	description: ProcessedMessengerImageDescription;
	signal: AbortSignal;
};

function finitePositiveInteger(value: number): boolean {
	return Number.isSafeInteger(value) && value > 0;
}

function sameSnapshot(
	left: Readonly<ConversationSnapshot>,
	right: Readonly<ConversationSnapshot>,
): boolean {
	return left.captureGeneration === right.captureGeneration
		&& left.conversationId === right.conversationId
		&& left.messengerWebContentsId === right.messengerWebContentsId
		&& left.sessionId === right.sessionId;
}

function sourceFailure(
	description: Readonly<MessengerImageCaptureDescription>,
): 'invalid-source' | 'oversized-source' | undefined {
	if (
		!finitePositiveInteger(description.width)
		|| !finitePositiveInteger(description.height)
		|| !finitePositiveInteger(description.byteLength)
		|| description.byteLength !== description.width * description.height * 4
	) {
		return 'invalid-source';
	}

	if (
		description.width > maximumMessengerImageCaptureDimension
		|| description.height > maximumMessengerImageCaptureDimension
		|| description.byteLength > maximumMessengerImageCapturePixelBytes
	) {
		return 'oversized-source';
	}

	return undefined;
}

export function processedMessengerImageDimensions(
	width: number,
	height: number,
): {height: number; width: number} | undefined {
	if (!finitePositiveInteger(width) || !finitePositiveInteger(height)) {
		return undefined;
	}

	const scale = Math.min(
		1,
		maximumProcessedMessengerImageDimension / width,
		maximumProcessedMessengerImageDimension / height,
	);
	return {
		height: Math.max(1, Math.round(height * scale)),
		width: Math.max(1, Math.round(width * scale)),
	};
}

export function createNativeMessengerImageNormalizer(
	imageFactory: NativeImageFactory,
): MessengerImageNormalizer {
	return async input => {
		if (input.signal.aborted) {
			throw new DOMException('Messenger image normalization was aborted', 'AbortError');
		}

		const bitmap = Buffer.from(input.bytes);
		let sourceImage: NativeImageLike;
		try {
			sourceImage = imageFactory.createFromBitmap(bitmap, {
				height: input.height,
				scaleFactor: 1,
				width: input.width,
			});
		} finally {
			bitmap.fill(0);
		}

		if (sourceImage.isEmpty()) {
			throw new TypeError('Messenger image source bitmap was empty');
		}

		const sourceSize = sourceImage.getSize();
		if (sourceSize.width !== input.width || sourceSize.height !== input.height) {
			throw new TypeError('Messenger image source dimensions changed');
		}

		const processedImage = sourceImage.resize({
			height: input.targetHeight,
			quality: 'best',
			width: input.targetWidth,
		});
		if (processedImage.isEmpty()) {
			throw new TypeError('Messenger image resize was empty');
		}

		const processedSize = processedImage.getSize();
		const encoded = processedImage.toPNG();
		try {
			return {
				bytes: Uint8Array.from(encoded),
				height: processedSize.height,
				mimeType: processedMessengerImageMimeType,
				width: processedSize.width,
			};
		} finally {
			encoded.fill(0);
		}
	};
}

const electronNativeImageFactory: NativeImageFactory = {
	createFromBitmap(bitmap, options) {
		const electronBitmap = Buffer.from(bitmap);
		try {
			return nativeImage.createFromBitmap(electronBitmap, options);
		} finally {
			electronBitmap.fill(0);
		}
	},
};

export const normalizeMessengerImageWithNativeImage = createNativeMessengerImageNormalizer(
	electronNativeImageFactory,
);

function outputFailure(
	output: Readonly<MessengerImageNormalizerOutput>,
	expected: Readonly<{height: number; width: number}>,
): 'invalid-output' | 'oversized-output' | undefined {
	if (
		output.mimeType !== processedMessengerImageMimeType
		|| !finitePositiveInteger(output.width)
		|| !finitePositiveInteger(output.height)
		|| output.width !== expected.width
		|| output.height !== expected.height
		|| output.bytes.byteLength === 0
	) {
		return 'invalid-output';
	}

	if (
		output.width > maximumProcessedMessengerImageDimension
		|| output.height > maximumProcessedMessengerImageDimension
		|| output.bytes.byteLength > maximumProcessedMessengerImageBytes
	) {
		return 'oversized-output';
	}

	const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
	if (
		output.bytes.byteLength < pngSignature.length
		|| pngSignature.some((byte, index) => output.bytes[index] !== byte)
	) {
		return 'invalid-output';
	}

	return undefined;
}

export class ProcessedMessengerImageStore {
	private handleCounter = 0;
	private readonly stored = new Map<string, StoredProcessedImage>();

	constructor(
		private readonly captures: CaptureStore,
		private readonly isSnapshotCurrent: (
			snapshot: Readonly<ConversationSnapshot>,
		) => boolean,
		private readonly normalizeImage: MessengerImageNormalizer = normalizeMessengerImageWithNativeImage,
		private readonly onRelease?: (bytes: Uint8Array) => void,
	) {}

	async normalize(
		captureHandleId: string,
		messageId: string,
		snapshot: Readonly<ConversationSnapshot>,
		signal: AbortSignal,
	): Promise<MessengerImageNormalizationResult> {
		const capture = this.captures.describeHandle(captureHandleId, messageId, snapshot);
		if (!capture) {
			this.captures.releaseHandle(captureHandleId);
			return {
				reason: this.isSnapshotCurrent(snapshot) ? 'source-unavailable' : 'conversation-changed',
				status: 'unavailable',
			};
		}

		if (signal.aborted) {
			this.captures.releaseHandle(captureHandleId);
			return {reason: 'aborted', status: 'unavailable'};
		}

		const invalidSource = sourceFailure(capture);
		if (invalidSource) {
			this.captures.releaseHandle(captureHandleId);
			return {reason: invalidSource, status: 'unavailable'};
		}

		const target = processedMessengerImageDimensions(capture.width, capture.height);
		if (!target) {
			this.captures.releaseHandle(captureHandleId);
			return {reason: 'invalid-source', status: 'unavailable'};
		}

		try {
			return await this.captures.withCapture(
				captureHandleId,
				messageId,
				snapshot,
				async (sourceBytes, authoritativeCapture) => this.normalizeCapture(
					sourceBytes,
					authoritativeCapture,
					target,
					signal,
				),
			);
		} catch {
			return {
				reason: signal.aborted
					? 'aborted'
					: (this.isSnapshotCurrent(snapshot) ? 'source-unavailable' : 'conversation-changed'),
				status: 'unavailable',
			};
		}
	}

	describeHandle(
		handleId: string,
		messageId: string,
		snapshot: Readonly<ConversationSnapshot>,
	): ProcessedMessengerImageDescription | undefined {
		const stored = this.stored.get(handleId);
		if (
			stored
			&& (stored.signal.aborted || !this.isSnapshotCurrent(stored.description.snapshot))
		) {
			this.releaseStored(handleId, stored);
			return undefined;
		}

		return stored
			&& stored.description.messageId === messageId
			&& sameSnapshot(stored.description.snapshot, snapshot)
			&& this.isSnapshotCurrent(snapshot)
			? stored.description
			: undefined;
	}

	async withProcessedImagePreview<T>(
		handleId: string,
		messageId: string,
		snapshot: Readonly<ConversationSnapshot>,
		callback: (
			bytes: Uint8Array,
			description: ProcessedMessengerImageDescription,
		) => Promise<T> | T,
	): Promise<T> {
		const stored = this.stored.get(handleId);
		if (
			stored
			&& (stored.signal.aborted || !this.isSnapshotCurrent(stored.description.snapshot))
		) {
			this.releaseStored(handleId, stored);
			throw new TypeError('Rejected stale processed Messenger image');
		}

		if (
			!stored
			|| stored.description.messageId !== messageId
			|| !sameSnapshot(stored.description.snapshot, snapshot)
		) {
			throw new TypeError('Rejected stale processed Messenger image');
		}

		const previewBytes = Uint8Array.from(stored.bytes);
		try {
			return await callback(previewBytes, stored.description);
		} finally {
			this.releaseBytes(previewBytes);
		}
	}

	async withProcessedImage<T>(
		handleId: string,
		messageId: string,
		snapshot: Readonly<ConversationSnapshot>,
		callback: (
			bytes: Uint8Array,
			description: ProcessedMessengerImageDescription,
		) => Promise<T>,
	): Promise<T> {
		const stored = this.stored.get(handleId);
		if (
			stored
			&& (stored.signal.aborted || !this.isSnapshotCurrent(stored.description.snapshot))
		) {
			this.releaseStored(handleId, stored);
			throw new TypeError('Rejected stale processed Messenger image');
		}

		if (
			!stored
			|| stored.description.messageId !== messageId
			|| !sameSnapshot(stored.description.snapshot, snapshot)
		) {
			throw new TypeError('Rejected stale processed Messenger image');
		}

		this.stored.delete(handleId);
		stored.signal.removeEventListener('abort', stored.abortListener);
		try {
			return await callback(stored.bytes, stored.description);
		} finally {
			this.releaseBytes(stored.bytes);
		}
	}

	releaseHandle(handleId: string): boolean {
		const stored = this.stored.get(handleId);
		if (!stored) {
			return false;
		}

		return this.releaseStored(handleId, stored);
	}

	releaseAll(): void {
		for (const handleId of this.stored.keys()) {
			this.releaseHandle(handleId);
		}
	}

	private async normalizeCapture(
		sourceBytes: Uint8Array,
		capture: MessengerImageCaptureDescription,
		target: Readonly<{height: number; width: number}>,
		signal: AbortSignal,
	): Promise<MessengerImageNormalizationResult> {
		if (sourceBytes.byteLength !== capture.byteLength) {
			return {reason: 'invalid-source', status: 'unavailable'};
		}

		if (
			signal.aborted
			|| !this.isSnapshotCurrent(capture.snapshot)
		) {
			return {
				reason: signal.aborted ? 'aborted' : 'conversation-changed',
				status: 'unavailable',
			};
		}

		let normalized: MessengerImageNormalizerOutput;
		try {
			normalized = await this.normalizeImage({
				bytes: sourceBytes,
				height: capture.height,
				signal,
				targetHeight: target.height,
				targetWidth: target.width,
				width: capture.width,
			});
		} catch {
			return {
				reason: signal.aborted ? 'aborted' : 'normalization-failed',
				status: 'unavailable',
			};
		}

		const releaseNormalized = () => {
			this.releaseBytes(normalized.bytes);
		};

		if (signal.aborted || !this.isSnapshotCurrent(capture.snapshot)) {
			releaseNormalized();
			return {
				reason: signal.aborted ? 'aborted' : 'conversation-changed',
				status: 'unavailable',
			};
		}

		const invalidOutput = outputFailure(normalized, target);
		if (invalidOutput) {
			releaseNormalized();
			return {reason: invalidOutput, status: 'unavailable'};
		}

		const bytes = Uint8Array.from(normalized.bytes);
		releaseNormalized();
		const handleId = `processed-image-${++this.handleCounter}`;
		const description: ProcessedMessengerImageDescription = Object.freeze({
			byteLength: bytes.byteLength,
			handleId,
			height: normalized.height,
			messageId: capture.messageId,
			mimeType: processedMessengerImageMimeType,
			snapshot: Object.freeze({...capture.snapshot}),
			status: 'processed',
			width: normalized.width,
		});
		const stored: StoredProcessedImage = {
			abortListener: () => {
				this.releaseStored(handleId, stored);
			},
			bytes,
			description,
			signal,
		};
		this.stored.set(handleId, stored);
		signal.addEventListener('abort', stored.abortListener, {once: true});
		if (signal.aborted) {
			this.releaseStored(handleId, stored);
			return {reason: 'aborted', status: 'unavailable'};
		}

		return description;
	}

	private releaseStored(handleId: string, stored: StoredProcessedImage): boolean {
		if (this.stored.get(handleId) !== stored) {
			return false;
		}

		this.stored.delete(handleId);
		stored.signal.removeEventListener('abort', stored.abortListener);
		this.releaseBytes(stored.bytes);
		return true;
	}

	private releaseBytes(bytes: Uint8Array): void {
		bytes.fill(0);
		this.onRelease?.(bytes);
	}
}
