import {ConversationSnapshot} from './ai-assist-state';

export const maximumMessengerImageCaptureDimension = 4096;
export const maximumMessengerImageCapturePixelBytes = 64 * 1024 * 1024;

export type MessengerImageCaptureRectangle = {
	height: number;
	width: number;
	x: number;
	y: number;
};

export type MessengerImageCaptureViewport = {
	height: number;
	width: number;
};

export type MessengerImageCaptureTarget = {
	conversationId: string;
	messageId: string;
	rectangle: MessengerImageCaptureRectangle;
	targetToken: string;
	viewport: MessengerImageCaptureViewport;
};

export type MessengerImageCaptureFailureReason =
	| 'aborted'
	| 'ambiguous-target'
	| 'capture-failed'
	| 'conversation-changed'
	| 'detached-target'
	| 'hidden-target'
	| 'invalid-message'
	| 'missing-target'
	| 'out-of-bounds'
	| 'oversized-target'
	| 'replaced-target';

export type MessengerImageCaptureTargetResolution =
	| {reason: MessengerImageCaptureFailureReason; status: 'unavailable'}
	| ({status: 'available'} & MessengerImageCaptureTarget);

export type MessengerImageCaptureDescription = {
	byteLength: number;
	height: number;
	handleId: string;
	messageId: string;
	snapshot: Readonly<ConversationSnapshot>;
	status: 'captured';
	width: number;
};

export type MessengerImageCaptureResult =
	| MessengerImageCaptureDescription
	| {reason: MessengerImageCaptureFailureReason; status: 'unavailable'};

type NativeImageCapture = {
	getSize: (scaleFactor?: number) => {height: number; width: number};
	isEmpty: () => boolean;
	toBitmap: (options?: {scaleFactor?: number}) => Uint8Array;
};

export type MessengerImageCapturePage = {
	capturePage: (rectangle: MessengerImageCaptureRectangle) => Promise<NativeImageCapture>;
	id: number;
};

type PixelCapture = {
	bytes: Uint8Array;
	height: number;
	width: number;
};

type StoredCapture = {
	bytes: Uint8Array;
	description: MessengerImageCaptureDescription;
};

const messageIdentitySelector = '[data-message-id], [data-messageid]';
const imageSelector = 'img[alt]';
const imageAltPattern = /\b(?:gif|image|photo|sticker)\b/i;
const targetTokens = new WeakMap<Element, {signature: string; token: string}>();
let targetTokenCounter = 0;

function normalizedMessageId(value: string): string | undefined {
	return value.length > 0 && value.length <= 200 && /^[\w.:-]+$/.test(value)
		? value
		: undefined;
}

function normalizedConversationId(value: string): string | undefined {
	return /^messenger-thread:[\w.:-]{1,200}$/.test(value) ? value : undefined;
}

function finitePositive(value: number): boolean {
	return Number.isFinite(value) && value > 0;
}

function targetToken(element: Element): string {
	const image = element as HTMLImageElement;
	const signature = JSON.stringify({
		alt: image.alt,
		currentSource: image.currentSrc,
		source: image.src,
	});
	let state = targetTokens.get(element);
	if (!state || state.signature !== signature) {
		targetTokenCounter += 1;
		state = {
			signature,
			token: `messenger-image-target-${targetTokenCounter}`,
		};
		targetTokens.set(element, state);
	}

	return state.token;
}

function stableMessageId(element: Element): string | undefined {
	const {dataset} = element as HTMLElement;
	const candidate = dataset.messageId
		?? dataset.messageid
		?? '';
	return normalizedMessageId(candidate);
}

function imageIsConnected(image: Element): boolean {
	return (image as HTMLElement).isConnected;
}

