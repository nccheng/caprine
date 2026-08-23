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
	getState: async () => sendCommand({type: 'get-state'}),
	refreshConversation: async () => sendCommand({type: 'refresh-conversation'}),
	saveApiKey: async (apiKey: string) => sendCommand({type: 'save-api-key', apiKey}),
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
