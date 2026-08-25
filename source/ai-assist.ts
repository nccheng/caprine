import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {
	app,
	BrowserWindow,
	IpcMainEvent,
	IpcMainInvokeEvent,
	ipcMain,
	safeStorage,
} from 'electron';
import config from './config';
import {
	aiAssistIpcChannels,
	AiComposerCommandRequest,
	AiComposerCommandResult,
	AiMessageAnchorRequest,
	AiAssistMessengerCommand,
	AiAssistMessengerEvent,
	AiAssistPanelCommand,
	AiAssistPanelState,
	isAiAssistMessengerEvent,
	isAiAssistPanelCommand,
	isDraftInsertionAuthorizationCheck,
	isAiComposerCommandRequest,
	isAiMessageAnchorRequest,
	MessengerMediaCandidate,
	MessengerMediaResolution,
} from './ai-assist-ipc';
import {
	AiConversationBinding,
	AiAssistSessionStateMachine,
	AiSessionInvalidationReason,
	ConversationBoundAnswer,
	ConversationLifecycle,
	ConversationReportGate,
	ConversationSnapshot,
	captureMessageAnchorSnapshot,
	MessageAnchorSnapshot,
} from './ai-assist-state';
import {isTrustedMessengerOrigin} from './ipc-validation';
import {MediaKind} from './media-contract';
import {
	MediaDiagnostic,
	MessengerMediaResolver,
} from './media-resolver';
import {
	isMessengerMediaResolverRequest,
	messengerMediaResolverChannel,
} from './media-resolver-ipc';
import {
	OpenAiClient,
	OpenAiAnswer,
	openAiPromptCharacterLimit,
	OpenAiErrorCode,
	OpenAiRequestError,
} from './openai-client';
import {
	buildReviewedPrompt,
	ContextReviewSnapshot,
	ContextWindowSize,
	contextReviewSubmissionDecision,
	createUnlockedContextReview,
	editContextReviewItem,
	removeContextReviewItem,
	updateContextReview,
} from './context-review';
import {
	draftInsertionTimeoutResult,
	DraftInsertionAuthorizationState,
	DraftInsertionFailureReason,
	DraftInsertionResult,
} from './draft-insertion';

const panelPartition = 'ai-assist';

class AiAssistController {
	private answerGeneration = 0;
	private anchor?: {
		sequence: number;
		snapshot: Readonly<MessageAnchorSnapshot>;
	};

	private anchorSequence = 0;
	private activeRequest?: {
		abortController: AbortController;
		id: number;
		snapshot: Readonly<ConversationSnapshot>;
	};

	private readonly answer = new ConversationBoundAnswer<OpenAiAnswer>();
	private readonly draftInsertionAuthorization = new DraftInsertionAuthorizationState();
	private draftInsertionGeneration = 0;
	private draftInsertionRequestCounter = 0;
	private readonly conversationBinding = new AiConversationBinding();
	private readonly conversationLifecycle = new ConversationLifecycle();
	private conversationReportCounter = 0;
	private readonly conversationReportGate = new ConversationReportGate();
	private contextCaptureCounter = 0;
	private error?: {code: OpenAiErrorCode; message: string};
	private invocation?: AiAssistPanelState['invocation'];
	private invocationSequence = 0;
	private mediaCandidates: MessengerMediaCandidate[] = [];
	private mediaRequestCounter = 0;
	private mediaResolution?: MessengerMediaResolution;
	private readonly mediaCleanupReady: Promise<void>;
	private readonly mediaResolver: MessengerMediaResolver;
	private notice?: string;
	private readonly openAiClient = new OpenAiClient();
	private readonly pendingConversationReports = new Map<string, (generation?: number) => void>();
	private pendingDraftInsertion?: {
		answerGeneration: number;
		authorizationToken: string;
		conversationId: string;
		requestId: string;
		resolve: (result: DraftInsertionResult) => void;
		snapshot: Readonly<ConversationSnapshot>;
	};

	private pendingContextCapture?: {
		anchorMessageId?: string;
		question: string;
		requestId: string;
		requestedCount: ContextWindowSize;
		resolve: () => void;
		snapshot: Readonly<ConversationSnapshot>;
	};

	private readonly pendingMediaRequests = new Map<string, {
		abortController: AbortController;
		durationSeconds?: number;
		kind: MediaKind;
		messageId: string;
		resolve: () => void;
		snapshot: Readonly<ConversationSnapshot>;
	}>();

	private requestCounter = 0;
	private review?: {
		locked: boolean;
		sequence: number;
		snapshot: Readonly<ContextReviewSnapshot>;
	};

