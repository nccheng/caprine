const statusElement = document.querySelector('#session-status');
const keyForm = document.querySelector('#key-form');
const apiKeyInput = document.querySelector('#api-key');
const keyStatus = document.querySelector('#key-status');
const saveKeyButton = document.querySelector('#save-key-button');
const testKeyButton = document.querySelector('#test-key-button');
const deleteKeyButton = document.querySelector('#delete-key-button');
const refreshConversationButton = document.querySelector('#refresh-conversation-button');
const promptForm = document.querySelector('#prompt-form');
const promptInput = document.querySelector('#prompt');
const askButton = document.querySelector('#ask-button');
const cancelButton = document.querySelector('#cancel-button');
const requestMessage = document.querySelector('#request-message');
const answerOutput = document.querySelector('#answer-output');
const closeButton = document.querySelector('#close-button');
let renderedCaptureGeneration;
let promptCaptureGeneration;

function shouldClearPrompt(state) {
	return state.conversation.status !== 'ready'
		|| Boolean(
			promptInput.value
			&& promptCaptureGeneration !== state.conversation.captureGeneration,
		);
}

function answerForState(state) {
	return state.conversation.status === 'ready'
		? (state.request.answer ?? 'No answer yet.')
		: 'No answer yet.';
}

function render(state) {
	const isRequesting = state.session.status === 'requesting';
	const isConversationReady = state.conversation.status === 'ready';
	if (shouldClearPrompt(state)) {
		promptInput.value = '';
		promptCaptureGeneration = undefined;
	}

	renderedCaptureGeneration = state.conversation.captureGeneration;
	if (state.conversation.status === 'changed') {
		statusElement.textContent = 'Conversation changed — refresh context.';
	} else if (isConversationReady) {
		statusElement.textContent = state.conversation.displayName
			? `Ready for ${state.conversation.displayName}. Nothing has left Messenger.`
			: 'Conversation ready. Nothing has left Messenger.';
	} else {
		statusElement.textContent = 'No reliable Messenger conversation is active. AI actions are disabled.';
	}

	if (state.credentials.secureStorageAvailable) {
		keyStatus.textContent = state.credentials.configured
			? 'An OpenAI API key is encrypted with macOS secure storage.'
			: 'No OpenAI API key is configured.';
	} else {
		keyStatus.textContent = 'macOS secure storage is unavailable. Restart Caprine before saving a key.';
	}

	apiKeyInput.disabled = isRequesting || !state.credentials.secureStorageAvailable;
	saveKeyButton.disabled = isRequesting || !state.credentials.secureStorageAvailable;
	testKeyButton.disabled = isRequesting || !state.credentials.configured || !isConversationReady;
	deleteKeyButton.disabled = isRequesting || !state.credentials.configured;
	refreshConversationButton.disabled = isRequesting || isConversationReady;
	promptInput.disabled = isRequesting || !isConversationReady;
	askButton.disabled = isRequesting || !state.credentials.configured || !isConversationReady;
	cancelButton.disabled = !isRequesting;
	requestMessage.textContent = state.request.error?.message ?? state.request.notice ?? '';
	requestMessage.classList.toggle('error', Boolean(state.request.error));
	answerOutput.textContent = answerForState(state);
}

promptInput.addEventListener('input', () => {
	promptCaptureGeneration = renderedCaptureGeneration;
});

keyForm.addEventListener('submit', async event => {
	event.preventDefault();
	let apiKey = apiKeyInput.value;
	apiKeyInput.value = '';
	try {
		render(await window.caprineAiAssist.saveApiKey(apiKey));
	} finally {
		apiKey = '';
	}
});

testKeyButton.addEventListener('click', async () => {
	render(await window.caprineAiAssist.testApiKey());
});

deleteKeyButton.addEventListener('click', async () => {
	render(await window.caprineAiAssist.deleteApiKey());
});

refreshConversationButton.addEventListener('click', async () => {
	render(await window.caprineAiAssist.refreshConversation());
});

promptForm.addEventListener('submit', async event => {
	event.preventDefault();
	render(await window.caprineAiAssist.submitPrompt(promptInput.value));
});

cancelButton.addEventListener('click', async () => {
	render(await window.caprineAiAssist.cancel());
});

closeButton.addEventListener('click', async () => {
	await window.caprineAiAssist.close();
});

window.caprineAiAssist.onStateChanged(render);
window.caprineAiAssist.getState().then(render).catch(() => {
	statusElement.textContent = 'AI Assist is unavailable. Close and reopen the panel.';
});