function imageIsVisible(image: Element): boolean {
	const htmlImage = image as HTMLElement;
	if ([
		htmlImage.hidden,
		Boolean(image.closest('[aria-hidden="true"]')),
		Boolean(image.closest('[role="button"]')),
	].some(Boolean)) {
		return false;
	}

	const styles = image.ownerDocument?.defaultView?.getComputedStyle(htmlImage);
	if (styles && (
		styles.display === 'none'
		|| styles.visibility === 'hidden'
		|| styles.visibility === 'collapse'
		|| styles.opacity === '0'
	)) {
		return false;
	}

	const rectangle = htmlImage.getBoundingClientRect();
	return finitePositive(rectangle.width)
		&& finitePositive(rectangle.height)
		&& (typeof htmlImage.getClientRects !== 'function' || htmlImage.getClientRects().length > 0);
}

export function validateMessengerImageCaptureRectangle(
	rectangle: Readonly<MessengerImageCaptureRectangle>,
	viewport: Readonly<MessengerImageCaptureViewport>,
): {reason: 'out-of-bounds' | 'oversized-target'; status: 'unavailable'}
	| {rectangle: MessengerImageCaptureRectangle; status: 'available'} {
	if (
		!finitePositive(viewport.width)
		|| !finitePositive(viewport.height)
		|| !Number.isFinite(rectangle.x)
		|| !Number.isFinite(rectangle.y)
		|| !finitePositive(rectangle.width)
		|| !finitePositive(rectangle.height)
	) {
		return {reason: 'out-of-bounds', status: 'unavailable'};
	}

	const left = Math.max(0, rectangle.x);
	const top = Math.max(0, rectangle.y);
	const right = Math.min(viewport.width, rectangle.x + rectangle.width);
	const bottom = Math.min(viewport.height, rectangle.y + rectangle.height);
	if (right <= left || bottom <= top) {
		return {reason: 'out-of-bounds', status: 'unavailable'};
	}

	const x = Math.floor(left);
	const y = Math.floor(top);
	const width = Math.ceil(right) - x;
	const height = Math.ceil(bottom) - y;
	if (
		width > maximumMessengerImageCaptureDimension
		|| height > maximumMessengerImageCaptureDimension
		|| width * height * 4 > maximumMessengerImageCapturePixelBytes
	) {
		return {reason: 'oversized-target', status: 'unavailable'};
	}

	return {
		rectangle: {
			height, width, x, y,
		},
		status: 'available',
	};
}

function resolveMessengerImageCaptureTargetUnsafe(
	root: ParentNode,
	messageId: string,
	conversationId: string,
	viewport: Readonly<MessengerImageCaptureViewport>,
): MessengerImageCaptureTargetResolution {
	if (!normalizedMessageId(messageId) || !normalizedConversationId(conversationId)) {
		return {reason: 'invalid-message', status: 'unavailable'};
	}

	const matchingImages: Element[] = [];
	let sawDetached = false;
	let sawHidden = false;
	for (const identity of root.querySelectorAll(messageIdentitySelector)) {
		if (stableMessageId(identity) !== messageId) {
			continue;
		}

		for (const image of identity.querySelectorAll(imageSelector)) {
			if (!imageAltPattern.test(image.getAttribute('alt') ?? '')) {
				continue;
			}

			if (!imageIsConnected(image)) {
				sawDetached = true;
				continue;
			}

			if (!imageIsVisible(image)) {
				sawHidden = true;
				continue;
			}

			matchingImages.push(image);
		}
	}

	if (matchingImages.length === 0) {
		return {
			reason: sawDetached ? 'detached-target' : (sawHidden ? 'hidden-target' : 'missing-target'),
			status: 'unavailable',
		};
	}

	if (matchingImages.length !== 1) {
		return {reason: 'ambiguous-target', status: 'unavailable'};
	}

	const image = matchingImages[0];
	const geometry = validateMessengerImageCaptureRectangle(image.getBoundingClientRect(), viewport);
	if (geometry.status === 'unavailable') {
		return geometry;
	}

	return {
		conversationId,
		messageId,
		rectangle: geometry.rectangle,
		status: 'available',
		targetToken: targetToken(image),
		viewport: {...viewport},
	};
}