	private reviewSequence = 0;
	private readonly sessionState = new AiAssistSessionStateMachine();
	private panelUrl?: string;
	private panelReady?: Promise<boolean>;
	private panelWindow?: BrowserWindow;

	constructor(private readonly messengerWindow: BrowserWindow) {
		this.mediaResolver = new MessengerMediaResolver(
			path.join(app.getPath('temp'), 'caprine-ai-assist-media'),
			async (url, init) => messengerWindow.webContents.session.fetch(url, init),
			diagnostic => {
				this.reportMediaDiagnostic(diagnostic);
			},
		);
		this.mediaCleanupReady = this.mediaResolver.cleanupRestartArtifacts().catch(() => undefined);
		ipcMain.handle(aiAssistIpcChannels.composerCommand, this.handleComposerCommand);
		ipcMain.handle(aiAssistIpcChannels.draftInsertionAuthorization, this.handleDraftInsertionAuthorizationCheck);
		ipcMain.handle(aiAssistIpcChannels.messageAnchor, this.handleMessageAnchor);
		ipcMain.handle(aiAssistIpcChannels.panelCommand, this.handlePanelCommand);
		ipcMain.handle(messengerMediaResolverChannel, this.handleMessengerMediaResolverRequest);
		ipcMain.on(aiAssistIpcChannels.messengerEvent, this.handleMessengerEvent);
		this.bindMessengerLifecycle();
	}

	get state(): AiAssistPanelState {
		const request: AiAssistPanelState['request'] = {};
		const answer = this.answer.read(this.conversationBinding.currentSnapshot);
		if (answer !== undefined) {
			request.answer = answer;
		}

		if (this.error !== undefined) {
			request.error = this.error;
		}

		if (this.notice !== undefined) {
			request.notice = this.notice;
		}

		const insertion = this.draftInsertionAuthorization.read(this.conversationBinding.currentSnapshot);
		if (insertion !== undefined) {
			request.insertion = insertion;
		}

		return {
			...(this.anchor && this.isRequestSnapshotCurrent(this.anchor.snapshot.snapshot) ? {
				anchor: {
					item: this.anchor.snapshot.item,
					loadedCount: this.anchor.snapshot.loadedCount,
					loadedIndex: this.anchor.snapshot.loadedIndex,
					sequence: this.anchor.sequence,
				},
			} : {}),
			conversation: this.conversationBinding.panelState,
			contextCapturePending: this.pendingContextCapture !== undefined,
			contextWindowSize: config.get('aiAssistContextWindowSize'),
			webSearchMode: config.get('aiAssistWebSearchMode'),
			credentials: {
				configured: this.hasApiKey,
				secureStorageAvailable: safeStorage.isEncryptionAvailable(),
			},
			enabled: config.get('aiAssistEnabled'),
			...(this.invocation ? {invocation: this.invocation} : {}),
			media: {
				candidates: this.mediaCandidates,
				...(this.mediaResolution ? {resolution: this.mediaResolution} : {}),
			},
			...(this.review && this.isRequestSnapshotCurrent(this.review.snapshot.snapshot) ? {
				review: {
					actualCount: this.review.snapshot.actualCount,
					items: this.review.snapshot.items,
					locked: this.review.locked,
					newMessagesAvailable: this.review.snapshot.newMessagesAvailable,
					question: this.review.snapshot.question,
					requestedCount: this.review.snapshot.requestedCount,
					sequence: this.review.sequence,
				},
			} : {}),
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

		this.showPanelWindow();
		void this.refreshConversation();
		this.broadcastState();
	}

	private readonly handleComposerCommand = async (
		event: IpcMainInvokeEvent,
		value: unknown,
	): Promise<AiComposerCommandResult> => {
		if (!this.isExpectedMessengerSender(event) || !isAiComposerCommandRequest(value)) {
			throw new TypeError('Rejected invalid AI Assist composer command IPC');
		}

		return {accepted: await this.acceptComposerCommand(value)};
	};

	private readonly handleMessageAnchor = async (
		event: IpcMainInvokeEvent,
		value: unknown,
	): Promise<AiComposerCommandResult> => {
		if (!this.isExpectedMessengerSender(event) || !isAiMessageAnchorRequest(value)) {
			throw new TypeError('Rejected invalid AI Assist message anchor IPC');
		}

		return {accepted: await this.acceptMessageAnchor(value)};
	};

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
				this.cancelPendingContextCapture();
				this.cancelPendingDraftInsertion('stale-authorization');
				this.cancelMediaResolution();
				this.sessionState.cancel();
				this.review = undefined;
				this.draftInsertionAuthorization.invalidate();
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
				this.clearConversationBoundRequestState();
				config.delete('aiAssistOpenAiKeyCiphertext');
				this.notice = 'OpenAI API key deleted.';
				this.broadcastState();
				break;
			}

