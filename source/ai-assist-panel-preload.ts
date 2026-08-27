import {contextBridge, ipcRenderer} from 'electron';
import {
	aiAssistIpcChannels,
	AiAssistPanelCommand,
	AiAssistPanelState,
	isAiAssistPanelState,
} from './ai-assist-ipc';

const sendCommand = async (command: AiAssistPanelCommand): Promise<AiAssistPanelState> => {
	const state: unknown = await ipcRenderer.invoke(aiAssistIpcChannels.panelCommand, command);
	if (!isAiAssistPanelState(state)) {
		throw new TypeError('Invalid AI Assist state received from main process');
	}

	return state;
};

contextBridge.exposeInMainWorld('caprineAiAssist', {
	cancel: async () => sendCommand({type: 'cancel'}),
	cancelTranscription: async (reviewSequence: number, transcriptId: string) => sendCommand({reviewSequence, transcriptId, type: 'cancel-transcription'}),
	cancelHistoryDeletion: async (authorizationToken: string) => sendCommand({authorizationToken, type: 'cancel-history-deletion'}),
	close: async () => sendCommand({type: 'close'}),
	confirmHistoryDeletion: async (authorizationToken: string) => sendCommand({authorizationToken, type: 'confirm-history-deletion'}),
	copyDiagnostics: async (copySequence: number) => sendCommand({copySequence, type: 'copy-diagnostics'}),
	deleteApiKey: async () => sendCommand({type: 'delete-api-key'}),
	editContextItem: async (reviewSequence: number, itemId: string, editedExcerpt: string) => sendCommand({
		editedExcerpt,
		itemId,
		reviewSequence,
		type: 'edit-context-item',
	}),
	editTranscript: async (reviewSequence: number, transcriptId: string, texts: string[]) => sendCommand({
		reviewSequence,
		texts,
		transcriptId,
		type: 'edit-transcript',
	}),
	getState: async () => sendCommand({type: 'get-state'}),
	includeReviewedImage: async (reviewSequence: number, itemId: string, processedHandleId: string) => sendCommand({
		itemId,
		processedHandleId,
		reviewSequence,
		type: 'include-reviewed-image',
	}),
	insertAnswer: async (answerGeneration: number, authorizationToken: string, conversationId: string) => sendCommand({
		answerGeneration,
		authorizationToken,
		conversationId,
		type: 'insert-answer',
	}),
	newHistoryChat: async () => sendCommand({type: 'new-history-chat'}),
	openCitation: async (url: string) => sendCommand({type: 'open-citation', url}),
	prepareHistoryReplay: async (chatId: string, interactionId: string, contextSource: 'current' | 'original') => sendCommand({
		chatId,
		contextSource,
		interactionId,
		type: 'prepare-history-replay',
	}),
	prepareHistoryDeletion: async (scope: 'all' | 'chat' | 'conversation', chatId?: string) => sendCommand({
		...(chatId ? {chatId} : {}),
		scope,
		type: 'prepare-history-deletion',
	}),
	prepareTranscript: async (reviewSequence: number, transcriptId: string) => sendCommand({reviewSequence, transcriptId, type: 'prepare-transcript'}),
	refreshContext: async () => sendCommand({type: 'refresh-context'}),
	refreshConversation: async () => sendCommand({type: 'refresh-conversation'}),
	removeContextItem: async (reviewSequence: number, itemId: string) => sendCommand({itemId, reviewSequence, type: 'remove-context-item'}),
	removeReviewedImage: async (reviewSequence: number, itemId: string, processedHandleId: string) => sendCommand({
		itemId,
		processedHandleId,
		reviewSequence,
		type: 'remove-reviewed-image',
	}),
	removeTranscript: async (reviewSequence: number, transcriptId: string) => sendCommand({reviewSequence, transcriptId, type: 'remove-transcript'}),
	resolveMedia: async (messageId: string, kind: 'audio' | 'video') => sendCommand({type: 'resolve-media', kind, messageId}),
	saveApiKey: async (apiKey: string) => sendCommand({type: 'save-api-key', apiKey}),
	searchHistory: async (query: string) => sendCommand({query, type: 'search-history'}),
	selectHistoryChat: async (chatId: string) => sendCommand({chatId, type: 'select-history-chat'}),
	setContextWindow: async (requestedCount: 10 | 20 | 50) => sendCommand({requestedCount, type: 'set-context-window'}),
	setWebSearchMode: async (mode: 'always' | 'auto' | 'off') => sendCommand({mode, type: 'set-web-search-mode'}),
	submitPrompt: async (prompt: string) => sendCommand({type: 'submit-prompt', prompt}),
	testApiKey: async () => sendCommand({type: 'test-api-key'}),
	transcribeReviewedMedia: async (reviewSequence: number, transcriptId: string) => sendCommand({reviewSequence, transcriptId, type: 'transcribe-reviewed-media'}),
	onStateChanged(callback: (state: AiAssistPanelState) => void) {
		const listener = (_event: Electron.IpcRendererEvent, state: AiAssistPanelState): void => {
			if (isAiAssistPanelState(state)) {
				callback(state);
			}
		};

		ipcRenderer.on(aiAssistIpcChannels.panelStateChanged, listener);
		return () => {
			ipcRenderer.off(aiAssistIpcChannels.panelStateChanged, listener);
		};
	},
});
