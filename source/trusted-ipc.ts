import {BrowserWindow, IpcMainEvent} from 'electron';
import {isTrustedMessengerOrigin} from './ipc-validation';

type BetterIpcRequest<DataType> = {
	dataChannel: string;
	errorChannel: string;
	userData: DataType;
};

type RendererHandler<DataType, ReturnType> = (
	data: DataType,
	browserWindow: BrowserWindow,
) => ReturnType | PromiseLike<ReturnType>;

function responseChannelSuffix(channel: string, responseChannel: unknown, type: 'data' | 'error'): string | undefined {
	if (typeof responseChannel !== 'string') {
		return;
	}

	const prefix = `%better-ipc-response-${type}-channel-${channel}-`;
	if (!responseChannel.startsWith(prefix)) {
		return;
	}

	const suffix = responseChannel.slice(prefix.length);
	if (suffix.length === 0 || suffix.length > 100) {
		return;
	}

	return suffix;
}

function isBetterIpcRequest<DataType>(channel: string, value: unknown): value is BetterIpcRequest<DataType> {
	if (typeof value !== 'object' || value === null) {
		return false;
	}

	const request = value as Partial<BetterIpcRequest<DataType>>;
	const dataSuffix = responseChannelSuffix(channel, request.dataChannel, 'data');
	const errorSuffix = responseChannelSuffix(channel, request.errorChannel, 'error');
	return dataSuffix !== undefined && dataSuffix === errorSuffix;
}

function isTrustedSender(event: IpcMainEvent, browserWindow: BrowserWindow): boolean {
	return event.sender === browserWindow.webContents
		&& event.senderFrame === browserWindow.webContents.mainFrame
		&& isTrustedMessengerOrigin(event.senderFrame.origin);
}

function serializedError(error: unknown): {name: string; message: string; stack?: string} {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
		};
	}

	return {
		name: 'Error',
		message: String(error),
	};
}

export function answerTrustedRenderer<DataType, ReturnType = unknown>(
	browserWindow: BrowserWindow,
	channel: string,
	callback: RendererHandler<DataType, ReturnType>,
): () => void {
	const sendChannel = `%better-ipc-send-channel-${channel}`;
	const listener = async (event: IpcMainEvent, value: unknown): Promise<void> => {
		if (!isBetterIpcRequest<DataType>(channel, value)) {
			return;
		}

		if (!isTrustedSender(event, browserWindow)) {
			event.reply(value.errorChannel, serializedError(new Error('Rejected IPC from an untrusted renderer frame')));
			return;
		}

		try {
			event.reply(value.dataChannel, await callback(value.userData, browserWindow));
		} catch (error) {
			event.reply(value.errorChannel, serializedError(error));
		}
	};

	browserWindow.webContents.ipc.on(sendChannel, listener);
	return () => {
		if (!browserWindow.isDestroyed()) {
			browserWindow.webContents.ipc.off(sendChannel, listener);
		}
	};
}
