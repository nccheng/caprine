import {isTrustedMessengerOrigin} from './ipc-validation';

type SenderFrameLike = {
	origin: string;
	url: string;
};

type SenderEventLike = {
	sender: unknown;
	senderFrame: unknown;
};

type WebContentsLike = {
	mainFrame: unknown;
};

type WindowLike = {
	webContents: WebContentsLike;
	isDestroyed(): boolean;
};

function isSenderFrame(value: unknown): value is SenderFrameLike {
	return typeof value === 'object'
		&& value !== null
		&& 'origin' in value
		&& typeof value.origin === 'string'
		&& 'url' in value
		&& typeof value.url === 'string';
}

export function isExpectedLocalPanelSender(
	event: SenderEventLike,
	panelWindow: WindowLike | undefined,
	panelUrl: string | undefined,
): boolean {
	return panelWindow !== undefined
		&& panelUrl !== undefined
		&& !panelWindow.isDestroyed()
		&& event.sender === panelWindow.webContents
		&& isSenderFrame(event.senderFrame)
		&& event.senderFrame === panelWindow.webContents.mainFrame
		&& event.senderFrame.url === panelUrl;
}

export function isExpectedMessengerSender(
	event: SenderEventLike,
	messengerWebContents: WebContentsLike,
): boolean {
	return event.sender === messengerWebContents
		&& isSenderFrame(event.senderFrame)
		&& event.senderFrame === messengerWebContents.mainFrame
		&& isTrustedMessengerOrigin(event.senderFrame.origin);
}
