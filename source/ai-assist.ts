import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {
	BrowserWindow,
	IpcMainEvent,
	IpcMainInvokeEvent,
	ipcMain,
	safeStorage,
} from 'electron';
import config from './config';
import {
	aiAssistIpcChannels,
	AiAssistMessengerCommand,
	AiAssistPanelState,
	isAiAssistMessengerEvent,
	isAiAssistPanelCommand,
} from './ai-assist-ipc';
import {
	AiConversationBinding,
	AiAssistSessionStateMachine,
	AiSessionInvalidationReason,
	ConversationLifecycle,
} from './ai-assist-state';
import {isTrustedMessengerOrigin} from './ipc-validation';
import {
	OpenAiClient,
	OpenAiErrorCode,
	OpenAiRequestError,
} from './openai-client';

const panelPartition = 'ai-assist';

class AiAssistController {
	private activeRequest?: {
		abortController: AbortController;
		id: number;
	};

	private answer?: string;
	private readonly conversationBinding = new AiConversationBinding();
	private readonly conversationLifecycle = new ConversationLifecycle();
	private conversationReportCounter = 0;
	private error?: {code: OpenAiErrorCode; message: string};
	private notice?: string;
	private readonly openAiClient = new OpenAiClient();
	private readonly pendingConversationReports = new Map<string, (generation?: number) => void>();
	private requestCounter = 0;
	private readonly sessionState = new AiAssistSessionStateMachine();
	private panelUrl?: string;
	private panelWindow?: BrowserWindow;

	constructor(private readonly messengerWindow: BrowserWindow) {
		ipcMain.handle(aiAssistIpcChannels.panelCommand, this.handlePanelCommand);
		ipcMain.on(aiAssistIpcChannels.messengerEvent, this.handleMessengerEvent);
		this.bindMessengerLifecycle();
	}

	get state(): AiAssistPanelState {
		const request: AiAssistPanelState['request'] = {};
		if (this.answer !== undefined) {
			request.answer = this.answer;
		}

		if (this.error !== undefined) {
			request.error = this.error;
		}

		if (this.notice !== undefined) {
			request.notice = this.notice;
		}

		return {
			conversation: this.conversationBinding.panelState,
			credentials: {
				configured: this.hasApiKey,
				secureStorageAvailable: safeStorage.isEncryptionAvailable(),
			},
			enabled: config.get('aiAssistEnabled'),
			request,
			session: this.sessionState.snapshot,
		};
	}

	private get hasApiKey(): boolean {
		return config.get('aiAssistOpenAiKeyCiphertext').length > 0;
	}

	setEnabled(enabled: boolean): void {
		config.set('aiAssistEnabled', enabled);
		if (!enabled) {
			this.invalidate('ai-disabled');
			this.panelWindow?.destroy();
			this.panelWindow = undefined;
		}

		this.notifyMessenger({type: 'set-enabled', enabled});
		this.broadcastState();
	}

	open(): void {
		if (!config.get('aiAssistEnabled')) {
			return;
		}

		if (this.panelWindow && !this.panelWindow.isDestroyed()) {
			this.panelWindow.show();
			this.panelWindow.focus();
			return;
		}

		this.panelWindow = this.createPanelWindow();
		void this.refreshConversation();
		this.broadcastState();
	}

	private readonly handlePanelCommand = async (
		event: IpcMainInvokeEvent,
		value: unknown,
	): Promise<AiAssistPanelState> => {
		if (!this.isExpectedPanelSender(event) || !isAiAssistPanelCommand(value)) {
			throw new TypeError('Rejected invalid AI Assist panel IPC');
		}

		switch (value.type) {
			case 'cancel': {
				this.cancelActiveRequest();
				this.sessionState.cancel();
				this.notice = 'Request cancelled.';
				this.broadcastState();
				break;
			}

			case 'close': {
				this.panelWindow?.close();
				break;
			}

			case 'save-api-key': {
				this.saveApiKey(value.apiKey);
				this.broadcastState();
				break;
			}

			case 'delete-api-key': {
				this.cancelActiveRequest();
				config.delete('aiAssistOpenAiKeyCiphertext');
				this.answer = undefined;
				this.error = undefined;
				this.notice = 'OpenAI API key deleted.';
				this.broadcastState();
				break;
			}

			case 'refresh-conversation': {
				await this.refreshConversation();
				break;
			}

			case 'test-api-key': {
				await this.runOpenAiRequest('Reply with exactly: OK', true);
				break;
			}

			case 'submit-prompt': {
				await this.runOpenAiRequest(value.prompt, false);
				break;
			}

			default:
		}

		return this.state;
	};

