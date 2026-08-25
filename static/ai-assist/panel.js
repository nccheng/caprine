const statusElement = document.querySelector('#session-status');
const keyForm = document.querySelector('#key-form');
const apiKeyInput = document.querySelector('#api-key');
const keyStatus = document.querySelector('#key-status');
const saveKeyButton = document.querySelector('#save-key-button');
const testKeyButton = document.querySelector('#test-key-button');
const deleteKeyButton = document.querySelector('#delete-key-button');
const refreshConversationButton = document.querySelector('#refresh-conversation-button');
const contextWindow = document.querySelector('#context-window');
const contextAvailability = document.querySelector('#context-availability');
const contextItems = document.querySelector('#context-items');
const newMessages = document.querySelector('#new-messages');
const messageAnchor = document.querySelector('#message-anchor');
const messageAnchorPosition = document.querySelector('#message-anchor-position');
const messageAnchorSender = document.querySelector('#message-anchor-sender');
const messageAnchorContent = document.querySelector('#message-anchor-content');
const mediaCandidates = document.querySelector('#media-candidates');
const mediaForm = document.querySelector('#media-form');
const mediaMessageId = document.querySelector('#media-message-id');
const mediaKind = document.querySelector('#media-kind');
const resolveMediaButton = document.querySelector('#resolve-media-button');
const mediaStatus = document.querySelector('#media-status');
const promptForm = document.querySelector('#prompt-form');
const promptInput = document.querySelector('#prompt');
const askButton = document.querySelector('#ask-button');
const cancelButton = document.querySelector('#cancel-button');
const requestMessage = document.querySelector('#request-message');
const answerOutput = document.querySelector('#answer-output');
const closeButton = document.querySelector('#close-button');
let renderedCaptureGeneration;
let renderedInvocationSequence;
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

function mediaStatusForState(state) {
	const {resolution} = state.media;
	if (!resolution) {
		return 'Media bytes have not been requested.';
	}

	const size = resolution.byteLength === undefined
		? ''
		: `, ${resolution.byteLength.toLocaleString()} bytes`;
	const duration = resolution.durationSeconds === undefined
		? ''
		: `, ${resolution.durationSeconds.toFixed(1)} seconds`;
	if (resolution.status === 'ready') {
		return `${resolution.kind} bytes ready (${resolution.mimeType}${size}${duration}). They remain temporary and private.`;
	}

	if (resolution.status === 'resolving') {
		return `Resolving ${resolution.kind} bytes…`;
	}

	if (resolution.status === 'unsupported') {
		return `This ${resolution.kind} uses a segmented or MediaSource player that cannot provide one complete file yet${duration}.`;
	}

	return `${resolution.kind} bytes are unavailable${duration}.`;
}

function renderMessageAnchor(anchor) {
	messageAnchor.hidden = !anchor;
	if (!anchor) {
		messageAnchorContent.textContent = '';
		return;
	}

	const {item} = anchor;
	messageAnchorPosition.textContent = `Loaded message ${anchor.loadedIndex + 1} of ${anchor.loadedCount}`;
	messageAnchorSender.textContent = item.sender.role === 'outgoing'
		? 'Sent by you'
		: `Received${item.sender.displayName ? ` from ${item.sender.displayName}` : ''}`;
	const parts = [];
	if (item.text) {
		parts.push(item.text);
	}

	if (item.reply) {
		parts.push(`Reply to${item.reply.quotedSender ? ` ${item.reply.quotedSender}` : ''}: ${item.reply.text}`);
	}

	if (item.linkPreview) {
		parts.push(`Link: ${item.linkPreview.title ?? item.linkPreview.domain}`);
	}

	if (item.attachments) {
		parts.push(`Attachments: ${item.attachments.map(attachment => attachment.kind).join(', ')}`);
	}

	messageAnchorContent.textContent = parts.join('\n\n');
}

function contextExcerpt(item) {
	if (item.omittedReason) {
		return `Unsupported or omitted item: ${item.omittedReason}`;
	}

	const parts = [];
	if (item.text) {
		parts.push(item.text);
	}

	if (item.reply) {
		parts.push(`Reply to${item.reply.quotedSender ? ` ${item.reply.quotedSender}` : ''}: ${item.reply.text}`);
	}

	if (item.reactions) {
		parts.push(`Reactions: ${item.reactions.map(reaction => `${reaction.emoji} ${reaction.count}`).join(', ')}`);
	}

	if (item.linkPreview) {
		parts.push(`Link preview: ${item.linkPreview.title ?? item.linkPreview.domain} (${item.linkPreview.url})`);
	}

	if (item.attachments) {
		parts.push(`Attachments: ${item.attachments.map(attachment => attachment.kind).join(', ')}`);
	}

	return parts.join('\n');
}

