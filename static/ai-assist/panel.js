const statusElement = document.querySelector('#session-status');
const cancelButton = document.querySelector('#cancel-button');
const closeButton = document.querySelector('#close-button');

const statusLabels = {
	cancelled: 'Request cancelled. Messenger remains available.',
	closed: 'Local session closed.',
	invalidated: 'Messenger changed. Reopen AI Assist to start a fresh session.',
	open: 'Local session ready. Nothing has left Messenger.',
	requesting: 'Request in progress…',
};

function render(state) {
	statusElement.textContent = statusLabels[state.session.status] ?? 'AI Assist unavailable.';
	cancelButton.disabled = state.session.status !== 'requesting';
}

cancelButton.addEventListener('click', async () => {
	render(await window.caprineAiAssist.cancel());
});

closeButton.addEventListener('click', async () => {
	await window.caprineAiAssist.close();
});

window.caprineAiAssist.onStateChanged(render);
window.caprineAiAssist.getState().then(render);