	private readonly handleMessengerEvent = (event: IpcMainEvent, value: unknown): void => {
		if (!this.isExpectedMessengerSender(event) || !isAiAssistMessengerEvent(value)) {
			return;
		}

		if (value.requestId && !this.pendingConversationReports.has(value.requestId)) {
			return;
		}

		if (value.status === 'available') {
			const shouldInvalidate = this.conversationBinding.reportAvailable(
				value.conversationId,
				value.displayName,
			);
			if (shouldInvalidate) {
				this.invalidate('conversation-changed', false, value.requestId);
			} else {
				this.broadcastState();
			}

			this.resolveConversationReport(value.requestId);
			return;
		}

		const shouldInvalidate = this.conversationBinding.reportUnavailable();
		if (shouldInvalidate) {
			this.invalidate('conversation-unavailable', false, value.requestId);
		} else {
			this.broadcastState();
		}

		this.resolveConversationReport(value.requestId);
	};

	private bindMessengerLifecycle(): void {
		const {webContents} = this.messengerWindow;

		webContents.on('did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => {
			if (isMainFrame) {
				this.invalidate('messenger-reloaded');
			}
		});

		webContents.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
			if (isMainFrame) {
				this.invalidate('conversation-changed');
				this.notifyMessenger({type: 'report-conversation'});
			}
		});

		webContents.on('render-process-gone', () => {
			this.invalidate('messenger-reloaded');
		});

		webContents.on('dom-ready', () => {
			this.notifyMessenger({
				type: 'set-enabled',
				enabled: config.get('aiAssistEnabled'),
			});
		});
	}

	private createPanelWindow(): BrowserWindow {
		const panelHtmlPath = path.join(__dirname, '..', 'static', 'ai-assist', 'index.html');
		const panelUrl = pathToFileURL(panelHtmlPath).toString();
		this.panelUrl = panelUrl;
		const panel = new BrowserWindow({
			title: 'Caprine AI Assist',
			show: false,
			width: 440,
			height: 720,
			minWidth: 380,
			minHeight: 560,
			titleBarStyle: 'hiddenInset',
			backgroundColor: '#111318',
			webPreferences: {
				preload: path.join(__dirname, 'preload', 'ai-assist-panel.js'),
				partition: panelPartition,
				contextIsolation: true,
				nodeIntegration: false,
				nodeIntegrationInSubFrames: false,
				nodeIntegrationInWorker: false,
				sandbox: true,
				webviewTag: false,
			},
		});

		const panelSession = panel.webContents.session;
		panelSession.setPermissionCheckHandler(() => false);
		panelSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
			callback(false);
		});
		panelSession.webRequest.onBeforeRequest({
			urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'],
		}, (_details, callback) => {
			callback({cancel: true});
		});

		panel.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
		panel.webContents.on('will-attach-webview', event => {
			event.preventDefault();
		});
		panel.webContents.on('will-navigate', (event, url) => {
			if (url !== panelUrl) {
				event.preventDefault();
			}
		});
		panel.webContents.on('did-fail-load', (_event, errorCode, _description, url) => {
			if (url === panelUrl && !panel.isDestroyed()) {
				console.error(`AI Assist panel failed to load (${errorCode})`);
				this.invalidate('panel-failed');
				panel.destroy();
			}
		});
		panel.webContents.on('dom-ready', () => {
			this.broadcastState();
		});
		panel.once('ready-to-show', () => {
			panel.show();
		});
		panel.on('closed', () => {
			if (this.panelWindow === panel) {
				this.advanceConversationLifecycle();
				this.cancelActiveRequest();
				this.conversationBinding.close();
				if (this.sessionState.snapshot.status !== 'invalidated') {
					this.sessionState.invalidate('panel-closed');
				}

				this.panelWindow = undefined;
				this.panelUrl = undefined;
			}
		});

		void panel.loadFile(panelHtmlPath).catch(() => {
			if (!panel.isDestroyed()) {
				console.error('AI Assist panel failed to load');
				this.invalidate('panel-failed');
				panel.destroy();
			}
		});
		return panel;
	}

	private isExpectedPanelSender(event: IpcMainInvokeEvent): boolean {
		return Boolean(this.panelWindow)
			&& !this.panelWindow!.isDestroyed()
			&& event.sender === this.panelWindow!.webContents
			&& event.senderFrame === this.panelWindow!.webContents.mainFrame
			&& event.senderFrame.url === this.panelUrl;
	}

	private isExpectedMessengerSender(event: IpcMainEvent): boolean {
		return event.sender === this.messengerWindow.webContents
			&& event.senderFrame === this.messengerWindow.webContents.mainFrame
			&& isTrustedMessengerOrigin(event.senderFrame.origin);
	}

	private invalidate(
		reason: AiSessionInvalidationReason,
		invalidateConversation = true,
		preserveConversationReportId?: string,
	): void {
		this.advanceConversationLifecycle(preserveConversationReportId);
		this.cancelActiveRequest();
		if (invalidateConversation) {
			this.conversationBinding.invalidate();
		}

		this.sessionState.invalidate(reason);
		this.broadcastState();
	}

	private bindCurrentConversation(): void {
		const {sessionId} = this.sessionState.snapshot;
		if (
			!sessionId
			|| !this.conversationBinding.bind(sessionId, this.messengerWindow.webContents.id)
		) {
			this.sessionState.invalidate('conversation-unavailable');
		}
	}

	private async refreshConversation(): Promise<void> {
		const lifecycleBeforeReport = this.conversationLifecycle.snapshot;
		const reportedGeneration = await this.requestConversationState();
		if (reportedGeneration === undefined) {
			if (this.conversationLifecycle.isCurrent(lifecycleBeforeReport)) {
				this.conversationBinding.reportUnavailable();
				this.invalidate('conversation-unavailable', false);
			}

			return;
		}

		if (
			!this.conversationLifecycle.isCurrent(reportedGeneration)
			|| !this.panelWindow
			|| this.panelWindow.isDestroyed()
		) {
			return;
		}

		this.cancelActiveRequest();
		this.answer = undefined;
		this.error = undefined;
		this.notice = undefined;
		this.sessionState.open();
		this.bindCurrentConversation();
		this.broadcastState();
	}

	private async requestConversationState(): Promise<number | undefined> {
		if (this.messengerWindow.isDestroyed() || this.messengerWindow.webContents.isDestroyed()) {
			return;
		}

		const requestId = `conversation-report-${++this.conversationReportCounter}`;
		return new Promise(resolve => {
			const timeout = setTimeout(() => {
				this.pendingConversationReports.delete(requestId);
				resolve(undefined);
			}, 1500);
			this.pendingConversationReports.set(requestId, generation => {
				clearTimeout(timeout);
				resolve(generation);
			});
			this.notifyMessenger({requestId, type: 'report-conversation'});
		});
	}

	private resolveConversationReport(requestId: string | undefined): void {
		if (!requestId) {
			return;
		}

		const resolve = this.pendingConversationReports.get(requestId);
		if (resolve) {
			this.pendingConversationReports.delete(requestId);
			resolve(this.conversationLifecycle.snapshot);
		}
	}

	private advanceConversationLifecycle(preserveRequestId?: string): void {
		this.conversationLifecycle.advance();
		for (const [requestId, resolve] of this.pendingConversationReports) {
			if (requestId !== preserveRequestId) {
				this.pendingConversationReports.delete(requestId);
				resolve(undefined);
			}
		}
	}

	private saveApiKey(apiKey: string): void {
		this.error = undefined;
		this.notice = undefined;
		if (!safeStorage.isEncryptionAvailable()) {
			this.error = {
				code: 'provider-unavailable',
				message: 'macOS secure storage is unavailable. The API key was not saved.',
			};
			return;
		}

		const normalizedApiKey = apiKey.trim();
		if (normalizedApiKey.length < 10 || normalizedApiKey.length > 512) {
			this.error = {
				code: 'authentication',
				message: 'Enter a valid OpenAI API key.',
			};
			return;
		}

		const encryptedKey = safeStorage.encryptString(normalizedApiKey).toString('base64');
		config.set('aiAssistOpenAiKeyCiphertext', encryptedKey);
		this.notice = 'OpenAI API key saved securely on this Mac.';
	}

	private readApiKey(): string {
		const encryptedKey = config.get('aiAssistOpenAiKeyCiphertext');
		if (!encryptedKey) {
			throw new OpenAiRequestError('missing-key', 'Add an OpenAI API key in Settings first.');
		}

		if (!safeStorage.isEncryptionAvailable()) {
			throw new OpenAiRequestError('provider-unavailable', 'macOS secure storage is unavailable. Restart Caprine and try again.');
		}

		try {
			return safeStorage.decryptString(Buffer.from(encryptedKey, 'base64'));
		} catch {
			throw new OpenAiRequestError('authentication', 'The saved OpenAI API key could not be unlocked. Replace it in Settings.');
		}
	}

	private async runOpenAiRequest(prompt: string, isConnectionTest: boolean): Promise<void> {
		const lifecycleBeforeReport = this.conversationLifecycle.snapshot;
		const reportedGeneration = await this.requestConversationState();
		if (reportedGeneration === undefined) {
			if (this.conversationLifecycle.isCurrent(lifecycleBeforeReport)) {
				this.conversationBinding.reportUnavailable();
				this.invalidate('conversation-unavailable', false);
			}

			return;
		}

		if (!this.conversationLifecycle.isCurrent(reportedGeneration)) {
			return;
		}

		const conversationSnapshot = this.conversationBinding.currentSnapshot;
		if (
			this.sessionState.snapshot.status === 'closed'
			|| this.sessionState.snapshot.status === 'invalidated'
			|| !this.conversationBinding.isCurrent(conversationSnapshot)
			|| conversationSnapshot?.messengerWebContentsId !== this.messengerWindow.webContents.id
			|| conversationSnapshot?.sessionId !== this.sessionState.snapshot.sessionId
		) {
			this.error = {
				code: 'provider-unavailable',
				message: 'Conversation changed — refresh context before asking AI.',
			};
			this.broadcastState();
			return;
		}

		if (this.activeRequest) {
			return;
		}

		let apiKey: string;
		try {
			apiKey = this.readApiKey();
		} catch (error) {
			this.setRequestError(error);
			this.broadcastState();
			return;
		}

		const request = {
			abortController: new AbortController(),
			id: ++this.requestCounter,
		};
		this.activeRequest = request;
		this.answer = undefined;
		this.error = undefined;
		this.notice = isConnectionTest ? 'Testing the saved OpenAI API key…' : undefined;
		this.sessionState.beginRequest();
		this.broadcastState();

		try {
			const answer = await this.openAiClient.createResponse(apiKey, prompt, request.abortController.signal);
			if (this.activeRequest?.id !== request.id) {
				return;
			}

			if (isConnectionTest) {
				this.error = undefined;
				this.notice = 'OpenAI API key works.';
			} else {
				this.answer = answer;
				this.error = undefined;
				this.notice = undefined;
			}
		} catch (error) {
			if (this.activeRequest?.id !== request.id) {
				return;
			}

			this.setRequestError(error);
		} finally {
			apiKey = '';
			if (this.activeRequest?.id === request.id) {
				this.activeRequest = undefined;
				this.sessionState.completeRequest();
				this.broadcastState();
			}
		}
	}

	private setRequestError(error: unknown): void {
		const requestError = error instanceof OpenAiRequestError
			? error
			: new OpenAiRequestError('provider-unavailable', 'OpenAI is unavailable right now. Try again later.');
		this.answer = undefined;
		this.notice = undefined;
		this.error = {
			code: requestError.code,
			message: requestError.message,
		};
	}

	private cancelActiveRequest(): void {
		this.activeRequest?.abortController.abort();
		this.activeRequest = undefined;
	}

	private broadcastState(): void {
		if (this.panelWindow && !this.panelWindow.isDestroyed()) {
			this.panelWindow.webContents.send(aiAssistIpcChannels.panelStateChanged, this.state);
		}
	}

	private notifyMessenger(command: AiAssistMessengerCommand): void {
		if (!this.messengerWindow.isDestroyed() && !this.messengerWindow.webContents.isDestroyed()) {
			this.messengerWindow.webContents.send(aiAssistIpcChannels.messengerCommand, command);
		}
	}
}

let controller: AiAssistController | undefined;

export function initializeAiAssist(messengerWindow: BrowserWindow): void {
	controller ??= new AiAssistController(messengerWindow);
}

export function openAiAssistPanel(): void {
	controller?.open();
}

export function setAiAssistEnabled(enabled: boolean): void {
	if (controller) {
		controller.setEnabled(enabled);
	} else {
		config.set('aiAssistEnabled', enabled);
	}
}