export function resolveMessengerImageCaptureTarget(
	root: ParentNode,
	messageId: string,
	conversationId: string,
	viewport: Readonly<MessengerImageCaptureViewport>,
): MessengerImageCaptureTargetResolution {
	try {
		return resolveMessengerImageCaptureTargetUnsafe(root, messageId, conversationId, viewport);
	} catch {
		return {reason: 'missing-target', status: 'unavailable'};
	}
}

export async function captureMessengerImagePixels(
	page: MessengerImageCapturePage,
	rectangle: Readonly<MessengerImageCaptureRectangle>,
): Promise<PixelCapture> {
	const image = await page.capturePage({...rectangle});
	if (image.isEmpty()) {
		throw new Error('Messenger image capture was empty');
	}

	const {height, width} = image.getSize(1);
	const bitmap = image.toBitmap({scaleFactor: 1});
	return {
		bytes: Uint8Array.from(bitmap),
		height,
		width,
	};
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

function sameRectangle(
	left: Readonly<MessengerImageCaptureRectangle>,
	right: Readonly<MessengerImageCaptureRectangle>,
): boolean {
	return left.x === right.x
		&& left.y === right.y
		&& left.width === right.width
		&& left.height === right.height;
}

function captureAuthorizationFailure(
	signal: AbortSignal,
	snapshot: Readonly<ConversationSnapshot>,
	isSnapshotCurrent: (candidate: Readonly<ConversationSnapshot>) => boolean,
): 'aborted' | 'conversation-changed' | undefined {
	if (signal.aborted) {
		return 'aborted';
	}

	return isSnapshotCurrent(snapshot) ? undefined : 'conversation-changed';
}

function pixelCaptureIsBounded(pixels: Readonly<PixelCapture>): boolean {
	return Number.isSafeInteger(pixels.width)
		&& Number.isSafeInteger(pixels.height)
		&& finitePositive(pixels.width)
		&& finitePositive(pixels.height)
		&& pixels.width <= maximumMessengerImageCaptureDimension
		&& pixels.height <= maximumMessengerImageCaptureDimension
		&& pixels.bytes.byteLength > 0
		&& pixels.bytes.byteLength === pixels.width * pixels.height * 4
		&& pixels.bytes.byteLength <= maximumMessengerImageCapturePixelBytes;
}

export class MessengerImageCaptureStore {
	private handleCounter = 0;
	private readonly stored = new Map<string, StoredCapture>();

	constructor(
		private readonly resolveTarget: (
			messageId: string,
			signal: AbortSignal,
		) => Promise<MessengerImageCaptureTargetResolution>,
		private readonly page: MessengerImageCapturePage,
		private readonly isSnapshotCurrent: (snapshot: Readonly<ConversationSnapshot>) => boolean,
		private readonly onRelease?: (bytes: Uint8Array) => void,
	) {}

	async capture(
		messageId: string,
		snapshot: Readonly<ConversationSnapshot>,
		signal: AbortSignal,
	): Promise<MessengerImageCaptureResult> {
		if (!normalizedMessageId(messageId)) {
			return {reason: 'invalid-message', status: 'unavailable'};
		}

		const initialAuthorizationFailure = captureAuthorizationFailure(
			signal,
			snapshot,
			this.isSnapshotCurrent,
		);
		if (
			initialAuthorizationFailure
			?? snapshot.messengerWebContentsId !== this.page.id
		) {
			return {
				reason: initialAuthorizationFailure ?? 'conversation-changed',
				status: 'unavailable',
			};
		}

		const initialTarget = await this.resolveCaptureTarget(messageId, signal);
		if (initialTarget.status === 'unavailable') {
			return initialTarget;
		}

		if (initialTarget.conversationId !== snapshot.conversationId) {
			return {reason: 'conversation-changed', status: 'unavailable'};
		}

		if (initialTarget.messageId !== messageId) {
			return {reason: 'replaced-target', status: 'unavailable'};
		}

		const resolvedAuthorizationFailure = captureAuthorizationFailure(
			signal,
			snapshot,
			this.isSnapshotCurrent,
		);
		if (resolvedAuthorizationFailure) {
			return {reason: resolvedAuthorizationFailure, status: 'unavailable'};
		}

		let pixels: PixelCapture;
		try {
			pixels = await captureMessengerImagePixels(this.page, initialTarget.rectangle);
		} catch {
			return {
				reason: signal.aborted ? 'aborted' : 'capture-failed',
				status: 'unavailable',
			};
		}

		const rejectPixels = (reason: MessengerImageCaptureFailureReason): MessengerImageCaptureResult => {
			this.releaseBytes(pixels.bytes);
			return {reason, status: 'unavailable'};
		};

		const capturedAuthorizationFailure = captureAuthorizationFailure(
			signal,
			snapshot,
			this.isSnapshotCurrent,
		);
		if (capturedAuthorizationFailure) {
			return rejectPixels(capturedAuthorizationFailure);
		}

		if (!pixelCaptureIsBounded(pixels)) {
			return rejectPixels('oversized-target');
		}

		const currentTarget = await this.resolveCaptureTarget(messageId, signal);
		if (currentTarget.status === 'unavailable') {
			return rejectPixels(currentTarget.reason);
		}

		const verifiedAuthorizationFailure = captureAuthorizationFailure(
			signal,
			snapshot,
			this.isSnapshotCurrent,
		);
		if (verifiedAuthorizationFailure) {
			return rejectPixels(verifiedAuthorizationFailure);
		}

		if (currentTarget.conversationId !== snapshot.conversationId) {
			return rejectPixels('conversation-changed');
		}

		if (
			currentTarget.messageId !== messageId
			|| currentTarget.targetToken !== initialTarget.targetToken
			|| !sameRectangle(currentTarget.rectangle, initialTarget.rectangle)
		) {
			return rejectPixels('replaced-target');
		}

		const handleId = `image-capture-${++this.handleCounter}`;
		const description: MessengerImageCaptureDescription = Object.freeze({
			byteLength: pixels.bytes.byteLength,
			height: pixels.height,
			handleId,
			messageId,
			snapshot: Object.freeze({...snapshot}),
			status: 'captured',
			width: pixels.width,
		});
		this.stored.set(handleId, {bytes: pixels.bytes, description});
		return description;
	}

	describeHandle(
		handleId: string,
		messageId: string,
		snapshot: Readonly<ConversationSnapshot>,
	): MessengerImageCaptureDescription | undefined {
		const stored = this.stored.get(handleId);
		return stored
			&& stored.description.messageId === messageId
			&& sameSnapshot(stored.description.snapshot, snapshot)
			&& this.isSnapshotCurrent(snapshot)
			? stored.description
			: undefined;
	}

	async withCapture<T>(
		handleId: string,
		messageId: string,
		snapshot: Readonly<ConversationSnapshot>,
		callback: (bytes: Uint8Array, description: MessengerImageCaptureDescription) => Promise<T>,
	): Promise<T> {
		const stored = this.stored.get(handleId);
		if (
			!stored
			|| stored.description.messageId !== messageId
			|| !sameSnapshot(stored.description.snapshot, snapshot)
			|| !this.isSnapshotCurrent(snapshot)
		) {
			throw new TypeError('Rejected stale Messenger image capture');
		}

		this.stored.delete(handleId);
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

		this.stored.delete(handleId);
		this.releaseBytes(stored.bytes);
		return true;
	}

	releaseAll(): void {
		for (const handleId of this.stored.keys()) {
			this.releaseHandle(handleId);
		}
	}

	private async resolveCaptureTarget(
		messageId: string,
		signal: AbortSignal,
	): Promise<MessengerImageCaptureTargetResolution> {
		try {
			return await this.resolveTarget(messageId, signal);
		} catch {
			return {reason: 'capture-failed', status: 'unavailable'};
		}
	}

	private releaseBytes(bytes: Uint8Array): void {
		bytes.fill(0);
		this.onRelease?.(bytes);
	}
}
