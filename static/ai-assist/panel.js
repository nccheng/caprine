const statusElement = document.querySelector('#session-status');
const keyForm = document.querySelector('#key-form');
const apiKeyInput = document.querySelector('#api-key');
const keyStatus = document.querySelector('#key-status');
const saveKeyButton = document.querySelector('#save-key-button');
const testKeyButton = document.querySelector('#test-key-button');
const deleteKeyButton = document.querySelector('#delete-key-button');
const refreshConversationButton = document.querySelector('#refresh-conversation-button');
const contextWindow = document.querySelector('#context-window');
const webSearchMode = document.querySelector('#web-search-mode');
const contextAvailability = document.querySelector('#context-availability');
const contextItems = document.querySelector('#context-items');
const newMessages = document.querySelector('#new-messages');
const refreshContextButton = document.querySelector('#refresh-context-button');
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
const insertAnswerButton = document.querySelector('#insert-answer-button');
const historySearchForm = document.querySelector('#history-search-form');
const historySearchInput = document.querySelector('#history-search');
const historySearchButton = document.querySelector('#history-search-button');
const newHistoryChatButton = document.querySelector('#new-history-chat-button');
const historyStatus = document.querySelector('#history-status');
const historyList = document.querySelector('#history-list');
const historyDetail = document.querySelector('#history-detail');
const closeButton = document.querySelector('#close-button');
let renderedCaptureGeneration;
let renderedInvocationSequence;
let promptCaptureGeneration;
let renderedInsertion;
const contextReviewRows = new Map();

function shouldClearPrompt(state) {
	return state.conversation.status !== 'ready'
		|| Boolean(
			promptInput.value
			&& promptCaptureGeneration !== state.conversation.captureGeneration,
		);
}