			case 'edit-context-item': {
				this.editContextItem(value.reviewSequence, value.itemId, value.editedExcerpt);
				break;
			}

			case 'insert-answer': {
				await this.insertAnswer(value);
				break;
			}

			case 'refresh-conversation': {
				await this.refreshConversation();
				break;
			}

			case 'refresh-context': {
				await this.requestContextReview(
					this.review?.snapshot.question ?? this.invocation?.prompt ?? '',
					this.anchor?.snapshot.item.messageId,
				);
				break;
			}

			case 'remove-context-item': {
				this.removeContextItem(value.reviewSequence, value.itemId);
				break;
			}

			case 'resolve-media': {
				await this.resolveMedia(value.messageId, value.kind);
				break;
			}

			case 'set-context-window': {
				config.set('aiAssistContextWindowSize', value.requestedCount);
				await this.requestContextReview(
					this.review?.snapshot.question ?? this.invocation?.prompt ?? '',
					this.anchor?.snapshot.item.messageId,
				);
				break;
			}

			case 'set-web-search-mode': {
				if (this.sessionState.snapshot.status === 'requesting' || this.review?.locked) {
					break;
				}

				config.set('aiAssistWebSearchMode', value.mode);
				this.clearAnswer();
				this.error = undefined;
				this.notice = `Web search mode set to ${value.mode}.`;
				this.broadcastState();
				break;
			}

			case 'test-api-key': {
				await this.runOpenAiRequest('Reply with exactly: OK', true);
				break;
			}