function renderContextReview(review) {
	contextItems.textContent = '';
	newMessages.hidden = !review?.newMessagesAvailable;
	if (!review) {
		contextAvailability.textContent = 'No context captured.';
		return;
	}

	contextWindow.value = String(review.requestedCount);
	contextAvailability.textContent = `${review.actualCount} of ${review.requestedCount} messages available; ${review.items.length} selected.`;
	for (const [index, reviewed] of review.items.entries()) {
		const {item} = reviewed;
		const article = document.createElement('article');
		article.className = 'context-item';
		const heading = document.createElement('h3');
		if (item.sender.role === 'outgoing') {
			heading.textContent = `Message ${index + 1} · sent by you`;
		} else if (item.sender.role === 'incoming') {
			heading.textContent = `Message ${index + 1} · received${item.sender.displayName ? ` from ${item.sender.displayName}` : ''}`;
		} else {
			heading.textContent = `Message ${index + 1} · sender unknown`;
		}

		const metadata = document.createElement('p');
		metadata.textContent = [item.timestamp, `Confidence: ${item.confidence}`, item.omittedReason ? `Omitted: ${item.omittedReason}` : 'Supported']
			.filter(Boolean)
			.join(' · ');
		const marker = document.createElement('p');
		marker.className = 'edited-marker';
		marker.textContent = reviewed.editedExcerpt === undefined ? 'Original excerpt' : 'Edited excerpt';
		const editor = document.createElement('textarea');
		editor.rows = 4;
		editor.maxLength = 20_000;
		editor.value = reviewed.editedExcerpt ?? contextExcerpt(item);
		editor.setAttribute('aria-label', `Edit message ${index + 1} excerpt`);
		const buttons = document.createElement('div');
		buttons.className = 'button-row';
		const save = document.createElement('button');
		save.type = 'button';
		save.textContent = 'Save redaction';
		save.addEventListener('click', async () => {
			if (editor.value.trim()) {
				render(await window.caprineAiAssist.editContextItem(index, editor.value));
			}
		});
		const remove = document.createElement('button');
		remove.type = 'button';
		remove.className = 'danger';
		remove.textContent = 'Remove';
		remove.addEventListener('click', async () => {
			render(await window.caprineAiAssist.removeContextItem(index));
		});
		buttons.append(save, remove);
		article.append(heading, metadata, marker, editor, buttons);
		contextItems.append(article);
	}
}

function render(state) {
	const isRequesting = state.session.status === 'requesting';
	const isConversationReady = state.conversation.status === 'ready';
	const isMediaResolving = state.media.resolution?.status === 'resolving';
	if (shouldClearPrompt(state)) {
		promptInput.value = '';
		promptCaptureGeneration = undefined;
	}

	renderedCaptureGeneration = state.conversation.captureGeneration;
	renderMessageAnchor(state.anchor);
	renderContextReview(state.review);
	if (state.invocation && state.invocation.sequence !== renderedInvocationSequence) {
		promptInput.value = state.invocation.prompt;
		promptCaptureGeneration = state.conversation.captureGeneration;
		renderedInvocationSequence = state.invocation.sequence;
		promptInput.focus?.();
	}

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
	mediaCandidates.textContent = state.media.candidates.length > 0
		? `Loaded media: ${state.media.candidates.map(candidate => `${candidate.kind} ${candidate.messageId}`).join(', ')}`
		: 'No loaded voice or video messages detected.';
	mediaMessageId.disabled = isRequesting || isMediaResolving || !isConversationReady;
	mediaKind.disabled = isRequesting || isMediaResolving || !isConversationReady;
	resolveMediaButton.disabled = isRequesting || isMediaResolving || !isConversationReady;
	mediaStatus.textContent = mediaStatusForState(state);
	promptInput.disabled = isRequesting || !isConversationReady;
	contextWindow.disabled = isRequesting || !isConversationReady;
	askButton.textContent = state.review ? 'Ask with reviewed context' : 'Review context';
	askButton.disabled = isRequesting || !isConversationReady || Boolean(state.review && !state.credentials.configured);
	cancelButton.disabled = !isRequesting && !isMediaResolving;
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

contextWindow.addEventListener('change', async () => {
	render(await window.caprineAiAssist.setContextWindow(Number(contextWindow.value)));
});

mediaForm.addEventListener('submit', async event => {
	event.preventDefault();
	render(await window.caprineAiAssist.resolveMedia(mediaMessageId.value, mediaKind.value));
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