function answerForState(state) {
	return state.conversation.status === 'ready'
		? (state.request.answer?.text ?? 'No answer yet.')
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

function updateContextReviewRow(row, reviewed, index, reviewState) {
	const {locked, reviewSequence} = reviewState;
	const {item} = reviewed;
	row.itemId = reviewed.id;
	row.reviewSequence = reviewSequence;
	row.remove.disabled = locked;
	if (item.sender.role === 'outgoing') {
		row.heading.textContent = `Message ${index + 1} · sent by you`;
	} else if (item.sender.role === 'incoming') {
		row.heading.textContent = `Message ${index + 1} · received${item.sender.displayName ? ` from ${item.sender.displayName}` : ''}`;
	} else {
		row.heading.textContent = `Message ${index + 1} · sender unknown`;
	}

	row.metadata.textContent = [
		item.timestamp,
		`Confidence: ${item.confidence}`,
		item.omittedReason ? `Omitted: ${item.omittedReason} · Not sent to OpenAI` : 'Included in the reviewed prompt',
	].filter(Boolean).join(' · ');
	if (row.editor) {
		row.editor.disabled = locked;
		row.save.disabled = locked;
		const renderedValue = reviewed.editedExcerpt ?? contextExcerpt(item);
		if (row.editor.value === row.renderedValue) {
			row.editor.value = renderedValue;
		}

		row.renderedValue = renderedValue;
		row.editor.setAttribute('aria-label', `Edit message ${index + 1} excerpt`);
		row.marker.textContent = reviewed.editedExcerpt === undefined ? 'Original excerpt' : 'Edited excerpt';
	} else {
		row.excerpt.textContent = contextExcerpt(item);
	}
}

function createContextReviewRow(reviewed, index, reviewSequence, locked) {
	const article = document.createElement('article');
	article.className = 'context-item';
	const heading = document.createElement('h3');
	const metadata = document.createElement('p');
	const buttons = document.createElement('div');
	buttons.className = 'button-row';
	const remove = document.createElement('button');
	remove.type = 'button';
	remove.className = 'danger';
	remove.textContent = 'Remove';
	const row = {
		article,
		heading,
		itemId: reviewed.id,
		metadata,
		remove,
		reviewSequence,
	};
	remove.addEventListener('click', async () => {
		render(await window.caprineAiAssist.removeContextItem(row.reviewSequence, row.itemId));
	});
	buttons.append(remove);
	if (reviewed.item.omittedReason) {
		const excerpt = document.createElement('pre');
		excerpt.tabIndex = 0;
		row.excerpt = excerpt;
		article.append(heading, metadata, excerpt, buttons);
	} else {
		const marker = document.createElement('p');
		marker.className = 'edited-marker';
		const editor = document.createElement('textarea');
		editor.rows = 4;
		editor.maxLength = 20_000;
		const save = document.createElement('button');
		save.type = 'button';
		save.textContent = 'Save redaction';
		row.editor = editor;
		row.marker = marker;
		row.renderedValue = reviewed.editedExcerpt ?? contextExcerpt(reviewed.item);
		row.save = save;
		editor.value = row.renderedValue;
		save.addEventListener('click', async () => {
			if (editor.value.trim()) {
				render(await window.caprineAiAssist.editContextItem(row.reviewSequence, row.itemId, editor.value));
			}
		});
		buttons.prepend(save);
		article.append(heading, metadata, marker, editor, buttons);
	}

	updateContextReviewRow(row, reviewed, index, {locked, reviewSequence});
	return row;
}

function renderContextReview(review, isRequesting) {
	newMessages.hidden = !review?.newMessagesAvailable;
	if (!review) {
		contextAvailability.textContent = 'No context captured.';
		for (const row of contextReviewRows.values()) {
			row.article.remove();
		}

		contextReviewRows.clear();
		return;
	}

	contextWindow.value = String(review.requestedCount);
	const sendableCount = review.items.filter(({item}) => item.omittedReason === undefined).length;
	const locked = review.locked || isRequesting;
	const sendableSummary = review.locked
		? `${sendableCount} selected in the locked Ask snapshot. Use Refresh context to make changes.`
		: `${sendableCount} will be sent to OpenAI.`;
	contextAvailability.textContent = `${review.actualCount} of ${review.requestedCount} messages available; ${review.items.length} selected; ${sendableSummary}`;
	const presentIds = new Set();
	for (const [index, reviewed] of review.items.entries()) {
		presentIds.add(reviewed.id);
		let row = contextReviewRows.get(reviewed.id);
		if (!row) {
			row = createContextReviewRow(reviewed, index, review.sequence, locked);
			contextReviewRows.set(reviewed.id, row);
			contextItems.append(row.article);
		}

		updateContextReviewRow(row, reviewed, index, {locked, reviewSequence: review.sequence});
	}

	for (const [id, row] of contextReviewRows) {
		if (!presentIds.has(id)) {
			row.article.remove();
			contextReviewRows.delete(id);
		}
	}
}

function historyTime(timestamp) {
	return new Date(timestamp).toLocaleString([], {dateStyle: 'medium', timeStyle: 'short'});
}

function appendHistoryDetail(chat) {
	historyDetail.textContent = '';
	if (!chat) {
		historyDetail.textContent = 'Select a chat to inspect its frozen local history.';
		return;
	}

	const heading = document.createElement('h3');
	heading.textContent = chat.title;
	historyDetail.append(heading);
	if (chat.interactions.length < chat.interactionCount) {
		const boundedNotice = document.createElement('p');
		boundedNotice.textContent = `Showing the ${chat.interactions.length} most recent of ${chat.interactionCount} interactions to keep the local panel responsive.`;
		historyDetail.append(boundedNotice);
	}

	if (chat.interactions.length === 0) {
		const empty = document.createElement('p');
		empty.textContent = 'This new AI chat has no questions yet.';
		historyDetail.append(empty);
		return;
	}

	for (const interaction of chat.interactions) {
		const article = document.createElement('article');
		article.className = 'history-turn';
		const questionHeading = document.createElement('h4');
		questionHeading.textContent = 'You asked';
		const question = document.createElement('pre');
		question.tabIndex = 0;
		question.textContent = interaction.question;
		const answerHeading = document.createElement('h4');
		answerHeading.textContent = 'AI answer';
		const answer = document.createElement('pre');
		answer.tabIndex = 0;
		answer.textContent = interaction.answer;
		const metadata = document.createElement('p');
		metadata.textContent = `${historyTime(interaction.completedAt)} · ${interaction.model} · Web ${interaction.browsingMode}${interaction.webSearchRan ? ' (used)' : ''} · ${interaction.draftStatus === 'inserted' ? 'Inserted into draft' : 'Not inserted'} · ${interaction.shareStatus}`;
		article.append(questionHeading, question, answerHeading, answer, metadata);

		if (interaction.citations.length > 0) {
			const citationsHeading = document.createElement('h4');
			citationsHeading.textContent = 'Sources';
			const citations = document.createElement('ul');
			for (const citation of interaction.citations) {
				const item = document.createElement('li');
				item.textContent = `${citation.title} — ${citation.url}`;
				citations.append(item);
			}

			article.append(citationsHeading, citations);
		}

		const context = document.createElement('details');
		const contextSummary = document.createElement('summary');
		contextSummary.textContent = `Context used (${interaction.context.length})`;
		context.append(contextSummary);
		for (const contextItem of interaction.context) {
			const item = document.createElement('article');
			item.className = 'history-context-item';
			const itemMetadata = document.createElement('p');
			itemMetadata.textContent = contextItem.metadata;
			const excerpt = document.createElement('pre');
			excerpt.tabIndex = 0;
			excerpt.textContent = contextItem.excerpt;
			item.append(itemMetadata, excerpt);
			context.append(item);
		}

		article.append(context);
		if (interaction.artifacts.length > 0) {
			const artifacts = document.createElement('p');
			artifacts.textContent = `Saved artifact references: ${interaction.artifacts.map(artifact => `${artifact.kind} ${artifact.id}`).join(', ')}`;
			article.append(artifacts);
		}

		historyDetail.append(article);
	}
}

function renderHistory(history, isConversationReady) {
	const ready = history?.status === 'ready' && isConversationReady;
	historySearchInput.disabled = !ready;
	historySearchButton.disabled = !ready;
	newHistoryChatButton.disabled = !ready;
	historyList.textContent = '';
	if (!ready) {
		historySearchInput.value = '';
		historyStatus.textContent = history?.status === 'unavailable'
			? 'Local AI history is unavailable. Your current Messenger conversation is not being queried.'
			: 'Open a reliable Messenger conversation to view its local AI history.';
		appendHistoryDetail();
		return;
	}

	if (historySearchInput.value !== history.query) {
		historySearchInput.value = history.query;
	}

	historyStatus.textContent = history.chats.length === 0
		? (history.query ? 'No local history matches this search.' : 'No local AI chats for this conversation yet.')
		: `${history.chats.length} local AI ${history.chats.length === 1 ? 'chat' : 'chats'}${history.query ? ' matched' : ''}.`;
	let currentDate = '';
	for (const chat of history.chats) {
		const date = new Date(chat.lastActivityAt).toLocaleDateString([], {dateStyle: 'medium'});
		if (date !== currentDate) {
			const dateHeading = document.createElement('h3');
			dateHeading.className = 'history-date';
			dateHeading.textContent = date;
			historyList.append(dateHeading);
			currentDate = date;
		}

		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'history-chat';
		button.setAttribute('aria-current', chat.id === history.selectedChatId ? 'true' : 'false');
		const title = document.createElement('strong');
		title.textContent = chat.title;
		const preview = document.createElement('span');
		preview.textContent = chat.preview;
		const metadata = document.createElement('small');
		metadata.textContent = `${historyTime(chat.lastActivityAt)} · ${chat.contextCount} context items${chat.badges.length > 0 ? ` · ${chat.badges.join(', ')}` : ''}`;
		button.append(title, preview, metadata);
		button.addEventListener('click', async () => {
			render(await window.caprineAiAssist.selectHistoryChat(chat.id));
		});
		historyList.append(button);
	}

	appendHistoryDetail(history.chats.find(chat => chat.id === history.selectedChatId));
}

function render(state) {
	const isRequesting = state.session.status === 'requesting';
	const isReviewLocked = Boolean(state.review?.locked);
	const isConversationReady = state.conversation.status === 'ready';
	const isMediaResolving = state.media.resolution?.status === 'resolving';
	const isContextCapturing = state.contextCapturePending;
	renderHistory(state.history, isConversationReady);
	if (shouldClearPrompt(state)) {
		promptInput.value = '';
		promptCaptureGeneration = undefined;
	}

	renderedCaptureGeneration = state.conversation.captureGeneration;
	renderMessageAnchor(state.anchor);
	contextWindow.value = String(state.contextWindowSize);
	webSearchMode.value = state.webSearchMode;
	renderContextReview(state.review, isRequesting);
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
	promptInput.disabled = isRequesting || isReviewLocked || !isConversationReady;
	contextWindow.disabled = isRequesting || isContextCapturing || !isConversationReady;
	webSearchMode.disabled = isRequesting || isReviewLocked || !isConversationReady;
	refreshContextButton.disabled = isRequesting || isContextCapturing || !isConversationReady;
	refreshContextButton.textContent = state.review?.newMessagesAvailable ? 'Refresh context — new messages available' : 'Refresh context';
	askButton.textContent = isReviewLocked
		? 'Asked — Refresh context to ask again'
		: (state.review ? 'Ask with reviewed context' : 'Review context');
	askButton.disabled = isRequesting || isReviewLocked || isContextCapturing || !isConversationReady || Boolean(state.review && !state.credentials.configured);
	cancelButton.disabled = !isRequesting && !isMediaResolving && !isContextCapturing;
	requestMessage.textContent = state.request.error?.message ?? state.request.notice ?? '';
	requestMessage.classList.toggle('error', Boolean(state.request.error));
	answerOutput.textContent = answerForState(state);
	renderedInsertion = state.request.insertion;
	insertAnswerButton.disabled = !renderedInsertion || !state.request.answer || !isConversationReady;
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

refreshContextButton.addEventListener('click', async () => {
	render(await window.caprineAiAssist.refreshContext());
});

contextWindow.addEventListener('change', async () => {
	render(await window.caprineAiAssist.setContextWindow(Number(contextWindow.value)));
});

webSearchMode.addEventListener('change', async () => {
	render(await window.caprineAiAssist.setWebSearchMode(webSearchMode.value));
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

insertAnswerButton.addEventListener('click', async () => {
	const insertion = renderedInsertion;
	if (!insertion) {
		return;
	}

	renderedInsertion = undefined;
	insertAnswerButton.disabled = true;
	render(await window.caprineAiAssist.insertAnswer(
		insertion.answerGeneration,
		insertion.authorizationToken,
		insertion.conversationId,
	));
});

historySearchForm.addEventListener('submit', async event => {
	event.preventDefault();
	render(await window.caprineAiAssist.searchHistory(historySearchInput.value));
});

newHistoryChatButton.addEventListener('click', async () => {
	render(await window.caprineAiAssist.newHistoryChat());
});

closeButton.addEventListener('click', async () => {
	await window.caprineAiAssist.close();
});

window.caprineAiAssist.onStateChanged(render);
window.caprineAiAssist.getState().then(render).catch(() => {
	statusElement.textContent = 'AI Assist is unavailable. Close and reopen the panel.';
});
