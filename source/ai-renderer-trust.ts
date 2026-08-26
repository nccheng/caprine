import {isTrustedMessengerOrigin} from './ipc-validation';
import {aiAssistIpcChannels} from './ai-assist-ipc';
import {messengerMediaResolverChannel} from './media-resolver-ipc';

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

type AiRendererContext = {
	messengerWebContents: WebContentsLike;
	panelUrl: string | undefined;
	panelWindow: WindowLike | undefined;
};

const messengerInboundChannels = new Set<string>([
	aiAssistIpcChannels.composerCommand,
	aiAssistIpcChannels.draftInsertionAuthorization,
	aiAssistIpcChannels.messageAnchor,
	aiAssistIpcChannels.messengerEvent,
	messengerMediaResolverChannel,
]);

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

export function isExpectedAiInboundSender(
	channel: string,
	event: SenderEventLike,
	context: AiRendererContext,
): boolean {
	if (channel === aiAssistIpcChannels.panelCommand) {
		return isExpectedLocalPanelSender(event, context.panelWindow, context.panelUrl);
	}

	return messengerInboundChannels.has(channel)
		&& isExpectedMessengerSender(event, context.messengerWebContents);
}
