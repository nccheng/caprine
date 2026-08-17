import {StoreType} from './config';

const MAX_EXTERNAL_URL_LENGTH = 8192;
export const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const MAX_DOWNLOAD_FILENAME_LENGTH = 4096;
const MAX_NOTIFICATION_TITLE_LENGTH = 512;
const MAX_NOTIFICATION_BODY_LENGTH = 8192;
const MAX_NOTIFICATION_ICON_DATA_URL_LENGTH = 5 * 1024 * 1024;
const MAX_CONVERSATIONS = 500;
const MAX_CONVERSATION_LABEL_LENGTH = 512;
const MAX_CONVERSATION_ICON_DATA_URL_LENGTH = 512 * 1024;
const MAX_CONVERSATION_LIST_ICON_BYTES = 10 * 1024 * 1024;
const MAX_MESSAGE_COUNT = 100_000;

export type DownloadRequest = {
	data: ArrayBuffer;
	filename: string;
};

export type NotificationRequest = {
	id: number;
	title: string;
	body?: string;
	icon: string;
	silent: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function isBoundedString(value: unknown, maximumLength: number): value is string {
	return typeof value === 'string' && value.length <= maximumLength;
}

function hasControlCharacters(value: string): boolean {
	return [...value].some(character => {
		const codePoint = character.codePointAt(0)!;
		return codePoint < 32 || codePoint === 127;
	});
}

function isImageDataUrl(value: unknown, maximumLength: number): value is string {
	return isBoundedString(value, maximumLength)
		&& value.startsWith('data:image/png;base64,');
}

export function isTrustedMessengerOrigin(origin: string): boolean {
	try {
		const {protocol, hostname} = new URL(origin);
		return protocol === 'https:' && (
			hostname === 'facebook.com'
			|| hostname.endsWith('.facebook.com')
			|| hostname === 'workplace.com'
			|| hostname.endsWith('.workplace.com')
		);
	} catch {
		return false;
	}
}

export function externalUrl(value: unknown): string | undefined {
	if (!isBoundedString(value, MAX_EXTERNAL_URL_LENGTH)) {
		return;
	}

	try {
		const parsedUrl = new URL(value);
		if (!['http:', 'https:', 'mailto:'].includes(parsedUrl.protocol)) {
			return undefined;
		}

		return parsedUrl.toString();
	} catch {
		return undefined;
	}
}

export function isDownloadRequest(value: unknown): value is DownloadRequest {
	return isRecord(value)
		&& value.data instanceof ArrayBuffer
		&& value.data.byteLength <= MAX_DOWNLOAD_BYTES
		&& isBoundedString(value.filename, MAX_DOWNLOAD_FILENAME_LENGTH)
		&& !hasControlCharacters(value.filename);
}

export function isNotificationRequest(value: unknown): value is NotificationRequest {
	return isRecord(value)
		&& Number.isSafeInteger(value.id)
		&& (value.id as number) >= 0
		&& isBoundedString(value.title, MAX_NOTIFICATION_TITLE_LENGTH)
		&& (value.body === undefined || isBoundedString(value.body, MAX_NOTIFICATION_BODY_LENGTH))
		&& isImageDataUrl(value.icon, MAX_NOTIFICATION_ICON_DATA_URL_LENGTH)
		&& typeof value.silent === 'boolean';
}

export function isConversationList(value: unknown): value is Conversation[] {
	if (!Array.isArray(value) || value.length > MAX_CONVERSATIONS) {
		return false;
	}

	let iconBytes = 0;
	for (const conversation of value) {
		if (
			!isRecord(conversation)
			|| !isBoundedString(conversation.label, MAX_CONVERSATION_LABEL_LENGTH)
			|| typeof conversation.selected !== 'boolean'
			|| typeof conversation.unread !== 'boolean'
			|| !isImageDataUrl(conversation.icon, MAX_CONVERSATION_ICON_DATA_URL_LENGTH)
		) {
			return false;
		}

		iconBytes += Buffer.byteLength(conversation.icon);
		if (iconBytes > MAX_CONVERSATION_LIST_ICON_BYTES) {
			return false;
		}
	}

	return true;
}

export function isMessageCount(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_MESSAGE_COUNT;
}

export function isZoomFactor(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0.5 && value <= 3;
}

export function isEmojiStyle(value: unknown): value is StoreType['emojiStyle'] {
	return value === 'native'
		|| value === 'facebook-3-0'
		|| value === 'messenger-1-0'
		|| value === 'facebook-2-2';
}
