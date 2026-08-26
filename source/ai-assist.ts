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
	shell,
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
import {openCitationExternal} from './citation-navigation';
import {MediaKind} from './media-contract';
import {ConversationContextItem} from './messenger-context';
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
	openAiResponseModel,
	OpenAiErrorCode,
	OpenAiRequestError,
	WebSearchMode,
} from './openai-client';
import {AiHistoryInteractionInput, AiHistoryStore} from './ai-history-store';
import {
	AiHistoryDeletionAuthorizationState,
	AiHistoryDeletionScope,
	AiHistoryDeletionTarget,
} from './ai-history-deletion';
import {
	captureHistoryDestinationChatId,
	originalHistoryReplayAvailability,
	restoreOriginalHistoryReview,
} from './ai-history-replay';
import {buildAiHistoryChatViews} from './ai-history-workspace';
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
	createReviewedImageItems,
	finalizeReviewedImageSelection,
	releaseReviewedImageHandles,
	ReviewedImageItem,
	reviewedImageSelectionSummary,
	updateReviewedImageSelection,
	withSelectedReviewedImageInputs,
} from './reviewed-images';
import {
	MessengerImageCaptureStore,
	MessengerImageCaptureTargetResolution,
} from './messenger-image-capture';
import {ProcessedMessengerImageStore} from './messenger-image-normalization';
import {
	draftInsertionTimeoutResult,
	DraftInsertionAuthorizationState,
	DraftInsertionFailureReason,
	DraftInsertionResult,
} from './draft-insertion';
import {
	inspectAudioDuration,
	MediaTranscriptionService,
	OpenAiTranscriptionClient,
} from './media-transcription';
import {
	completeReviewedTranscript,
	createReviewedTranscriptItems,
	editReviewedTranscript,
	removeReviewedTranscript,
	transcriptFailure,
	updateReviewedTranscript,
} from './reviewed-transcripts';
import {VideoMetadataInspector} from './video-toolchain';
import {
	VideoFramePreprocessor,
	VideoPreprocessingArtifact,
	VideoTranscriptState,
} from './video-preprocessing';
import {
	OpenAiVideoUnderstandingProvider,
	VideoUnderstandingProgress,
	VideoUnderstandingService,
} from './video-understanding';

const panelPartition = 'ai-assist';
type ReviewContextSource = 'current' | 'historical-current' | 'historical-original';
type OpenAiRequestRunOptions = {
	isConnectionTest: boolean;
	reviewedImages?: ReadonlyArray<Readonly<ReviewedImageItem>>;
	reviewSnapshot?: Readonly<ConversationSnapshot>;
	searchMode?: WebSearchMode;
	videoArtifact?: {
		artifact: Readonly<VideoPreprocessingArtifact>;
		handleId: string;
	};
};

class AiAssistController {
	private answerGeneration = 0;
	private anchor?: {
		sequence: number;
		snapshot: Readonly<MessageAnchorSnapshot>;
	};

	private anchorSequence = 0;
	private activeRequest?: {
		abortController: AbortController;
		historyChatId?: string;
		id: number;
		snapshot: Readonly<ConversationSnapshot>;
	};

	private readonly answer = new ConversationBoundAnswer<OpenAiAnswer>();
	private readonly draftInsertionAuthorization = new DraftInsertionAuthorizationState();
	private readonly historyDeletion = new AiHistoryDeletionAuthorizationState();
	private draftInsertionGeneration = 0;
	private draftInsertionRequestCounter = 0;
	private readonly conversationBinding = new AiConversationBinding();
	private readonly conversationLifecycle = new ConversationLifecycle();
	private currentHistoryInteractionId?: string;
	private conversationReportCounter = 0;
	private readonly conversationReportGate = new ConversationReportGate();
	private contextCaptureCounter = 0;
	private imageTargetRequestCounter = 0;
	private error?: {code: OpenAiErrorCode; message: string};
	private invocation?: AiAssistPanelState['invocation'];
	private invocationSequence = 0;
	private mediaCandidates: MessengerMediaCandidate[] = [];
	private mediaRequestCounter = 0;
	private mediaResolution?: MessengerMediaResolution;
	private readonly mediaCleanupReady: Promise<void>;
	private readonly mediaResolver: MessengerMediaResolver;
	private readonly mediaTranscriptionService: MediaTranscriptionService;
	private readonly videoMetadataInspector = new VideoMetadataInspector();
	private readonly videoFramePreprocessor = new VideoFramePreprocessor();
	private videoAnalysis?: AiAssistPanelState['videoAnalysis'];
	private readonly videoArtifacts = new Map<string, {
		artifact: VideoPreprocessingArtifact;
		handleId: string;
		snapshot: Readonly<ConversationSnapshot>;
	}>();

	private readonly imageCaptures: MessengerImageCaptureStore;
	private readonly processedImages: ProcessedMessengerImageStore;
	private readonly historyStore?: AiHistoryStore;
	private historyChat?: {chatId: string; conversationId: string; sessionId: string};
	private historyConversationId?: string;
	private historyQuery = '';
	private selectedHistoryChatId?: string;
	private notice?: string;
	private readonly openAiClient = new OpenAiClient();
	private readonly pendingConversationReports = new Map<string, (generation?: number) => void>();
	private readonly pendingImageTargetRequests = new Map<string, {
		conversationId: string;
		messageId: string;
		resolve: (result: MessengerImageCaptureTargetResolution) => void;
	}>();

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
		contextSource: Exclude<ReviewContextSource, 'historical-original'>;
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

	private pendingTranscription?: {
		abortController: AbortController;
		reviewSequence: number;
		transcriptId: string;
	};

	private readonly transcriptHandles = new Map<string, {
		handleId: string;
		messageId: string;
		reviewSequence: number;
		snapshot: Readonly<ConversationSnapshot>;
	}>();

	private requestCounter = 0;
	private review?: {
		browsingMode: WebSearchMode;
		contextSource: ReviewContextSource;
		editable: boolean;
		locked: boolean;
		sequence: number;
		snapshot: Readonly<ContextReviewSnapshot>;
	};

	private reviewSequence = 0;
	private reviewedImageCapture?: {
		abortController: AbortController;
		reviewSequence: number;
		snapshot: Readonly<ConversationSnapshot>;
	};

	private readonly sessionState = new AiAssistSessionStateMachine();
	private panelUrl?: string;
	private panelReady?: Promise<boolean>;
	private panelWindow?: BrowserWindow;

