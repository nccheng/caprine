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
	getState: async () => sendCommand({type: 'get-state'}),
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
