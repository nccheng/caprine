import {
	maximumMediaBytes,
	mediaKinds,
	MediaKind,
} from './media-contract';

export const messengerMediaResolverChannel = 'ai-assist:messenger-media-resolver';

type MessengerMediaResolverRequestBase = {
	kind: MediaKind;
	messageId: string;
	requestId: string;
};

export type MessengerMediaResolverRequest = MessengerMediaResolverRequestBase & (
	| {
		byteLength: number;
		bytes: ArrayBuffer;
		mimeType: string;
		sourceType: 'blob';
	}
	| {
		sourceType: 'https';
		url: string;
	}
);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
	const actualKeys = Object.keys(value);
	return actualKeys.length === keys.length && keys.every(key => actualKeys.includes(key));
}

export function isMessengerMediaResolverRequest(value: unknown): value is MessengerMediaResolverRequest {
	if (!isRecord(value)
		|| !mediaKinds.includes(value.kind as never)
		|| typeof value.messageId !== 'string'
		|| value.messageId.length > 200
		|| !/^[\w.:-]+$/.test(value.messageId)
		|| typeof value.requestId !== 'string'
		|| !/^media-request-\d{1,12}$/.test(value.requestId)) {
		return false;
	}

	const keys = ['kind', 'messageId', 'requestId', 'sourceType'];
	if (value.sourceType === 'https') {
		keys.push('url');
		return hasExactKeys(value, keys)
			&& typeof value.url === 'string'
			&& value.url.length <= 8192;
	}

	keys.push('byteLength', 'bytes', 'mimeType');
	return value.sourceType === 'blob'
		&& hasExactKeys(value, keys)
		&& value.bytes instanceof ArrayBuffer
		&& Number.isSafeInteger(value.byteLength)
		&& (value.byteLength as number) > 0
		&& value.byteLength === value.bytes.byteLength
		&& value.byteLength <= maximumMediaBytes[value.kind as MediaKind]
		&& typeof value.mimeType === 'string'
		&& value.mimeType.length <= 100
		&& new RegExp(`^${value.kind as string}/[a-z\\d.+-]+$`, 'i').test(value.mimeType);
}
