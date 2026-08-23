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
	AiAssistSessionStateMachine,
	AiSessionInvalidationReason,
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
	private error?: {code: OpenAiErrorCode; message: string};
	private notice?: string;
	private readonly openAiClient = new OpenAiClient();
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

		this.sessionState.open();
		this.panelWindow = this.createPanelWindow();
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

		this.invalidate('conversation-changed');
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
				this.cancelActiveRequest();
				this.panelWindow = undefined;
				this.panelUrl = undefined;
				this.sessionState.close();
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

	private invalidate(reason: AiSessionInvalidationReason): void {
		this.cancelActiveRequest();
		this.sessionState.invalidate(reason);
		this.broadcastState();
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
		if (this.sessionState.snapshot.status === 'closed' || this.sessionState.snapshot.status === 'invalidated') {
			this.error = {
				code: 'provider-unavailable',
				message: 'Reopen AI Assist to start a fresh private session.',
			};
			this.broadcastState();
			return;
		}

		if (this.activeRequest) {
			this.error = {
				code: 'provider-unavailable',
				message: 'A request is already active. Cancel it before starting another.',
			};
			this.broadcastState();
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
				this.notice = 'OpenAI API key works.';
			} else {
				this.answer = answer;
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