			case 'submit-prompt': {
				await this.submitReviewedPrompt(value.prompt);
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

		if (value.type === 'draft-insertion') {
			this.handleDraftInsertionResult(value);
			return;
		}

		if (!this.conversationReportGate.acceptsReports) {
			return;
		}

		if (value.type === 'context-capture') {
			this.handleContextCapture(value);
			return;
		}

		if (value.type === 'media-resolution') {
			void this.handleMediaResolution(value);
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
				this.mediaCandidates = value.mediaCandidates ?? [];
				if (
					this.review
					&& value.contextVersion
					&& value.contextVersion !== this.review.snapshot.contextVersion
				) {
					this.review = {
						locked: this.review.locked,
						sequence: this.review.sequence,
						snapshot: updateContextReview(this.review.snapshot, {newMessagesAvailable: true}),
					};
				}

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

	private readonly handleMessengerMediaResolverRequest = async (
		event: IpcMainInvokeEvent,
		value: unknown,
	): Promise<Extract<AiAssistMessengerEvent, {type: 'media-resolution'}>> => {
		if (!this.isExpectedMessengerSender(event) || !isMessengerMediaResolverRequest(value)) {
			throw new TypeError('Rejected invalid AI Assist media resolver IPC');
		}

		const pending = this.pendingMediaRequests.get(value.requestId);
		if (
			!pending
			|| pending.kind !== value.kind
			|| pending.messageId !== value.messageId
			|| pending.abortController.signal.aborted
			|| !this.isRequestSnapshotCurrent(pending.snapshot)
		) {
			throw new TypeError('Rejected stale AI Assist media resolver IPC');
		}

		const media = value.sourceType === 'https'
			? await this.mediaResolver.resolveHttps(
				value.url,
				value.kind,
				value.messageId,
				pending.snapshot,
				pending.durationSeconds,
				pending.abortController.signal,
			)
			: await this.mediaResolver.resolveBlob(
				value.bytes,
				value.mimeType,
				value.kind,
				value.messageId,
				pending.snapshot,
				pending.durationSeconds,
			);
		if (
			this.pendingMediaRequests.get(value.requestId) !== pending
			|| pending.abortController.signal.aborted
			|| !this.isRequestSnapshotCurrent(pending.snapshot)
		) {
			await this.mediaResolver.releaseHandle(media.handleId);
			throw new TypeError('Rejected stale AI Assist media handle');
		}

		return {
			...media,
			requestId: value.requestId,
			status: 'available',
			type: 'media-resolution',
		};
	};

	private readonly handleDraftInsertionAuthorizationCheck = (
		event: IpcMainInvokeEvent,
		value: unknown,
	): boolean => {
		if (!this.isExpectedMessengerSender(event) || !isDraftInsertionAuthorizationCheck(value)) {
			throw new TypeError('Rejected invalid draft insertion authorization IPC');
		}

		const pending = this.pendingDraftInsertion;
		return config.get('aiAssistEnabled')
			&& pending !== undefined
			&& pending.requestId === value.requestId
			&& pending.answerGeneration === value.answerGeneration
			&& pending.authorizationToken === value.authorizationToken
			&& pending.conversationId === value.conversationId
			&& this.isRequestSnapshotCurrent(pending.snapshot);
	};

	private bindMessengerLifecycle(): void {
		const {webContents} = this.messengerWindow;

		webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
			if (isMainFrame) {
				this.conversationReportGate.markNavigationStarted(isInPlace);
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
			this.conversationReportGate.markNavigationStarted();
			this.invalidate('messenger-reloaded');
		});

		webContents.on('dom-ready', () => {
			this.conversationReportGate.markDocumentReady();
			this.notifyMessenger({
				type: 'set-enabled',
				enabled: config.get('aiAssistEnabled'),
			});
		});
	}

	private showPanelWindow(): void {
		if (this.panelWindow && !this.panelWindow.isDestroyed()) {
			this.panelWindow.show();
			this.panelWindow.focus();
			return;
		}

		this.panelWindow = this.createPanelWindow();
	}

	private async acceptComposerCommand(value: Readonly<AiComposerCommandRequest>): Promise<boolean> {
		if (!config.get('aiAssistEnabled')) {
			return false;
		}

		this.showPanelWindow();
		if (!await this.panelReady || !this.panelWindow || this.panelWindow.isDestroyed()) {
			return false;
		}

		await this.refreshConversation();
		const snapshot = this.conversationBinding.currentSnapshot;
		if (
			!snapshot
			|| snapshot.conversationId !== value.conversationId
			|| !this.isRequestSnapshotCurrent(snapshot)
		) {
			return false;
		}

		this.invocation = {
			prompt: value.prompt,
			sequence: ++this.invocationSequence,
		};
		this.anchor = undefined;
		this.notice = value.prompt
			? 'The /ai question moved here without being sent to Messenger.'
			: 'Enter your question here for the strongest private-input path.';
		this.panelWindow.show();
		this.panelWindow.focus();
		this.broadcastState();
		void this.requestContextReview(value.prompt);
		return true;
	}

	private async acceptMessageAnchor(value: Readonly<AiMessageAnchorRequest>): Promise<boolean> {
		if (!config.get('aiAssistEnabled')) {
			return false;
		}

		this.showPanelWindow();
		if (!await this.panelReady || !this.panelWindow || this.panelWindow.isDestroyed()) {
			return false;
		}

		await this.refreshConversation();
		const snapshot = this.conversationBinding.currentSnapshot;
		if (
			!snapshot
			|| snapshot.conversationId !== value.conversationId
			|| !this.isRequestSnapshotCurrent(snapshot)
		) {
			return false;
		}

		this.anchor = {
			sequence: ++this.anchorSequence,
			snapshot: captureMessageAnchorSnapshot({
				item: value.item,
				loadedCount: value.loadedCount,
				loadedIndex: value.loadedIndex,
			}, snapshot),
		};
		this.invocation = {
			prompt: '',
			sequence: ++this.invocationSequence,
		};
		this.notice = 'Ask AI is anchored to this message. Nothing has left Messenger.';
		this.panelWindow.show();
		this.panelWindow.focus();
		this.broadcastState();
		void this.requestContextReview('', value.item.messageId);
		return true;
	}

	private async requestContextReview(question: string, anchorMessageId?: string): Promise<void> {
		this.cancelPendingContextCapture();
		const snapshot = this.conversationBinding.currentSnapshot;
		if (!snapshot || !this.isRequestSnapshotCurrent(snapshot)) {
			this.review = undefined;
			this.error = undefined;
			this.notice = 'Messenger context is unavailable. Refresh context and try again.';
			this.broadcastState();
			return;
		}

		this.review = undefined;
		this.error = undefined;
		const requestedCount = config.get('aiAssistContextWindowSize');
		const requestId = `context-capture-${++this.contextCaptureCounter}`;
		this.notice = `Capturing up to ${requestedCount} Messenger messages for local review…`;
		return new Promise(resolve => {
			const timeout = setTimeout(() => {
				if (this.pendingContextCapture?.requestId !== requestId) {
					return;
				}

				this.pendingContextCapture = undefined;
				this.notifyMessenger({requestId, type: 'cancel-context-capture'});
				this.error = undefined;
				this.notice = 'Messenger context capture timed out. Nothing was sent. Select Refresh context to retry.';
				this.broadcastState();
				resolve();
			}, 3500);
			this.pendingContextCapture = {
				...(anchorMessageId ? {anchorMessageId} : {}),
				question,
				requestId,
				requestedCount,
				resolve() {
					clearTimeout(timeout);
					resolve();
				},
				snapshot,
			};
			this.broadcastState();
			this.notifyMessenger({
				...(anchorMessageId ? {anchorMessageId} : {}),
				conversationId: snapshot.conversationId,
				requestId,
				requestedCount,
				type: 'capture-context',
			});
		});
	}

	private handleContextCapture(value: Extract<AiAssistMessengerEvent, {type: 'context-capture'}>): void {
		const pending = this.pendingContextCapture;
		if (!pending || pending.requestId !== value.requestId) {
			return;
		}

		this.pendingContextCapture = undefined;
		if (!this.isRequestSnapshotCurrent(pending.snapshot)) {
			pending.resolve();
			return;
		}

		if (
			value.status === 'unavailable'
			|| value.conversationId !== pending.snapshot.conversationId
			|| value.requestedCount !== pending.requestedCount
			|| (value.stopReason === 'complete' && value.items.length !== pending.requestedCount)
			|| (pending.anchorMessageId && !value.items.some(item => item.messageId === pending.anchorMessageId))
		) {
			this.review = undefined;
			this.error = undefined;
			this.notice = 'Messenger context was unavailable or ambiguous. Nothing was sent. Select Refresh context to retry.';
			this.broadcastState();
			pending.resolve();
			return;
		}

		this.review = {
			...createUnlockedContextReview({
				contextVersion: value.contextVersion,
				items: value.items.map((item, index) => ({id: `${value.requestId}:${index}`, item})),
				question: pending.question,
				requestedCount: pending.requestedCount,
				snapshot: pending.snapshot,
			}),
			sequence: ++this.reviewSequence,
		};
		this.error = undefined;
		this.notice = `${value.items.length} of ${pending.requestedCount} messages available for review. Nothing has left Messenger.`;
		this.broadcastState();
		pending.resolve();
	}

	private removeContextItem(reviewSequence: number, itemId: string): void {
		if (
			!this.review
			|| this.review.locked
			|| this.review.sequence !== reviewSequence
			|| this.sessionState.snapshot.status === 'requesting'
			|| !this.isRequestSnapshotCurrent(this.review.snapshot.snapshot)
		) {
			return;
		}

		const snapshot = removeContextReviewItem(this.review.snapshot, itemId);
		if (!snapshot) {
			return;
		}

		this.review = {
			locked: false,
			sequence: this.review.sequence,
			snapshot,
		};
		this.notice = 'Context item removed from this request.';
		this.broadcastState();
	}

	private editContextItem(reviewSequence: number, itemId: string, editedExcerpt: string): void {
		if (
			!this.review
			|| this.review.locked
			|| this.review.sequence !== reviewSequence
			|| this.sessionState.snapshot.status === 'requesting'
			|| !this.isRequestSnapshotCurrent(this.review.snapshot.snapshot)
		) {
			return;
		}

		const snapshot = editContextReviewItem(this.review.snapshot, itemId, editedExcerpt);
		if (!snapshot) {
			return;
		}

		this.review = {
			locked: false,
			sequence: this.review.sequence,
			snapshot,
		};
		this.notice = 'Edited excerpt saved for this request.';
		this.broadcastState();
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
				this.clearConversationBoundRequestState();
				this.clearMediaState();
				this.conversationBinding.close();
				if (this.sessionState.snapshot.status !== 'invalidated') {
					this.sessionState.invalidate('panel-closed');
				}

				this.panelWindow = undefined;
				this.panelReady = undefined;
				this.panelUrl = undefined;
			}
		});

		this.panelReady = panel.loadFile(panelHtmlPath).then(() => !panel.isDestroyed()).catch(() => {
			if (panel.isDestroyed()) {
				return false;
			}

			console.error('AI Assist panel failed to load');
			this.invalidate('panel-failed');
			panel.destroy();
			return false;
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

	private isExpectedMessengerSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
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
		this.clearConversationBoundRequestState();
		this.clearMediaState();
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
		this.clearMediaState();
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

		this.clearConversationBoundRequestState();
		this.sessionState.open();
		this.bindCurrentConversation();
		this.broadcastState();
	}

	private async requestConversationState(): Promise<number | undefined> {
		if (
			!this.conversationReportGate.acceptsReports
			|| this.messengerWindow.isDestroyed()
			|| this.messengerWindow.webContents.isDestroyed()
		) {
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

	private async resolveMedia(messageId: string, kind: MediaKind): Promise<void> {
		await this.mediaCleanupReady;
		const snapshot = this.conversationBinding.currentSnapshot;
		const candidate = this.mediaCandidates.find(item => item.messageId === messageId && item.kind === kind);
		if (!snapshot || !this.isRequestSnapshotCurrent(snapshot) || !candidate) {
			this.mediaResolution = {kind, messageId, status: 'unavailable'};
			this.broadcastState();
			return;
		}

		this.cancelPendingMediaRequests();
		await this.mediaResolver.releaseAll();
		this.mediaResolution = {...candidate, status: 'resolving'};
		this.broadcastState();
		const requestId = `media-request-${++this.mediaRequestCounter}`;
		await new Promise<void>(resolvePromise => {
			const abortController = new AbortController();
			const timeout = setTimeout(() => {
				abortController.abort();
				this.pendingMediaRequests.delete(requestId);
				void this.mediaResolver.releaseAll();
				this.mediaResolution = {...candidate, status: 'unavailable'};
				this.broadcastState();
				resolvePromise();
			}, 32_000);
			this.pendingMediaRequests.set(requestId, {
				abortController,
				durationSeconds: candidate.durationSeconds,
				kind,
				messageId,
				resolve() {
					clearTimeout(timeout);
					resolvePromise();
				},
				snapshot,
			});
			this.notifyMessenger({
				kind,
				messageId,
				requestId,
				type: 'resolve-media',
			});
		});
	}

	private async handleMediaResolution(
		value: Extract<AiAssistMessengerEvent, {type: 'media-resolution'}>,
	): Promise<void> {
		const pending = this.pendingMediaRequests.get(value.requestId);
		if (!pending || pending.kind !== value.kind || pending.messageId !== value.messageId) {
			return;
		}

		try {
			if (!this.isRequestSnapshotCurrent(pending.snapshot)) {
				await this.mediaResolver.releaseAll();
				return;
			}

			if (value.status === 'unsupported') {
				this.mediaResolver.reportUnsupported(value.kind, value.durationSeconds);
				this.mediaResolution = {
					...(value.durationSeconds === undefined ? {} : {durationSeconds: value.durationSeconds}),
					kind: value.kind,
					messageId: value.messageId,
					sourceType: 'segmented',
					status: 'unsupported',
				};
				return;
			}

			if (value.status === 'unavailable') {
				if (value.sourceType === 'blob' || value.sourceType === 'https') {
					this.mediaResolver.reportUnavailable(value.sourceType, value.kind, value.durationSeconds);
				}

				this.mediaResolution = {
					...(value.durationSeconds === undefined ? {} : {durationSeconds: value.durationSeconds}),
					kind: value.kind,
					messageId: value.messageId,
					status: 'unavailable',
				};
				return;
			}

			const media = this.mediaResolver.describeHandle(
				value.handleId!,
				value.messageId,
				pending.snapshot,
			);
			if (
				media.kind !== value.kind
				|| media.sourceType !== value.sourceType
				|| media.byteLength !== value.byteLength
				|| media.mimeType !== value.mimeType
			) {
				await this.mediaResolver.releaseHandle(media.handleId);
				throw new TypeError('Rejected mismatched AI Assist media handle');
			}

			this.mediaResolution = {...media, status: 'ready'};
		} catch {
			this.mediaResolution = {
				...(value.durationSeconds === undefined ? {} : {durationSeconds: value.durationSeconds}),
				kind: value.kind,
				messageId: value.messageId,
				...(value.sourceType === undefined ? {} : {sourceType: value.sourceType}),
				status: 'unavailable',
			};
		} finally {
			this.pendingMediaRequests.delete(value.requestId);
			pending.resolve();
			this.broadcastState();
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

		this.cancelPendingContextCapture();
	}

	private cancelPendingContextCapture(): void {
		const pending = this.pendingContextCapture;
		if (!pending) {
			return;
		}

		this.pendingContextCapture = undefined;
		this.notifyMessenger({requestId: pending.requestId, type: 'cancel-context-capture'});
		pending.resolve();
	}

	private async insertAnswer(
		input: Extract<AiAssistPanelCommand, {type: 'insert-answer'}>,
	): Promise<void> {
		if (this.pendingDraftInsertion) {
			this.notice = 'An answer insertion is already in progress.';
			this.broadcastState();
			return;
		}

		const reportedGeneration = await this.requestConversationState();
		if (
			reportedGeneration === undefined
			|| !this.conversationLifecycle.isCurrent(reportedGeneration)
		) {
			this.draftInsertionAuthorization.invalidate();
			this.notice = 'Messenger is unavailable. Nothing was inserted.';
			this.broadcastState();
			return;
		}

		const {currentSnapshot} = this.conversationBinding;
		const authorization = this.draftInsertionAuthorization.consume(input, currentSnapshot);
		const answer = this.answer.read(currentSnapshot);
		if (
			!authorization
			|| !answer
			|| answer.text !== authorization.text
			|| !this.isRequestSnapshotCurrent(authorization.snapshot)
		) {
			this.notice = 'This insertion authorization is stale or already used. Nothing was inserted.';
			this.broadcastState();
			return;
		}

		const requestId = `draft-insertion-request-${++this.draftInsertionRequestCounter}`;
		const insertionGeneration = ++this.draftInsertionGeneration;
		this.notice = 'Inserting the answer into the current Messenger draft…';
		this.broadcastState();
		const result = await new Promise<DraftInsertionResult>(resolvePromise => {
			const timeout = setTimeout(() => {
				if (this.pendingDraftInsertion?.requestId === requestId) {
					this.notifyMessenger({requestId, type: 'cancel-draft-insertion'});
					this.pendingDraftInsertion = undefined;
					resolvePromise(draftInsertionTimeoutResult);
				}
			}, 2500);
			this.pendingDraftInsertion = {
				answerGeneration: authorization.answerGeneration,
				authorizationToken: authorization.authorizationToken,
				conversationId: authorization.conversationId,
				requestId,
				resolve(result) {
					clearTimeout(timeout);
					resolvePromise(result);
				},
				snapshot: authorization.snapshot,
			};
			this.notifyMessenger({
				answerGeneration: authorization.answerGeneration,
				authorizationToken: authorization.authorizationToken,
				conversationId: authorization.conversationId,
				requestId,
				text: authorization.text,
				type: 'insert-draft',
			});
		});

		if (
			insertionGeneration !== this.draftInsertionGeneration
			|| !this.isRequestSnapshotCurrent(authorization.snapshot)
		) {
			return;
		}

		this.notice = result.status === 'inserted'
			? 'Answer inserted into the Messenger draft. Review it there and press Send yourself.'
			: this.draftInsertionFailureMessage(result.reason);
		this.broadcastState();
	}

	private handleDraftInsertionResult(
		value: Extract<AiAssistMessengerEvent, {type: 'draft-insertion'}>,
	): void {
		const pending = this.pendingDraftInsertion;
		if (
			!pending
			|| pending.requestId !== value.requestId
			|| pending.authorizationToken !== value.authorizationToken
			|| pending.answerGeneration !== value.answerGeneration
			|| pending.conversationId !== value.conversationId
		) {
			return;
		}

		this.pendingDraftInsertion = undefined;
		pending.resolve(value.status === 'inserted'
			? {status: 'inserted'}
			: {reason: value.reason, status: 'blocked'});
	}

	private draftInsertionFailureMessage(reason: DraftInsertionFailureReason): string {
		// eslint-disable-next-line default-case
		switch (reason) {
			case 'attachment-present': {
				return 'Messenger already has a pending attachment. Nothing was inserted.';
			}

			case 'composer-ambiguous': {
				return 'Caprine found more than one visible Messenger composer. Nothing was inserted.';
			}

			case 'composer-changed': {
				return 'The Messenger composer changed during insertion. Verify the draft before trying again.';
			}

			case 'composer-not-editable':
			case 'focus-failed': {
				return 'The current Messenger composer is not ready for editing. Nothing was inserted.';
			}

			case 'conversation-changed': {
				return 'The Messenger conversation changed. Nothing was inserted.';
			}

			case 'draft-present': {
				return 'Messenger already contains draft text. It was preserved and nothing was inserted.';
			}

			case 'partial-insertion': {
				return 'Caprine could not verify the complete inserted draft. Review the Messenger composer before continuing.';
			}

			case 'stale-authorization': {
				return 'This insertion authorization is stale or already used. Nothing was inserted.';
			}
		}
	}

	private cancelPendingDraftInsertion(reason: DraftInsertionFailureReason): void {
		const pending = this.pendingDraftInsertion;
		if (!pending) {
			return;
		}

		this.pendingDraftInsertion = undefined;
		this.draftInsertionGeneration += 1;
		this.notifyMessenger({requestId: pending.requestId, type: 'cancel-draft-insertion'});
		pending.resolve({reason, status: 'blocked'});
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

	private async submitReviewedPrompt(question: string): Promise<void> {
		if (!this.review) {
			await this.requestContextReview(question, this.anchor?.snapshot.item.messageId);
			return;
		}

		const submissionDecision = contextReviewSubmissionDecision(this.review.locked);
		if (!submissionDecision.allowed) {
			this.notice = submissionDecision.notice;
			this.broadcastState();
			return;
		}

		if (!this.isRequestSnapshotCurrent(this.review.snapshot.snapshot)) {
			this.error = {
				code: 'provider-unavailable',
				message: 'Conversation changed — capture context again before asking OpenAI.',
			};
			this.broadcastState();
			return;
		}

		this.review = {
			locked: false,
			sequence: ++this.reviewSequence,
			snapshot: updateContextReview(this.review.snapshot, {question}),
		};
		const prompt = buildReviewedPrompt(this.review.snapshot);
		if (prompt.length > openAiPromptCharacterLimit) {
			this.error = {
				code: 'input-too-large',
				message: 'The reviewed question and context are too large. Remove or redact context before asking.',
			};
			this.broadcastState();
			return;
		}

		this.review = {...this.review, locked: true};
		this.broadcastState();

		await this.runOpenAiRequest(prompt, false);
	}

	private async runOpenAiRequest(prompt: string, isConnectionTest: boolean): Promise<void> {
		const searchMode = isConnectionTest ? 'off' : config.get('aiAssistWebSearchMode');
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
		if (!this.canStartRequestForSnapshot(conversationSnapshot)) {
			this.clearConversationBoundRequestState();
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

		this.clearAnswer();
		this.error = undefined;
		this.notice = undefined;

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
			snapshot: conversationSnapshot,
		};
		this.activeRequest = request;
		this.notice = isConnectionTest ? 'Testing the saved OpenAI API key…' : undefined;
		this.sessionState.beginRequest();
		this.broadcastState();

		try {
			const answer = await this.openAiClient.createResponse(apiKey, prompt, searchMode, request.abortController.signal);
			if (this.activeRequest?.id !== request.id) {
				return;
			}

			if (!this.isRequestSnapshotCurrent(request.snapshot)) {
				this.clearConversationBoundRequestState();
				this.broadcastState();
				return;
			}

			if (isConnectionTest) {
				this.error = undefined;
				this.notice = 'OpenAI API key works.';
			} else {
				if (!this.answer.store(
					answer,
					request.snapshot,
					this.conversationBinding.currentSnapshot,
				)) {
					this.clearConversationBoundRequestState();
					this.broadcastState();
					return;
				}

				this.draftInsertionAuthorization.issue({
					answerGeneration: ++this.answerGeneration,
					authorizationToken: `draft-insertion-token:${randomUUID()}`,
					conversationId: request.snapshot.conversationId,
					snapshot: request.snapshot,
					text: answer.text,
				});

				this.error = undefined;
				this.notice = undefined;
			}
		} catch (error) {
			if (this.activeRequest?.id !== request.id) {
				return;
			}

			if (!this.isRequestSnapshotCurrent(request.snapshot)) {
				this.clearConversationBoundRequestState();
				this.broadcastState();
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

	private canStartRequestForSnapshot(
		snapshot: Readonly<ConversationSnapshot> | undefined,
	): snapshot is Readonly<ConversationSnapshot> {
		return snapshot !== undefined
			&& this.sessionState.snapshot.status !== 'closed'
			&& this.sessionState.snapshot.status !== 'invalidated'
			&& this.isRequestSnapshotCurrent(snapshot);
	}

	private isRequestSnapshotCurrent(snapshot: Readonly<ConversationSnapshot>): boolean {
		return this.conversationBinding.isCurrent(snapshot)
			&& snapshot.messengerWebContentsId === this.messengerWindow.webContents.id
			&& snapshot.sessionId === this.sessionState.snapshot.sessionId;
	}

	private clearConversationBoundRequestState(): void {
		this.cancelActiveRequest();
		this.cancelPendingContextCapture();
		this.cancelPendingDraftInsertion('conversation-changed');
		this.clearAnswer();
		this.anchor = undefined;
		this.error = undefined;
		this.invocation = undefined;
		this.review = undefined;
		this.notice = undefined;
	}

	private clearMediaState(): void {
		this.cancelMediaResolution();
		this.mediaCandidates = [];
	}

	private cancelMediaResolution(): void {
		this.cancelPendingMediaRequests();
		this.mediaResolution = undefined;
		void this.mediaResolver.releaseAll();
	}

	private cancelPendingMediaRequests(): void {
		for (const [requestId, pending] of this.pendingMediaRequests) {
			this.pendingMediaRequests.delete(requestId);
			pending.abortController.abort();
			pending.resolve();
		}
	}

	private reportMediaDiagnostic(diagnostic: MediaDiagnostic): void {
		console.info('AI Assist media resolver', diagnostic);
	}

	private setRequestError(error: unknown): void {
		const requestError = error instanceof OpenAiRequestError
			? error
			: new OpenAiRequestError('provider-unavailable', 'OpenAI is unavailable right now. Try again later.');
		this.clearAnswer();
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

	private clearAnswer(): void {
		this.answer.clear();
		this.draftInsertionAuthorization.invalidate();
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
