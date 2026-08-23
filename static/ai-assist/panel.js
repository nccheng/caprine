const statusElement = document.querySelector('#session-status');
const keyForm = document.querySelector('#key-form');
const apiKeyInput = document.querySelector('#api-key');
const keyStatus = document.querySelector('#key-status');
const saveKeyButton = document.querySelector('#save-key-button');
const testKeyButton = document.querySelector('#test-key-button');
const deleteKeyButton = document.querySelector('#delete-key-button');
const promptForm = document.querySelector('#prompt-form');
const promptInput = document.querySelector('#prompt');
const askButton = document.querySelector('#ask-button');
const cancelButton = document.querySelector('#cancel-button');
const requestMessage = document.querySelector('#request-message');
const answerOutput = document.querySelector('#answer-output');
const closeButton = document.querySelector('#close-button');

const statusLabels = {
	cancelled: 'Request cancelled. Messenger remains available.',
	closed: 'Local session closed.',
	invalidated: 'Messenger changed. Reopen AI Assist to start a fresh session.',
	open: 'Local session ready. Nothing has left Messenger.',
	requesting: 'Request in progress…',
};

function render(state) {
	const isRequesting = state.session.status === 'requesting';
	statusElement.textContent = statusLabels[state.session.status] ?? 'AI Assist unavailable.';
	if (state.credentials.secureStorageAvailable) {
		keyStatus.textContent = state.credentials.configured
			? 'An OpenAI API key is encrypted with macOS secure storage.'
			: 'No OpenAI API key is configured.';
	} else {
		keyStatus.textContent = 'macOS secure storage is unavailable. Restart Caprine before saving a key.';
	}

	apiKeyInput.disabled = isRequesting || !state.credentials.secureStorageAvailable;
	saveKeyButton.disabled = isRequesting || !state.credentials.secureStorageAvailable;
	testKeyButton.disabled = isRequesting || !state.credentials.configured || state.session.status === 'invalidated';
	deleteKeyButton.disabled = isRequesting || !state.credentials.configured;
	promptInput.disabled = isRequesting;
	askButton.disabled = isRequesting || !state.credentials.configured || state.session.status === 'invalidated';
	cancelButton.disabled = !isRequesting;
	requestMessage.textContent = state.request.error?.message ?? state.request.notice ?? '';
	requestMessage.classList.toggle('error', Boolean(state.request.error));
	answerOutput.textContent = state.request.answer ?? 'No answer yet.';
}

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
