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
	close: async () => sendCommand({type: 'close'}),
	deleteApiKey: async () => sendCommand({type: 'delete-api-key'}),
	editContextItem: async (reviewSequence: number, itemId: string, editedExcerpt: string) => sendCommand({
		editedExcerpt,
		itemId,
		reviewSequence,
		type: 'edit-context-item',
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
	refreshContext: async () => sendCommand({type: 'refresh-context'}),
	refreshConversation: async () => sendCommand({type: 'refresh-conversation'}),
	removeContextItem: async (reviewSequence: number, itemId: string) => sendCommand({itemId, reviewSequence, type: 'remove-context-item'}),
	removeReviewedImage: async (reviewSequence: number, itemId: string, processedHandleId: string) => sendCommand({
		itemId,
		processedHandleId,
		reviewSequence,
		type: 'remove-reviewed-image',
	}),
	resolveMedia: async (messageId: string, kind: 'audio' | 'video') => sendCommand({type: 'resolve-media', kind, messageId}),
	saveApiKey: async (apiKey: string) => sendCommand({type: 'save-api-key', apiKey}),
	searchHistory: async (query: string) => sendCommand({query, type: 'search-history'}),
	selectHistoryChat: async (chatId: string) => sendCommand({chatId, type: 'select-history-chat'}),
	setContextWindow: async (requestedCount: 10 | 20 | 50) => sendCommand({requestedCount, type: 'set-context-window'}),
	setWebSearchMode: async (mode: 'always' | 'auto' | 'off') => sendCommand({mode, type: 'set-web-search-mode'}),
	submitPrompt: async (prompt: string) => sendCommand({type: 'submit-prompt', prompt}),
	testApiKey: async () => sendCommand({type: 'test-api-key'}),
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
