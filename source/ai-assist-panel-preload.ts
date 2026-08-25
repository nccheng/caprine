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
	editContextItem: async (index: number, editedExcerpt: string) => sendCommand({editedExcerpt, index, type: 'edit-context-item'}),
	getState: async () => sendCommand({type: 'get-state'}),
	refreshContext: async () => sendCommand({type: 'refresh-context'}),
	refreshConversation: async () => sendCommand({type: 'refresh-conversation'}),
	removeContextItem: async (index: number) => sendCommand({index, type: 'remove-context-item'}),
	resolveMedia: async (messageId: string, kind: 'audio' | 'video') => sendCommand({type: 'resolve-media', kind, messageId}),
	saveApiKey: async (apiKey: string) => sendCommand({type: 'save-api-key', apiKey}),
	setContextWindow: async (requestedCount: 10 | 20 | 50) => sendCommand({requestedCount, type: 'set-context-window'}),
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