	constructor(private readonly messengerWindow: BrowserWindow) {
		try {
			this.historyStore = new AiHistoryStore({
				databasePath: path.join(app.getPath('userData'), 'ai-assist-history.sqlite'),
			});
		} catch {
			console.error('AI Assist local history is unavailable');
		}

		this.mediaResolver = new MessengerMediaResolver(
			path.join(app.getPath('temp'), 'caprine-ai-assist-media'),
			async (url, init) => messengerWindow.webContents.session.fetch(url, init),
			diagnostic => {
				this.reportMediaDiagnostic(diagnostic);
			},
		);
		this.imageCaptures = new MessengerImageCaptureStore(
			async (messageId, signal) => this.resolveImageTarget(messageId, signal),
			{
				capturePage: async rectangle => messengerWindow.webContents.capturePage(rectangle),
				id: messengerWindow.webContents.id,
			},
			snapshot => this.isRequestSnapshotCurrent(snapshot),
		);
		this.processedImages = new ProcessedMessengerImageStore(
			this.imageCaptures,
			snapshot => this.isRequestSnapshotCurrent(snapshot),
		);
		this.mediaCleanupReady = this.mediaResolver.cleanupRestartArtifacts().catch(() => undefined);
		this.mediaTranscriptionService = new MediaTranscriptionService(
			this.mediaResolver,
			new OpenAiTranscriptionClient(),
			() => this.conversationBinding.currentSnapshot,
			{transcriptCache: this.historyStore},
		);
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
			contextCapturePending: this.pendingContextCapture !== undefined
				|| this.reviewedImageCapture !== undefined
				|| this.pendingTranscription !== undefined
				|| this.videoAnalysis?.status === 'analyzing',
			contextWindowSize: config.get('aiAssistContextWindowSize'),
			webSearchMode: config.get('aiAssistWebSearchMode'),
			credentials: {
				configured: this.hasApiKey,
				secureStorageAvailable: safeStorage.isEncryptionAvailable(),
			},
			enabled: config.get('aiAssistEnabled'),
			history: {
				...this.historyState,
				...(this.historyDeletion.confirmation ? {deletionConfirmation: this.historyDeletion.confirmation} : {}),
			},
			...(this.invocation ? {invocation: this.invocation} : {}),
			media: {
				candidates: this.mediaCandidates,
				...(this.mediaResolution ? {resolution: this.mediaResolution} : {}),
			},
			...(this.review && this.isRequestSnapshotCurrent(this.review.snapshot.snapshot) ? {
				review: {
					actualCount: this.review.snapshot.actualCount,
					browsingMode: this.review.browsingMode,
					contextSource: this.review.contextSource,
					editable: this.review.editable,
					imageSelection: reviewedImageSelectionSummary(this.review.snapshot.images),
					images: this.review.snapshot.images,
					items: this.review.snapshot.items,
					locked: this.review.locked,
					newMessagesAvailable: this.review.snapshot.newMessagesAvailable,
					question: this.review.snapshot.question,
					requestedCount: this.review.snapshot.requestedCount,
					sequence: this.review.sequence,
					transcripts: this.review.snapshot.transcripts,
				},
			} : {}),
			request,
			session: this.sessionState.snapshot,
			...(this.videoAnalysis ? {videoAnalysis: this.videoAnalysis} : {}),
		};
	}

	private get historyState(): AiAssistPanelState['history'] {
		const snapshot = this.conversationBinding.currentSnapshot;
		if (!snapshot) {
			this.resetHistoryWorkspace();
			return {chats: [], query: '', status: 'inactive'};
		}

		if (this.historyConversationId !== snapshot.conversationId) {
			this.historyConversationId = snapshot.conversationId;
			this.historyQuery = '';
			this.selectedHistoryChatId = undefined;
		}

		if (!this.historyStore) {
			return {chats: [], query: this.historyQuery, status: 'unavailable'};
		}

		try {
			const summaries = this.historyStore.loadConversationSummaries(snapshot.conversationId, this.historyQuery);
			if (!summaries.some(chat => chat.id === this.selectedHistoryChatId)) {
				this.selectedHistoryChatId = summaries[0]?.id;
			}

			const selectedChat = this.selectedHistoryChatId
				? this.historyStore.loadChat(snapshot.conversationId, this.selectedHistoryChatId)
				: undefined;
			const chats = buildAiHistoryChatViews(summaries, selectedChat);

			return {
				chats,
				query: this.historyQuery,
				...(this.selectedHistoryChatId ? {selectedChatId: this.selectedHistoryChatId} : {}),
				status: 'ready',
			};
		} catch {
			return {chats: [], query: this.historyQuery, status: 'unavailable'};
		}
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
				this.cancelTranscription();
				this.cancelPendingContextCapture();
				this.cancelPendingDraftInsertion('stale-authorization');
				this.cancelMediaResolution();
				this.sessionState.cancel();
				this.clearContextReview();
				this.draftInsertionAuthorization.invalidate();
				this.notice = 'Request cancelled.';
				this.broadcastState();
				break;
			}

			case 'cancel-transcription': {
				this.cancelTranscription(value.reviewSequence, value.transcriptId);
				break;
			}

			case 'cancel-history-deletion': {
				if (this.historyDeletion.cancel(value.authorizationToken)) {
					this.notice = 'History deletion cancelled. Nothing was deleted.';
				}

				this.broadcastState();
				break;
			}

			case 'close': {
				this.panelWindow?.close();
				break;
			}

			case 'confirm-history-deletion': {
				this.confirmHistoryDeletion(value.authorizationToken);
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

			case 'edit-transcript': {
				this.editTranscript(value.reviewSequence, value.transcriptId, value.texts);
				break;
			}

			case 'insert-answer': {
				await this.insertAnswer(value);
				break;
			}

			case 'include-reviewed-image': {
				this.updateReviewedImage(value.reviewSequence, value.itemId, value.processedHandleId, 'include');
				break;
			}

			case 'new-history-chat': {
				this.createHistoryChat();
				break;
			}

			case 'prepare-history-replay': {
				await this.prepareHistoryReplay(value.chatId, value.interactionId, value.contextSource);
				break;
			}

			case 'prepare-transcript': {
				await this.prepareTranscript(value.reviewSequence, value.transcriptId);
				break;
			}

			case 'prepare-history-deletion': {
				this.prepareHistoryDeletion(value.scope, value.chatId);
				break;
			}

			case 'open-citation': {
				await openCitationExternal(value.url, async url => shell.openExternal(url));
				break;
			}

			case 'refresh-conversation': {
				await this.refreshConversation();
				break;
			}

			case 'refresh-context': {
				if (this.review?.contextSource === 'historical-original') {
					this.notice = 'This is the immutable original history snapshot. Choose current context from History for a fresh capture.';
					this.broadcastState();
					break;
				}

				await this.requestContextReview(
					this.review?.snapshot.question ?? this.invocation?.prompt ?? '',
					this.anchor?.snapshot.item.messageId,
					this.review?.contextSource ?? 'current',
				);
				break;
			}

			case 'remove-context-item': {
				this.removeContextItem(value.reviewSequence, value.itemId);
				break;
			}

			case 'remove-reviewed-image': {
				this.updateReviewedImage(value.reviewSequence, value.itemId, value.processedHandleId, 'remove');
				break;
			}

			case 'remove-transcript': {
				this.removeTranscript(value.reviewSequence, value.transcriptId);
				break;
			}

			case 'resolve-media': {
				await this.resolveMedia(value.messageId, value.kind);
				break;
			}

			case 'search-history': {
				if (this.conversationBinding.currentSnapshot) {
					this.historyQuery = value.query.trim();
					this.selectedHistoryChatId = undefined;
					this.broadcastState();
				}

				break;
			}

			case 'select-history-chat': {
				this.selectHistoryChat(value.chatId);
				break;
			}

			case 'set-context-window': {
				if (this.review?.contextSource === 'historical-original') {
					break;
				}

				config.set('aiAssistContextWindowSize', value.requestedCount);
				await this.requestContextReview(
					this.review?.snapshot.question ?? this.invocation?.prompt ?? '',
					this.anchor?.snapshot.item.messageId,
					this.review?.contextSource ?? 'current',
				);
				break;
			}

			case 'set-web-search-mode': {
				if (this.sessionState.snapshot.status === 'requesting' || this.review?.locked === true || this.review?.contextSource === 'historical-original') {
					break;
				}

				config.set('aiAssistWebSearchMode', value.mode);
				this.review &&= {...this.review, browsingMode: value.mode};

				this.clearAnswer();
				this.error = undefined;
				this.notice = `Web search mode set to ${value.mode}.`;
				this.broadcastState();
				break;
			}

			case 'test-api-key': {
				await this.runOpenAiRequest('Reply with exactly: OK', {isConnectionTest: true});
				break;
			}

			case 'transcribe-reviewed-media': {
				await this.transcribeReviewedMedia(value.reviewSequence, value.transcriptId);
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

		if (value.type === 'image-target-resolution') {
			this.handleImageTargetResolution(value);
			return;
		}

		if (!this.conversationReportGate.acceptsReports) {
			return;
		}

		if (value.type === 'context-capture') {
			void this.handleContextCapture(value);
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
					&& this.review.contextSource !== 'historical-original'
					&& value.contextVersion
					&& value.contextVersion !== this.review.snapshot.contextVersion
				) {
					this.review = {
						...this.review,
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

	private async requestContextReview(
		question: string,
		anchorMessageId?: string,
		contextSource: Exclude<ReviewContextSource, 'historical-original'> = 'current',
	): Promise<void> {
		this.cancelPendingContextCapture();
		const snapshot = this.conversationBinding.currentSnapshot;
		if (!snapshot || !this.isRequestSnapshotCurrent(snapshot)) {
			this.clearContextReview();
			this.error = undefined;
			this.notice = 'Messenger context is unavailable. Refresh context and try again.';
			this.broadcastState();
			return;
		}

		this.clearContextReview();
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
				contextSource,
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

	private async handleContextCapture(value: Extract<AiAssistMessengerEvent, {type: 'context-capture'}>): Promise<void> {
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
			this.clearContextReview();
			this.error = undefined;
			this.notice = 'Messenger context was unavailable or ambiguous. Nothing was sent. Select Refresh context to retry.';
			this.broadcastState();
			pending.resolve();
			return;
		}

		const reviewedItems = value.items.map((item, index) => ({id: `${value.requestId}:${index}`, item}));
		this.review = {
			browsingMode: config.get('aiAssistWebSearchMode'),
			contextSource: pending.contextSource,
			editable: true,
			...createUnlockedContextReview({
				contextVersion: value.contextVersion,
				items: reviewedItems,
				question: pending.question,
				requestedCount: pending.requestedCount,
				snapshot: pending.snapshot,
				transcripts: createReviewedTranscriptItems(
					reviewedItems,
					messageId => this.mediaCandidates.find(candidate => candidate.messageId === messageId)?.durationSeconds,
				),
			}),
			sequence: ++this.reviewSequence,
		};
		this.error = undefined;
		const hasImages = value.items.some(item => item.attachments?.some(attachment => attachment.kind === 'image'));
		this.notice = hasImages
			? `${value.items.length} of ${pending.requestedCount} messages available for review. Preparing processed image previews locally…`
			: `${value.items.length} of ${pending.requestedCount} messages available for review. Nothing has left Messenger.`;
		this.broadcastState();
		pending.resolve();
		if (hasImages) {
			await this.populateReviewedImages({
				...(pending.anchorMessageId ? {anchorMessageId: pending.anchorMessageId} : {}),
				idPrefix: value.requestId,
				items: value.items,
				reviewSequence: this.review.sequence,
				snapshot: pending.snapshot,
			});
		}
	}

	private async populateReviewedImages(input: Readonly<{
		anchorMessageId?: string;
		idPrefix: string;
		items: ReadonlyArray<Readonly<ConversationContextItem>>;
		reviewSequence: number;
		snapshot: Readonly<ConversationSnapshot>;
	}>): Promise<void> {
		const {anchorMessageId, idPrefix, items, reviewSequence, snapshot} = input;
		this.reviewedImageCapture?.abortController.abort();
		const capture = {
			abortController: new AbortController(),
			reviewSequence,
			snapshot,
		};
		this.reviewedImageCapture = capture;
		this.broadcastState();
		const reviewedImages = await createReviewedImageItems({
			...(anchorMessageId ? {anchorMessageId} : {}),
			contextItems: items,
			idPrefix,
			pipeline: {
				capture: async (messageId, candidateSnapshot, signal) => this.imageCaptures.capture(
					messageId,
					candidateSnapshot,
					signal,
				),
				normalize: async (captureHandleId, messageId, candidateSnapshot, signal) => this.processedImages.normalize(
					captureHandleId,
					messageId,
					candidateSnapshot,
					signal,
				),
				releaseProcessed: handleId => {
					this.processedImages.releaseHandle(handleId);
				},
				withPreview: async (handleId, messageId, candidateSnapshot, callback) => this.processedImages.withProcessedImagePreview(
					handleId,
					messageId,
					candidateSnapshot,
					callback,
				),
			},
			signal: capture.abortController.signal,
			snapshot,
		});
		if (
			this.reviewedImageCapture !== capture
			|| capture.abortController.signal.aborted
			|| !this.review
			|| this.review.locked
			|| this.review.sequence !== reviewSequence
			|| !this.isRequestSnapshotCurrent(snapshot)
		) {
			releaseReviewedImageHandles(reviewedImages, handleId => {
				this.processedImages.releaseHandle(handleId);
			}, 'all');
			if (this.reviewedImageCapture === capture) {
				this.reviewedImageCapture = undefined;
				this.broadcastState();
			}

			return;
		}

		this.review = {
			...this.review,
			snapshot: updateContextReview(this.review.snapshot, {images: [...reviewedImages]}),
		};
		this.reviewedImageCapture = undefined;
		this.notice = `${this.review.snapshot.actualCount} messages and ${reviewedImages.length} image result${reviewedImages.length === 1 ? '' : 's'} are available for review. Nothing has left Messenger.`;
		this.broadcastState();
	}

	private async resolveImageTarget(
		messageId: string,
		signal: AbortSignal,
	): Promise<MessengerImageCaptureTargetResolution> {
		const snapshot = this.conversationBinding.currentSnapshot;
		if (!snapshot || !this.isRequestSnapshotCurrent(snapshot)) {
			return {reason: 'conversation-changed', status: 'unavailable'};
		}

		const requestId = `image-target-request-${++this.imageTargetRequestCounter}`;
		return new Promise(resolvePromise => {
			let settled = false;
			const finish = (result: MessengerImageCaptureTargetResolution): void => {
				if (settled) {
					return;
				}

				settled = true;
				clearTimeout(timeout);
				signal.removeEventListener('abort', abort);
				this.pendingImageTargetRequests.delete(requestId);
				resolvePromise(result);
			};

			const abort = (): void => {
				finish({reason: 'aborted', status: 'unavailable'});
			};

			const timeout = setTimeout(() => {
				finish({reason: 'missing-target', status: 'unavailable'});
			}, 1500);

			this.pendingImageTargetRequests.set(requestId, {
				conversationId: snapshot.conversationId,
				messageId,
				resolve: finish,
			});
			signal.addEventListener('abort', abort, {once: true});
			if (signal.aborted) {
				abort();
				return;
			}

			this.notifyMessenger({
				conversationId: snapshot.conversationId,
				messageId,
				requestId,
				type: 'resolve-image-target',
			});
		});
	}

	private handleImageTargetResolution(
		value: Extract<AiAssistMessengerEvent, {type: 'image-target-resolution'}>,
	): void {
		const pending = this.pendingImageTargetRequests.get(value.requestId);
		if (!pending) {
			return;
		}

		if (
			value.status === 'available'
			&& (value.conversationId !== pending.conversationId || value.messageId !== pending.messageId)
		) {
			pending.resolve({reason: 'replaced-target', status: 'unavailable'});
			return;
		}

		pending.resolve(value);
	}

	private removeContextItem(reviewSequence: number, itemId: string): void {
		if (
			!this.review
			|| !this.review.editable
			|| this.review.locked
			|| this.review.sequence !== reviewSequence
			|| this.sessionState.snapshot.status === 'requesting'
			|| !this.isRequestSnapshotCurrent(this.review.snapshot.snapshot)
		) {
			return;
		}

		const transcriptIds = this.review.snapshot.transcripts
			.filter(item => item.contextItemId === itemId)
			.map(item => item.id);
		for (const transcriptId of transcriptIds) {
			this.releaseTranscriptResources(reviewSequence, transcriptId);
		}

		const snapshot = removeContextReviewItem(this.review.snapshot, itemId);
		if (!snapshot) {
			return;
		}

		this.review = {
			...this.review,
			locked: false,
			snapshot,
		};
		this.notice = 'Context item removed from this request.';
		this.broadcastState();
	}

	private editContextItem(reviewSequence: number, itemId: string, editedExcerpt: string): void {
		if (
			!this.review
			|| !this.review.editable
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
			...this.review,
			locked: false,
			snapshot,
		};
		this.notice = 'Edited excerpt saved for this request.';
		this.broadcastState();
	}

	private updateReviewedImage(
		reviewSequence: number,
		itemId: string,
		processedHandleId: string,
		type: 'include' | 'remove',
	): void {
		if (
			!this.review
			|| !this.review.editable
			|| this.review.locked
			|| this.review.sequence !== reviewSequence
			|| this.sessionState.snapshot.status === 'requesting'
			|| !this.isRequestSnapshotCurrent(this.review.snapshot.snapshot)
		) {
			return;
		}

		const update = updateReviewedImageSelection(this.review.snapshot.images, {
			itemId,
			processedHandleId,
			type,
		});
		if (!update.accepted) {
			this.notice = update.notice;
			this.broadcastState();
			return;
		}

		this.review = {
			...this.review,
			locked: false,
			snapshot: updateContextReview(this.review.snapshot, {images: [...update.items]}),
		};
		if (update.releasedHandleId) {
			this.processedImages.releaseHandle(update.releasedHandleId);
		}

		this.notice = type === 'include'
			? 'Image included in this reviewed request.'
			: 'Image removed from this reviewed request; its temporary bytes were released.';
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

	private async resolveMedia(
		messageId: string,
		kind: MediaKind,
		candidateOverride?: Readonly<MessengerMediaCandidate>,
	): Promise<void> {
		await this.mediaCleanupReady;
		const snapshot = this.conversationBinding.currentSnapshot;
		const candidate = candidateOverride
			?? this.mediaCandidates.find(item => item.messageId === messageId && item.kind === kind);
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

	private updateTranscriptState(
		reviewSequence: number,
		transcriptId: string,
		update: Parameters<typeof updateReviewedTranscript>[2],
	): boolean {
		if (!this.review
			|| this.review.sequence !== reviewSequence
			|| this.review.locked
			|| !this.review.editable
			|| !this.isRequestSnapshotCurrent(this.review.snapshot.snapshot)) {
			return false;
		}

		const transcripts = updateReviewedTranscript(this.review.snapshot.transcripts, transcriptId, update);
		if (!transcripts) {
			return false;
		}

		this.review = {
			...this.review,
			snapshot: updateContextReview(this.review.snapshot, {transcripts}),
		};
		return true;
	}

	private async prepareTranscript(reviewSequence: number, transcriptId: string): Promise<void> {
		if (this.pendingTranscription) {
			return;
		}

		const transcript = this.review?.sequence === reviewSequence
			? this.review.snapshot.transcripts.find(item => item.id === transcriptId)
			: undefined;
		if (!transcript || !['available', 'canceled', 'failed', 'removed', 'timed-out'].includes(transcript.status)) {
			return;
		}

		this.transcriptHandles.clear();
		if (this.review) {
			const transcripts = this.review.snapshot.transcripts.map(item => item.status === 'ready'
				? {...item, status: 'available' as const}
				: item);
			this.review = {...this.review, snapshot: updateContextReview(this.review.snapshot, {transcripts})};
		}

		if (!this.updateTranscriptState(reviewSequence, transcriptId, item => ({...item, notice: undefined, status: 'preparing'}))) {
			return;
		}

		this.broadcastState();
		await this.resolveMedia(transcript.messageId, transcript.kind, {
			...(transcript.durationSeconds === undefined ? {} : {durationSeconds: transcript.durationSeconds}),
			kind: transcript.kind,
			messageId: transcript.messageId,
		});
		if (this.review?.sequence !== reviewSequence || !this.isRequestSnapshotCurrent(this.review.snapshot.snapshot)) {
			await this.mediaResolver.releaseAll();
			this.mediaResolution = undefined;
			return;
		}

		const resolution = this.mediaResolution;
		if (!resolution || resolution.messageId !== transcript.messageId || resolution.kind !== transcript.kind || resolution.status !== 'ready') {
			const status = resolution?.status === 'unsupported' ? 'unsupported' : 'failed';
			this.updateTranscriptState(reviewSequence, transcriptId, item => ({
				...item,
				notice: status === 'unsupported'
					? `This ${transcript.kind === 'video' ? 'video' : 'voice message'} cannot be resolved as supported media.`
					: 'Media bytes were unavailable. Text-only context remains available.',
				status,
			}));
			this.broadcastState();
			return;
		}

		try {
			const localMetadata = await this.mediaResolver.inspectFile(
				resolution.handleId!,
				resolution.messageId,
				this.review.snapshot.snapshot,
				async filePath => transcript.kind === 'audio'
					? {audioTrackAvailable: true, durationSeconds: await inspectAudioDuration(filePath)}
					: this.videoMetadataInspector.inspect(filePath),
			);
			if (!localMetadata.audioTrackAvailable) {
				this.updateTranscriptState(reviewSequence, transcriptId, item => ({
					...item,
					byteLength: resolution.byteLength,
					durationSeconds: localMetadata.durationSeconds,
					mimeType: resolution.mimeType,
					notice: 'No audio track. The video remains available for visual processing.',
					status: 'no-audio',
				}));
				if (transcript.kind === 'video') {
					await this.prepareVideoArtifact(
						transcriptId,
						resolution.handleId!,
						transcript.messageId,
						reviewSequence,
						this.review.snapshot.snapshot,
						{status: 'no-audio'},
					).catch(async () => {
						await this.mediaResolver.releaseHandle(resolution.handleId!).catch(() => undefined);
					});
				} else {
					await this.mediaResolver.releaseHandle(resolution.handleId!);
				}

				this.mediaResolution = undefined;
				this.broadcastState();
				return;
			}

			const {durationSeconds} = localMetadata;
			if (!this.updateTranscriptState(reviewSequence, transcriptId, item => ({
				...item,
				byteLength: resolution.byteLength,
				durationSeconds,
				mimeType: resolution.mimeType,
				notice: undefined,
				status: 'ready',
			}))) {
				await this.mediaResolver.releaseHandle(resolution.handleId!);
				return;
			}

			this.transcriptHandles.set(transcriptId, {
				handleId: resolution.handleId!,
				messageId: transcript.messageId,
				reviewSequence,
				snapshot: this.review.snapshot.snapshot,
			});
		} catch (error) {
			this.updateTranscriptState(reviewSequence, transcriptId, item => transcriptFailure(item, error));
			await this.mediaResolver.releaseAll();
		}

		this.broadcastState();
	}

	private async transcribeReviewedMedia(reviewSequence: number, transcriptId: string): Promise<void> {
		const handle = this.transcriptHandles.get(transcriptId);
		const transcript = this.review?.sequence === reviewSequence
			? this.review.snapshot.transcripts.find(item => item.id === transcriptId)
			: undefined;
		if (!handle
			|| handle.reviewSequence !== reviewSequence
			|| !transcript
			|| transcript.status !== 'ready'
			|| this.pendingTranscription) {
			return;
		}

		const pending = {
			abortController: new AbortController(),
			reviewSequence,
			transcriptId,
		};
		this.pendingTranscription = pending;
		this.updateTranscriptState(reviewSequence, transcriptId, item => ({
			...item,
			notice: undefined,
			status: item.kind === 'video' ? 'extracting' : 'transcribing',
		}));
		this.broadcastState();

		try {
			const [result] = await this.mediaTranscriptionService.transcribeBatch(() => this.readApiKey(), {
				consent: 'transcribe-and-review',
				items: [{handleId: handle.handleId, messageId: handle.messageId}],
				snapshot: handle.snapshot,
			}, pending.abortController.signal, phase => {
				if (this.pendingTranscription !== pending) {
					return;
				}

				this.updateTranscriptState(reviewSequence, transcriptId, item => ({
					...item,
					status: phase === 'extracting-audio' ? 'extracting' : 'transcribing',
				}));
				this.broadcastState();
			});
			if (this.pendingTranscription !== pending) {
				return;
			}

			if ('status' in result) {
				this.updateTranscriptState(reviewSequence, transcriptId, item => ({
					...item,
					byteLength: result.source.byteLength,
					durationSeconds: result.source.durationSeconds,
					mimeType: result.source.mimeType,
					notice: 'No audio track. The video remains available for visual processing.',
					status: 'no-audio',
				}));
			} else {
				this.updateTranscriptState(reviewSequence, transcriptId, item => completeReviewedTranscript(item, {
					byteLength: result.source.byteLength,
					durationSeconds: result.source.durationSeconds,
					mimeType: result.source.mimeType,
					segments: result.segments,
				}));
				if (transcript.kind === 'video') {
					await this.prepareVideoArtifact(
						transcriptId,
						handle.handleId,
						handle.messageId,
						reviewSequence,
						handle.snapshot,
						{segments: result.segments, status: 'completed'},
						pending.abortController.signal,
					).catch(() => undefined);
				}
			}
		} catch (error) {
			if (this.pendingTranscription === pending) {
				this.updateTranscriptState(reviewSequence, transcriptId, item => transcriptFailure(item, error));
			}
		} finally {
			if (this.videoArtifacts.get(transcriptId)?.handleId !== handle.handleId) {
				await this.mediaResolver.releaseHandle(handle.handleId).catch(() => undefined);
			}

			this.transcriptHandles.delete(transcriptId);
			if (this.pendingTranscription === pending) {
				this.pendingTranscription = undefined;
				this.mediaResolution = undefined;
				this.broadcastState();
			}
		}
	}

	private async prepareVideoArtifact(
		transcriptId: string,
		handleId: string,
		messageId: string,
		reviewSequence: number,
		snapshot: Readonly<ConversationSnapshot>,
		transcript: Readonly<VideoTranscriptState>,
		signal?: AbortSignal,
	): Promise<void> {
		this.videoAnalysis = {
			frameCount: 0,
			phase: 'preprocessing',
			status: 'analyzing',
			transcriptAvailable: transcript.status === 'completed',
		};
		this.broadcastState();
		try {
			const artifact = await this.mediaResolver.inspectFile(
				handleId,
				messageId,
				snapshot,
				async filePath => {
					const metadata = await this.videoMetadataInspector.inspect(filePath, {signal});
					return this.videoFramePreprocessor.preprocess(filePath, {
						metadata,
						sourceMessageId: messageId,
						transcript,
					}, {
						isCurrent: () => this.review?.sequence === reviewSequence && this.isRequestSnapshotCurrent(snapshot),
						onProgress: progress => {
							this.videoAnalysis = {
								frameCount: progress.completed,
								phase: 'preprocessing',
								status: 'analyzing',
								transcriptAvailable: transcript.status === 'completed',
							};
							this.broadcastState();
						},
						signal,
					});
				},
			);
			this.videoArtifacts.set(transcriptId, {artifact, handleId, snapshot});
			this.videoAnalysis = {
				coverage: artifact.coverage,
				frameCount: artifact.frameCount,
				phase: 'preprocessing',
				status: 'ready',
				transcriptAvailable: transcript.status === 'completed',
			};
		} catch (error) {
			this.videoAnalysis = {
				frameCount: 0,
				phase: 'preprocessing',
				status: 'failed',
				transcriptAvailable: transcript.status === 'completed',
			};
			throw error;
		} finally {
			this.broadcastState();
		}
	}

	private editTranscript(reviewSequence: number, transcriptId: string, texts: readonly string[]): void {
		if (this.updateTranscriptState(reviewSequence, transcriptId, item => editReviewedTranscript(item, texts) ?? item)) {
			this.broadcastState();
		}
	}

	private removeTranscript(reviewSequence: number, transcriptId: string): void {
		this.releaseTranscriptResources(reviewSequence, transcriptId);

		if (this.updateTranscriptState(reviewSequence, transcriptId, item => removeReviewedTranscript(item))) {
			this.broadcastState();
		}
	}

	private releaseTranscriptResources(reviewSequence: number, transcriptId: string): void {
		if (this.pendingTranscription?.reviewSequence === reviewSequence && this.pendingTranscription.transcriptId === transcriptId) {
			this.pendingTranscription.abortController.abort();
			this.pendingTranscription = undefined;
		}

		const handle = this.transcriptHandles.get(transcriptId);
		if (handle?.reviewSequence === reviewSequence) {
			this.transcriptHandles.delete(transcriptId);
			void this.mediaResolver.releaseHandle(handle.handleId);
			if (this.mediaResolution?.handleId === handle.handleId) {
				this.mediaResolution = undefined;
			}
		}

		const videoArtifact = this.videoArtifacts.get(transcriptId);
		if (videoArtifact) {
			this.videoArtifacts.delete(transcriptId);
			if (videoArtifact.handleId !== handle?.handleId) {
				void this.mediaResolver.releaseHandle(videoArtifact.handleId);
			}

			this.videoAnalysis = undefined;
		}
	}

	private cancelTranscription(reviewSequence?: number, transcriptId?: string): void {
		const pending = this.pendingTranscription;
		if (!pending
			|| (reviewSequence !== undefined && pending.reviewSequence !== reviewSequence)
			|| (transcriptId !== undefined && pending.transcriptId !== transcriptId)) {
			return;
		}

		pending.abortController.abort();
		this.updateTranscriptState(pending.reviewSequence, pending.transcriptId, item => ({
			...item,
			notice: 'Transcription cancelled. Text-only context remains available.',
			status: 'canceled',
		}));
		this.broadcastState();
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
		if (result.status === 'inserted' && this.currentHistoryInteractionId) {
			try {
				this.historyStore?.updateShareStatus(this.currentHistoryInteractionId, {
					draftStatus: 'inserted',
					shareStatus: 'private',
				});
			} catch {
				this.notice = 'Answer inserted into the Messenger draft, but Caprine could not update its local history status.';
			}
		}

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
		if (this.review?.snapshot.transcripts.some(item => ['preparing', 'extracting', 'transcribing'].includes(item.status))) {
			this.notice = 'Wait for media preparation or transcription to finish before Ask.';
			this.broadcastState();
			return;
		}

		if (this.reviewedImageCapture) {
			this.notice = 'Wait for processed image previews to finish before Ask.';
			this.broadcastState();
			return;
		}

		if (!this.review) {
			await this.requestContextReview(question, this.anchor?.snapshot.item.messageId);
			return;
		}

		const submittedQuestion = this.review.contextSource === 'historical-original'
			? this.review.snapshot.question
			: question;

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

		const imageSelection = reviewedImageSelectionSummary(this.review.snapshot.images);
		if (imageSelection.blockingNotice) {
			this.error = {
				code: 'input-too-large',
				message: imageSelection.blockingNotice,
			};
			this.broadcastState();
			return;
		}

		this.review = {
			...this.review,
			locked: false,
			sequence: ++this.reviewSequence,
			snapshot: updateContextReview(this.review.snapshot, {question: submittedQuestion}),
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

		const finalizedImages = finalizeReviewedImageSelection(this.review.snapshot.images);
		for (const handleId of finalizedImages.releasedHandleIds) {
			this.processedImages.releaseHandle(handleId);
		}

		this.review = {
			...this.review,
			locked: true,
			snapshot: updateContextReview(this.review.snapshot, {images: [...finalizedImages.items]}),
		};
		this.broadcastState();

		const lockedReview = this.review;
		const selectedVideoTranscript = lockedReview.snapshot.transcripts.find(item =>
			item.kind === 'video' && ['completed', 'no-audio'].includes(item.status));
		const selectedVideoArtifact = selectedVideoTranscript
			? this.videoArtifacts.get(selectedVideoTranscript.id)
			: undefined;
		try {
			await this.runOpenAiRequest(
				prompt,
				{
					isConnectionTest: false,
					reviewedImages: lockedReview.snapshot.images,
					reviewSnapshot: lockedReview.snapshot.snapshot,
					searchMode: lockedReview.browsingMode,
					...(selectedVideoArtifact ? {videoArtifact: selectedVideoArtifact} : {}),
				},
			);
		} finally {
			releaseReviewedImageHandles(
				lockedReview.snapshot.images,
				handleId => {
					this.processedImages.releaseHandle(handleId);
				},
				'all',
			);
		}
	}

	private async runOpenAiRequest(
		prompt: string,
		options: Readonly<OpenAiRequestRunOptions>,
	): Promise<void> {
		const reviewedImages = options.reviewedImages ?? [];
		const searchMode = options.isConnectionTest ? 'off' : (options.searchMode ?? config.get('aiAssistWebSearchMode'));
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
			historyChatId: captureHistoryDestinationChatId(this.historyChat, conversationSnapshot),
			id: ++this.requestCounter,
			requestedAt: Date.now(),
			snapshot: conversationSnapshot,
		};
		this.activeRequest = request;
		this.notice = options.isConnectionTest ? 'Testing the saved OpenAI API key…' : undefined;
		this.sessionState.beginRequest();
		this.broadcastState();

		try {
			let answer: OpenAiAnswer;
			if (options.isConnectionTest) {
				answer = await this.openAiClient.createResponse(apiKey, prompt, searchMode, request.abortController.signal);
			} else if (options.videoArtifact) {
				answer = await withSelectedReviewedImageInputs({
					items: reviewedImages,
					run: async images => {
						const result = await new VideoUnderstandingService(
							new OpenAiVideoUnderstandingProvider(this.openAiClient),
							{
								extract: async (intervals, signal) => {
									const {sourceMessageId} = options.videoArtifact!.artifact.frameTimeline[0];
									return this.mediaResolver.inspectFile(
										options.videoArtifact!.handleId,
										sourceMessageId,
										request.snapshot,
										async filePath => this.videoFramePreprocessor.extractFocusedFrames(
											filePath,
											sourceMessageId,
											options.videoArtifact!.artifact.metadata.durationSeconds,
											intervals,
											{
												isCurrent: () => this.activeRequest?.id === request.id && this.isRequestSnapshotCurrent(request.snapshot),
												signal,
											},
										),
									);
								},
							},
						).analyze({
							apiKey,
							artifact: options.videoArtifact!.artifact,
							question: prompt,
							reviewedImages: images,
							webSearchMode: searchMode,
						}, {
							isCurrent: () => this.activeRequest?.id === request.id && this.isRequestSnapshotCurrent(request.snapshot),
							onProgress: progress => {
								this.updateVideoAnalysisProgress(progress);
								this.broadcastState();
							},
							signal: request.abortController.signal,
						});
						return result.answer;
					},
					snapshot: options.reviewSnapshot ?? request.snapshot,
					store: this.processedImages,
				});
			} else {
				answer = await withSelectedReviewedImageInputs({
					items: reviewedImages,
					run: async images => this.openAiClient.createResponse(
						apiKey,
						prompt,
						searchMode,
						{images, signal: request.abortController.signal},
					),
					snapshot: options.reviewSnapshot ?? request.snapshot,
					store: this.processedImages,
				});
			}

			if (this.activeRequest?.id !== request.id) {
				return;
			}

			if (options.videoArtifact && this.videoAnalysis) {
				this.videoAnalysis = {...this.videoAnalysis, status: 'ready'};
			}

			if (!this.isRequestSnapshotCurrent(request.snapshot)) {
				this.clearConversationBoundRequestState();
				this.broadcastState();
				return;
			}

			if (options.isConnectionTest) {
				this.error = undefined;
				this.notice = 'OpenAI API key works.';
			} else {
				const historyInteractionId = this.persistCompletedInteraction(
					answer,
					request.historyChatId,
					request.requestedAt,
					request.snapshot,
				);
				if (!this.answer.store(
					answer,
					request.snapshot,
					this.conversationBinding.currentSnapshot,
				)) {
					this.clearConversationBoundRequestState();
					this.broadcastState();
					return;
				}

				this.currentHistoryInteractionId = historyInteractionId;

				this.draftInsertionAuthorization.issue({
					answerGeneration: ++this.answerGeneration,
					authorizationToken: `draft-insertion-token:${randomUUID()}`,
					conversationId: request.snapshot.conversationId,
					snapshot: request.snapshot,
					text: answer.text,
				});
				if (options.videoArtifact
					&& !reviewedImages.some(image => image.status === 'selected')
					&& this.review
					&& this.isRequestSnapshotCurrent(this.review.snapshot.snapshot)) {
					this.review = {...this.review, editable: false, locked: false};
				}

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

			if (options.videoArtifact && this.videoAnalysis) {
				this.videoAnalysis = {
					...this.videoAnalysis,
					status: error instanceof OpenAiRequestError && error.code === 'cancelled' ? 'canceled' : 'failed',
				};
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

	private updateVideoAnalysisProgress(progress: Readonly<VideoUnderstandingProgress>): void {
		const broadFrameCount = progress.phase === 'pass-1'
			? progress.frameCount
			: (this.videoAnalysis?.frameCount ?? progress.frameCount);
		this.videoAnalysis = {
			coverage: progress.coverage,
			...(progress.phase === 'pass-2' ? {focusedFrameCount: progress.frameCount} : {}),
			frameCount: broadFrameCount,
			phase: progress.phase,
			status: 'analyzing',
			transcriptAvailable: progress.transcriptAvailable,
		};
	}

	private canStartRequestForSnapshot(
		snapshot: Readonly<ConversationSnapshot> | undefined,
	): snapshot is Readonly<ConversationSnapshot> {
		return snapshot !== undefined
			&& this.sessionState.snapshot.status !== 'closed'
			&& this.sessionState.snapshot.status !== 'invalidated'
			&& this.isRequestSnapshotCurrent(snapshot);
	}

	private persistCompletedInteraction(
		answer: OpenAiAnswer,
		historyChatId: string | undefined,
		requestedAt: number,
		snapshot: Readonly<ConversationSnapshot>,
	): string {
		const review = this.review?.snapshot;
		if (!review || review.question.length === 0 || !this.historyStore) {
			throw new OpenAiRequestError('provider-unavailable', 'Caprine could not preserve the reviewed context. Nothing was shown.');
		}

		try {
			const input: AiHistoryInteractionInput = {
				answer: answer.text,
				browsingMode: answer.webSearch.mode,
				completedAt: Date.now(),
				context: structuredClone({
					actualCount: review.actualCount,
					contextVersion: review.contextVersion,
					items: review.items,
					question: review.question,
					requestedCount: review.requestedCount,
				}),
				model: openAiResponseModel,
				outcome: 'completed',
				provider: 'openai',
				question: review.question,
				requestedAt,
				webSearch: {
					citations: answer.webSearch.citations,
					ran: answer.webSearch.ran,
					sources: answer.webSearch.sources,
				},
			};
			if (!historyChatId) {
				const result = this.historyStore.createChatWithCompletedInteraction(
					snapshot.conversationId,
					input,
				);
				if (!captureHistoryDestinationChatId(this.historyChat, snapshot)) {
					this.historyChat = {
						chatId: result.chatId,
						conversationId: snapshot.conversationId,
						sessionId: snapshot.sessionId,
					};
					this.selectedHistoryChatId = result.chatId;
				}

				return result.interactionId;
			}

			return this.historyStore.appendCompletedInteraction(historyChatId, input);
		} catch {
			throw new OpenAiRequestError(
				'provider-unavailable',
				'OpenAI answered, but Caprine could not save the completed interaction. Nothing was shown.',
			);
		}
	}

	private async prepareHistoryReplay(
		chatId: string,
		interactionId: string,
		contextSource: 'current' | 'original',
	): Promise<void> {
		const snapshot = this.conversationBinding.currentSnapshot;
		if (
			!snapshot
			|| !this.isRequestSnapshotCurrent(snapshot)
			|| !this.historyStore
			|| this.sessionState.snapshot.status === 'requesting'
		) {
			return;
		}

		let interaction;
		try {
			interaction = this.historyStore.loadInteraction(snapshot.conversationId, chatId, interactionId);
		} catch {
			this.notice = 'That historical interaction could not be read safely. The original record was not changed.';
			this.broadcastState();
			return;
		}

		if (!interaction) {
			this.notice = 'That historical interaction is no longer available in this Messenger conversation.';
			this.broadcastState();
			return;
		}

		this.cancelPendingContextCapture();
		this.clearAnswer();
		this.error = undefined;
		this.anchor = undefined;
		this.historyChat = {chatId, conversationId: snapshot.conversationId, sessionId: snapshot.sessionId};
		this.historyConversationId = snapshot.conversationId;
		this.selectedHistoryChatId = chatId;
		this.invocation = {prompt: interaction.question, sequence: ++this.invocationSequence};

		if (contextSource === 'current') {
			this.notice = 'Capturing current Messenger context for this historical question. Review it before Ask.';
			this.broadcastState();
			await this.requestContextReview(interaction.question, undefined, 'historical-current');
			return;
		}

		const availability = originalHistoryReplayAvailability(interaction, openAiResponseModel);
		if (!availability.available) {
			this.clearContextReview();
			this.notice = availability.reason === 'missing-artifacts'
				? 'The original request used media or saved artifacts that are not available for exact replay. Choose current context instead.'
				: 'The original provider or model metadata is no longer supported for exact replay. Choose current context instead.';
			this.broadcastState();
			return;
		}

		this.clearContextReview();
		this.review = {
			browsingMode: interaction.browsingMode,
			contextSource: 'historical-original',
			editable: false,
			locked: false,
			sequence: ++this.reviewSequence,
			snapshot: restoreOriginalHistoryReview(interaction, snapshot),
		};
		this.notice = 'Original frozen context and browsing mode restored. Review them, then select Ask to create a new result.';
		this.broadcastState();
	}

	private prepareHistoryDeletion(scope: AiHistoryDeletionScope, chatId?: string): void {
		if (!this.historyStore || this.sessionState.snapshot.status === 'requesting') {
			this.notice = 'History deletion is unavailable while another AI action is active.';
			this.broadcastState();
			return;
		}

		if (scope === 'all') {
			this.historyDeletion.issue({scope}, {
				confirmLabel: 'Delete all AI history',
				message: 'Permanently delete every local Caprine AI Assist chat on this Mac. Messenger threads and messages are not deleted. This cannot be undone.',
				title: 'Delete all local AI history?',
			});
			this.broadcastState();
			return;
		}

		const snapshot = this.conversationBinding.currentSnapshot;
		if (!snapshot || !this.isRequestSnapshotCurrent(snapshot)) {
			this.notice = 'Open a reliable Messenger conversation before deleting its local AI history.';
			this.broadcastState();
			return;
		}

		const displayName = this.conversationBinding.panelState.displayName ?? 'this Messenger conversation';
		if (scope === 'conversation') {
			this.historyDeletion.issue({scope, snapshot}, {
				confirmLabel: 'Clear conversation history',
				message: `Permanently delete every local Caprine AI Assist chat for ${displayName}. Other conversations and Messenger messages are not deleted. This cannot be undone.`,
				title: 'Clear this conversation’s AI history?',
			});
			this.broadcastState();
			return;
		}

		if (!chatId) {
			return;
		}

		try {
			const chat = this.historyStore.loadChat(snapshot.conversationId, chatId, 1);
			if (!chat) {
				this.notice = 'That local AI chat is no longer available. Nothing was deleted.';
				this.broadcastState();
				return;
			}

			const chatTitle = this.historyState.chats.find(item => item.id === chatId)?.title
				?? chat.interactions[0]?.question.slice(0, 120)
				?? 'New AI chat';
			this.historyDeletion.issue({chatId, scope, snapshot}, {
				confirmLabel: 'Delete AI chat',
				message: `Permanently delete the local AI chat “${chatTitle}”. Other local AI chats and Messenger messages are not deleted. This cannot be undone.`,
				title: 'Delete this local AI chat?',
			});
		} catch {
			this.notice = 'Caprine could not safely prepare that local AI chat for deletion. Nothing was deleted.';
		}

		this.broadcastState();
	}

	private confirmHistoryDeletion(authorizationToken: string): void {
		const decision = this.historyDeletion.consume(
			authorizationToken,
			this.conversationBinding.currentSnapshot,
		);
		if (decision.status === 'rejected') {
			this.notice = 'That deletion confirmation expired or the Messenger conversation changed. Nothing was deleted.';
			this.broadcastState();
			return;
		}

		if (!this.historyStore) {
			this.notice = 'Local AI history is unavailable. Nothing was deleted.';
			this.broadcastState();
			return;
		}

		try {
			const {target} = decision;
			let deletedCount: number;
			if (target.scope === 'all') {
				deletedCount = this.historyStore.clearAll();
			} else if (target.scope === 'conversation') {
				deletedCount = this.historyStore.clearConversation(target.snapshot.conversationId);
			} else {
				deletedCount = Number(this.historyStore.deleteChat(target.snapshot.conversationId, target.chatId));
			}

			if (deletedCount === 0) {
				this.notice = 'That local AI history was already absent. Nothing else was deleted.';
				this.broadcastState();
				return;
			}

			this.clearDeletedHistoryReferences(target);
			if (target.scope === 'all') {
				this.notice = 'Cleared all local AI history and reusable transcripts from this Mac. Messenger messages were not changed.';
			} else if (target.scope === 'conversation') {
				this.notice = `Cleared ${deletedCount} local AI ${deletedCount === 1 ? 'chat' : 'chats'} for the confirmed Messenger conversation. Messenger messages were not changed.`;
			} else {
				this.notice = 'Deleted the selected local AI chat. Other local AI chats and Messenger messages were not changed.';
			}
		} catch {
			this.notice = 'Caprine could not delete that local AI history. Nothing else was deleted.';
		}

		this.broadcastState();
	}

	private clearDeletedHistoryReferences(target: Readonly<AiHistoryDeletionTarget>): void {
		if (target.scope !== 'all' && target.snapshot.conversationId !== this.historyConversationId) {
			return;
		}

		const deletesCurrentChat = target.scope !== 'chat'
			|| target.chatId === this.selectedHistoryChatId;
		if (deletesCurrentChat) {
			this.selectedHistoryChatId = undefined;
		}

		const deletesRequestDestination = target.scope !== 'chat'
			|| target.chatId === this.historyChat?.chatId;
		if (deletesRequestDestination) {
			this.historyChat = undefined;
			this.currentHistoryInteractionId = undefined;
		}

		if (target.scope !== 'chat') {
			this.historyQuery = '';
		}
	}

	private createHistoryChat(): void {
		const snapshot = this.conversationBinding.currentSnapshot;
		if (!snapshot || !this.historyStore) {
			return;
		}

		try {
			const chatId = this.historyStore.createChat(snapshot.conversationId);
			this.historyChat = {chatId, conversationId: snapshot.conversationId, sessionId: snapshot.sessionId};
			this.historyConversationId = snapshot.conversationId;
			this.historyQuery = '';
			this.selectedHistoryChatId = chatId;
			this.notice = 'New local AI chat created.';
			this.broadcastState();
		} catch {
			this.notice = 'Caprine could not create a new local AI chat.';
			this.broadcastState();
		}
	}

	private selectHistoryChat(chatId: string): void {
		const snapshot = this.conversationBinding.currentSnapshot;
		if (!snapshot || !this.historyStore) {
			return;
		}

		try {
			if (!this.historyStore.loadChat(snapshot.conversationId, chatId, 1)) {
				return;
			}

			this.selectedHistoryChatId = chatId;
			this.historyChat = {chatId, conversationId: snapshot.conversationId, sessionId: snapshot.sessionId};
			this.broadcastState();
		} catch {
			this.notice = 'Caprine could not open that local AI chat.';
			this.broadcastState();
		}
	}

	private resetHistoryWorkspace(): void {
		this.historyConversationId = undefined;
		this.historyQuery = '';
		this.selectedHistoryChatId = undefined;
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
		this.clearContextReview();
		this.historyDeletion.invalidate();
		this.notice = undefined;
	}

	private clearContextReview(): void {
		this.pendingTranscription?.abortController.abort();
		this.pendingTranscription = undefined;
		this.transcriptHandles.clear();
		this.videoArtifacts.clear();
		this.videoAnalysis = undefined;
		this.cancelMediaResolution();
		this.reviewedImageCapture?.abortController.abort();
		this.reviewedImageCapture = undefined;
		if (this.review) {
			releaseReviewedImageHandles(
				this.review.snapshot.images,
				handleId => {
					this.processedImages.releaseHandle(handleId);
				},
				'all',
			);
		}

		this.processedImages.releaseAll();
		this.imageCaptures.releaseAll();
		this.review = undefined;
	}

	private clearMediaState(): void {
		this.pendingTranscription?.abortController.abort();
		this.pendingTranscription = undefined;
		this.transcriptHandles.clear();
		this.videoArtifacts.clear();
		this.videoAnalysis = undefined;
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
		this.currentHistoryInteractionId = undefined;
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
