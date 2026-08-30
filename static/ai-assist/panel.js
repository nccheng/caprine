const statusElement = document.querySelector('#session-status');
const keyForm = document.querySelector('#key-form');
const apiKeyInput = document.querySelector('#api-key');
const keyStatus = document.querySelector('#key-status');
const saveKeyButton = document.querySelector('#save-key-button');
const testKeyButton = document.querySelector('#test-key-button');
const deleteKeyButton = document.querySelector('#delete-key-button');
const copyDiagnosticsButton = document.querySelector('#copy-diagnostics-button');
const diagnosticsCopyStatus = document.querySelector('#diagnostics-copy-status');
const diagnosticAiEnabled = document.querySelector('#diagnostic-ai-enabled');
const diagnosticOpenAiKey = document.querySelector('#diagnostic-openai-key');
const diagnosticPanel = document.querySelector('#diagnostic-panel');
const diagnosticConversation = document.querySelector('#diagnostic-conversation');
const diagnosticContextAdapter = document.querySelector('#diagnostic-context-adapter');
const diagnosticFfmpeg = document.querySelector('#diagnostic-ffmpeg');
const diagnosticFfprobe = document.querySelector('#diagnostic-ffprobe');
const diagnosticHistory = document.querySelector('#diagnostic-history');
const diagnosticProviderError = document.querySelector('#diagnostic-provider-error');
const diagnosticMediaError = document.querySelector('#diagnostic-media-error');
const refreshConversationButton = document.querySelector('#refresh-conversation-button');
const contextWindow = document.querySelector('#context-window');
const webSearchMode = document.querySelector('#web-search-mode');
const contextSourceDisclosure = document.querySelector('#context-source-disclosure');
const contextAvailability = document.querySelector('#context-availability');
const contextReviewSummary = document.querySelector('#context-review-details > summary');
const contextMessageDetails = document.querySelector('#context-message-details');
const contextMessageSummary = document.querySelector('#context-message-summary');
const contextItems = document.querySelector('#context-items');
const imageSelectionSummary = document.querySelector('#image-selection-summary');
const imageSelectionNotice = document.querySelector('#image-selection-notice');
const reviewedImages = document.querySelector('#reviewed-images');
const reviewedTranscripts = document.querySelector('#reviewed-transcripts');
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
const videoAnalysisStatus = document.querySelector('#video-analysis-status');
const promptForm = document.querySelector('#prompt-form');
const promptInput = document.querySelector('#prompt');
const askButton = document.querySelector('#ask-button');
const cancelButton = document.querySelector('#cancel-button');
const requestMessage = document.querySelector('#request-message');
const answerOutput = document.querySelector('#answer-output');
const answerSearchStatus = document.querySelector('#answer-search-status');
const answerSources = document.querySelector('#answer-sources');
const answerSourcesSummary = document.querySelector('#answer-sources-summary');
const answerSourceList = document.querySelector('#answer-source-list');
const insertAnswerButton = document.querySelector('#insert-answer-button');
const historySearchForm = document.querySelector('#history-search-form');
const historySearchInput = document.querySelector('#history-search');
const historySearchButton = document.querySelector('#history-search-button');
const newHistoryChatButton = document.querySelector('#new-history-chat-button');
const clearConversationHistoryButton = document.querySelector('#clear-conversation-history-button');
const clearAllHistoryButton = document.querySelector('#clear-all-history-button');
const historyStatus = document.querySelector('#history-status');
const historyList = document.querySelector('#history-list');
const historyDetail = document.querySelector('#history-detail');
const historyDeletionDialog = document.querySelector('#history-deletion-dialog');
const historyDeletionTitle = document.querySelector('#history-deletion-title');
const historyDeletionMessage = document.querySelector('#history-deletion-message');
const confirmHistoryDeletionButton = document.querySelector('#confirm-history-deletion-button');
const cancelHistoryDeletionButton = document.querySelector('#cancel-history-deletion-button');
const closeButton = document.querySelector('#close-button');
let renderedCaptureGeneration;
let renderedInvocationSequence;
let renderedOriginalReplaySequence;
let renderedContextReviewSequence;
let promptCaptureGeneration;
let renderedInsertion;
let renderedAnswerSignature;
let renderedHistoryDeletionToken;
let diagnosticsCopySequence;
let historyDeletionFocusTarget;
let renderedHistoryDeleteButton;
let renderedHistoryDeleteChatId;
let initialFocusApplied = false;
const contextReviewRows = new Map();
const reviewedImageRows = new Map();
const reviewedTranscriptRows = new Map();

function focusFirstAvailable(...elements) {
	for (const element of elements) {
		if (
			element
			&& !element.disabled
			&& !element.hidden
			&& (typeof document.contains !== 'function' || document.contains(element))
		) {
			const containingDetails = element.closest?.('details');
			if (containingDetails) {
				containingDetails.open = true;
			}

			element.focus?.();
			return true;
		}
	}

	return false;
}

function shouldClearPrompt(state) {
	return state.conversation.status !== 'ready'
		|| Boolean(
			promptInput.value
			&& promptCaptureGeneration !== state.conversation.captureGeneration,
		);
}

function renderDiagnostics(diagnostics) {
	diagnosticsCopySequence = diagnostics.copySequence;
	diagnosticAiEnabled.textContent = diagnostics.aiEnabled ? 'yes' : 'no';
	diagnosticOpenAiKey.textContent = diagnostics.openAiKey;
	diagnosticPanel.textContent = diagnostics.panel;
	diagnosticConversation.textContent = diagnostics.messengerConversation;
	diagnosticContextAdapter.textContent = diagnostics.contextAdapter;
	diagnosticFfmpeg.textContent = diagnostics.videoTools.ffmpeg;
	diagnosticFfprobe.textContent = diagnostics.videoTools.ffprobe;
	diagnosticHistory.textContent = diagnostics.historyDatabase;
	diagnosticProviderError.textContent = diagnostics.lastProviderError ?? 'none';
	diagnosticMediaError.textContent = diagnostics.lastMediaError ?? 'none';
}

function sourceLabel(source) {
	if (source.title?.trim()) {
		return source.title.trim();
	}

	return new URL(source.url).hostname;
}

function renderAnswer(state) {
	const renderedAnswer = state.conversation.status === 'ready' ? state.request.answer : undefined;
	const signature = renderedAnswer === undefined ? '' : JSON.stringify(renderedAnswer);
	if (signature === renderedAnswerSignature) {
		return;
	}

	const hadRenderedAnswerState = renderedAnswerSignature !== undefined;
	renderedAnswerSignature = signature;
	answerOutput.textContent = '';
	answerSourceList.textContent = '';
	answerSources.hidden = true;
	answerSources.open = false;
	if (!renderedAnswer) {
		answerOutput.textContent = 'No answer yet.';
		answerSearchStatus.textContent = 'No answer yet.';
		return;
	}

	const view = window.caprineCitationViewModel.build(renderedAnswer);
	if (view.status === 'malformed') {
		answerOutput.textContent = view.text || 'No answer yet.';
		answerSearchStatus.textContent = 'Search evidence could not be displayed safely.';
		if (hadRenderedAnswerState) {
			focusFirstAvailable(answerOutput);
		}

		return;
	}

	answerSearchStatus.textContent = view.status === 'searched'
		? 'Web search was used for this answer.'
		: 'Web search was not used for this answer.';
	let cursor = 0;
	for (const marker of view.markers) {
		if (marker.endIndex > cursor) {
			const text = document.createElement('span');
			text.textContent = view.text.slice(cursor, marker.endIndex);
			answerOutput.append(text);
			cursor = marker.endIndex;
		}

		const reference = document.createElement('sup');
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'citation-marker';
		button.textContent = `[${marker.sourceNumber}]`;
		button.setAttribute('aria-label', `Open cited source ${marker.sourceNumber}`);
		button.addEventListener('click', async () => {
			await window.caprineAiAssist.openCitation(marker.url);
		});
		reference.append(button);
		answerOutput.append(reference);
	}

	if (cursor < view.text.length) {
		const text = document.createElement('span');
		text.textContent = view.text.slice(cursor);
		answerOutput.append(text);
	}

	if (view.sources.length === 0) {
		if (hadRenderedAnswerState) {
			focusFirstAvailable(answerOutput);
		}

		return;
	}

	answerSources.hidden = false;
	answerSourcesSummary.textContent = view.sourceCount > view.sources.length
		? `Showing ${view.sources.length} of ${view.sourceCount} sources cited in this answer.`
		: `${view.sourceCount} ${view.sourceCount === 1 ? 'source' : 'sources'} cited in this answer.`;
	for (const source of view.sources) {
		const item = document.createElement('li');
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'citation-source';
		button.textContent = sourceLabel(source);
		button.setAttribute('aria-label', `Open cited source ${source.number}: ${sourceLabel(source)}`);
		button.addEventListener('click', async () => {
			await window.caprineAiAssist.openCitation(source.url);
		});
		item.append(button);
		answerSourceList.append(item);
	}

	if (hadRenderedAnswerState) {
		focusFirstAvailable(answerOutput);
	}
}

function renderVideoAnalysis(state) {
	const analysis = state.videoAnalysis;
	videoAnalysisStatus.hidden = !analysis;
	if (!analysis) {
		videoAnalysisStatus.textContent = '';
		return;
	}

	const phase = {
		'extracting-focus': 'extracting denser frames for important or uncertain intervals',
		'pass-1': 'Pass 1 — scanning the full sampled timeline',
		'pass-2': 'Pass 2 — focused detail analysis',
		preprocessing: 'preparing timestamped video frames locally',
	}[analysis.phase];
	const coverage = analysis.coverage
		? `${analysis.coverage} sampled coverage; ${analysis.frameCount} broad frames`
		: `${analysis.frameCount} broad frames prepared`;
	const focused = analysis.focusedFrameCount === undefined ? '' : `; ${analysis.focusedFrameCount} newly extracted focused frames`;
	const transcript = analysis.transcriptAvailable ? 'timestamped transcript available' : 'visual-only; no transcript available';
	const outcome = analysis.status === 'canceled'
		? 'Canceled'
		: (analysis.status === 'failed' ? 'Failed' : undefined);
	const transmission = analysis.status === 'ready' && analysis.phase === 'preprocessing'
		? ' Prepared frames and the reviewed transcript will be sent to OpenAI only when you choose Ask.'
		: (analysis.status === 'analyzing' && analysis.phase !== 'preprocessing'
			? ' Selected sampled frames and the reviewed transcript are being analyzed by OpenAI.'
			: '');
	videoAnalysisStatus.textContent = `${outcome ? `${outcome} while ` : ''}${phase}. ${coverage}${focused}; ${transcript}. This is sampled-video understanding, not inspection of every original frame.${transmission}`;
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
	row.remove.setAttribute('aria-label', `Remove message ${index + 1} from reviewed context`);
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
		row.save.setAttribute('aria-label', `Save redaction for message ${index + 1}`);
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
		const removedIndex = [...contextReviewRows.keys()].indexOf(row.itemId);
		render(await window.caprineAiAssist.removeContextItem(row.reviewSequence, row.itemId));
		const remainingRows = [...contextReviewRows.values()];
		const focusRow = remainingRows[Math.min(removedIndex, remainingRows.length - 1)];
		focusFirstAvailable(focusRow?.editor, focusRow?.remove, refreshContextButton);
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

function transcriptTime(seconds) {
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds - (minutes * 60);
	return `${String(minutes).padStart(2, '0')}:${remainder.toFixed(3).padStart(6, '0')}`;
}

function transcriptStatus(item) {
	switch (item.status) {
		case 'available':
		case 'removed': {
			return 'Not prepared. Nothing has been sent to OpenAI.';
		}

		case 'preparing': {
			return `Preparing ${item.kind === 'video' ? 'video-audio' : 'voice-message'} metadata locally. Nothing has been sent to OpenAI.`;
		}

		case 'ready': {
			return 'Ready for explicit transcription consent.';
		}

		case 'transcribing': {
			return 'Sending this selected media to OpenAI for transcription…';
		}

		case 'extracting': {
			return 'Extracting bounded video audio locally. Nothing has been sent to OpenAI yet.';
		}

		case 'completed': {
			return item.editedSegments ? 'Edited transcript is selected for the AI request.' : 'Original transcript is selected for the AI request.';
		}

		case 'no-audio': {
			return item.notice ?? 'No audio track. The video remains available for visual processing.';
		}

		case 'canceled': {
			return item.notice ?? 'Transcription canceled. Text-only context remains available.';
		}

		case 'oversized': {
			return item.notice ?? 'This voice message exceeds the transcription limit.';
		}

		case 'unsupported': {
			return item.notice ?? 'This voice message format is unsupported.';
		}

		case 'timed-out': {
			return item.notice ?? 'Transcription timed out. Text-only context remains available.';
		}

		default: {
			return item.notice ?? 'Transcription failed. Text-only context remains available.';
		}
	}
}

function rebuildTranscriptSegments(row, item) {
	const segments = item.editedSegments ?? item.originalSegments ?? [];
	const signature = JSON.stringify({edited: Boolean(item.editedSegments), segments});
	if (row.segmentSignature === signature) {
		return;
	}

	row.segmentSignature = signature;
	row.segmentContainer.textContent = '';
	row.editors = [];
	for (const [index, segment] of segments.entries()) {
		const wrapper = document.createElement('label');
		wrapper.className = 'transcript-segment';
		const timestamp = document.createElement('time');
		timestamp.textContent = `${transcriptTime(segment.startSeconds)}–${transcriptTime(segment.endSeconds)}`;
		const editor = document.createElement('textarea');
		editor.rows = 2;
		editor.maxLength = 20_000;
		editor.value = segment.text;
		editor.setAttribute('aria-label', `Edit transcript segment ${index + 1}`);
		wrapper.append(timestamp, editor);
		row.segmentContainer.append(wrapper);
		row.editors.push(editor);
	}
}

function updateReviewedTranscriptRow(row, item, reviewSequence, locked, credentialsConfigured) {
	row.item = item;
	row.reviewSequence = reviewSequence;
	row.heading.textContent = item.senderLabel;
	row.save.setAttribute('aria-label', `Save transcript edits for ${item.senderLabel}`);
	row.remove.setAttribute('aria-label', `Remove transcript for ${item.senderLabel}`);
	row.metadata.textContent = [
		item.durationSeconds === undefined ? undefined : `${item.durationSeconds.toFixed(1)} seconds`,
		item.byteLength === undefined ? undefined : `${item.byteLength.toLocaleString()} bytes`,
		item.mimeType,
	].filter(Boolean).join(' · ');
	row.disclosure.textContent = ['ready', 'extracting', 'transcribing'].includes(item.status)
		? 'This media will be sent to OpenAI for transcription'
		: '';
	row.status.textContent = transcriptStatus(item);
	const completed = item.status === 'completed';
	row.marker.hidden = !completed;
	row.marker.textContent = item.editedSegments ? 'Edited transcript' : 'Original transcript';
	row.segmentContainer.hidden = !completed;
	row.save.hidden = !completed;
	row.remove.hidden = !completed;
	if (completed) {
		rebuildTranscriptSegments(row, item);
	} else {
		row.segmentSignature = undefined;
		row.segmentContainer.textContent = '';
		row.editors = [];
	}

	for (const editor of row.editors) {
		editor.disabled = locked;
	}

	row.save.disabled = locked;
	row.remove.disabled = locked;
	row.action.hidden = completed || item.status === 'no-audio';
	row.action.disabled = locked || ['preparing', 'extracting', 'transcribing', 'no-audio', 'oversized', 'unsupported'].includes(item.status)
		|| (item.status === 'ready' && !credentialsConfigured);
	switch (item.status) {
		case 'ready': {
			row.action.textContent = 'Transcribe and review';
			break;
		}

		case 'transcribing': {
			row.action.textContent = 'Cancel transcription';
			break;
		}

		case 'extracting': {
			row.action.textContent = 'Cancel extraction';
			break;
		}

		case 'preparing': {
			row.action.textContent = 'Preparing…';
			break;
		}

		default: {
			row.action.textContent = item.kind === 'video' ? 'Prepare video audio' : 'Prepare voice message';
		}
	}

	row.action.setAttribute('aria-label', `${row.action.textContent} for ${item.senderLabel}`);

	if (item.status === 'extracting' || item.status === 'transcribing') {
		row.action.disabled = locked;
	}
}

function createReviewedTranscriptRow(item, reviewSequence, locked, credentialsConfigured) {
	const article = document.createElement('article');
	article.className = 'context-item';
	const heading = document.createElement('h3');
	const metadata = document.createElement('p');
	const disclosure = document.createElement('p');
	disclosure.className = 'context-availability';
	const status = document.createElement('p');
	status.setAttribute('role', 'status');
	const marker = document.createElement('p');
	marker.className = 'edited-marker';
	const segmentContainer = document.createElement('div');
	segmentContainer.className = 'transcript-segments';
	const buttons = document.createElement('div');
	buttons.className = 'button-row';
	const action = document.createElement('button');
	action.type = 'button';
	const save = document.createElement('button');
	save.type = 'button';
	save.textContent = 'Save transcript edits';
	const remove = document.createElement('button');
	remove.type = 'button';
	remove.className = 'danger';
	remove.textContent = 'Remove transcript';
	const row = {
		action,
		article,
		disclosure,
		editors: [],
		heading,
		item,
		marker,
		metadata,
		remove,
		reviewSequence,
		save,
		segmentContainer,
		segmentSignature: undefined,
		status,
	};
	action.addEventListener('click', async () => {
		let nextState;
		if (row.item.status === 'ready') {
			nextState = await window.caprineAiAssist.transcribeReviewedMedia(row.reviewSequence, row.item.id);
		} else if (row.item.status === 'extracting' || row.item.status === 'transcribing') {
			nextState = await window.caprineAiAssist.cancelTranscription(row.reviewSequence, row.item.id);
		} else {
			nextState = await window.caprineAiAssist.prepareTranscript(row.reviewSequence, row.item.id);
		}

		render(nextState);
	});
	save.addEventListener('click', async () => {
		const texts = row.editors.map(editor => editor.value);
		if (texts.every(text => text.trim())) {
			render(await window.caprineAiAssist.editTranscript(row.reviewSequence, row.item.id, texts));
		}
	});
	remove.addEventListener('click', async () => {
		render(await window.caprineAiAssist.removeTranscript(row.reviewSequence, row.item.id));
		const currentRow = reviewedTranscriptRows.get(row.item.id);
		focusFirstAvailable(currentRow?.action, refreshContextButton);
	});
	buttons.append(action, save, remove);
	article.append(heading, metadata, disclosure, status, marker, segmentContainer, buttons);
	updateReviewedTranscriptRow(row, item, reviewSequence, locked, credentialsConfigured);
	return row;
}

function renderReviewedTranscripts(review, isRequesting, credentialsConfigured) {
	const presentIds = new Set();
	for (const item of review?.transcripts ?? []) {
		presentIds.add(item.id);
		const locked = review.locked || isRequesting || !review.editable;
		let row = reviewedTranscriptRows.get(item.id);
		if (!row) {
			row = createReviewedTranscriptRow(item, review.sequence, locked, credentialsConfigured);
			reviewedTranscriptRows.set(item.id, row);
			reviewedTranscripts.append(row.article);
		}

		updateReviewedTranscriptRow(row, item, review.sequence, locked, credentialsConfigured);
	}

	for (const [id, row] of reviewedTranscriptRows) {
		if (!presentIds.has(id)) {
			row.article.remove();
			reviewedTranscriptRows.delete(id);
		}
	}
}

function renderContextReview(review, isRequesting, credentialsConfigured) {
	newMessages.hidden = !review?.newMessagesAvailable;
	if (!review) {
		contextSourceDisclosure.textContent = 'No context source selected.';
		contextAvailability.textContent = 'No context captured.';
		contextMessageDetails.open = false;
		contextMessageSummary.textContent = 'Context messages (0)';
		renderedContextReviewSequence = undefined;
		for (const row of contextReviewRows.values()) {
			row.article.remove();
		}

		contextReviewRows.clear();
		renderReviewedImages(undefined, isRequesting);
		renderReviewedTranscripts(undefined, isRequesting, credentialsConfigured);
		return;
	}

	contextWindow.value = String(review.requestedCount);
	contextSourceDisclosure.textContent = review.contextSource === 'historical-original'
		? 'Context source: original frozen history snapshot. Its question, edits, omissions, and web-search mode are immutable for exact replay.'
		: (review.contextSource === 'historical-current'
			? 'Context source: newly captured current Messenger conversation for a historical question.'
			: 'Context source: newly captured current Messenger conversation.');
	const sendableCount = review.items.filter(({item}) => item.omittedReason === undefined).length;
	const locked = review.locked || isRequesting || !review.editable;
	const sendableSummary = review.locked
		? `${sendableCount} selected in the locked Ask snapshot. Use Refresh context to make changes.`
		: `${sendableCount} will be sent to OpenAI.`;
	contextAvailability.textContent = `${review.actualCount} of ${review.requestedCount} messages available; ${review.items.length} selected; ${sendableSummary}`;
	contextMessageSummary.textContent = locked
		? `Context messages (${review.items.length}) · Show review details`
		: `Context messages (${review.items.length}) · Show to review or redact`;
	if (renderedContextReviewSequence !== review.sequence) {
		contextMessageDetails.open = false;
		renderedContextReviewSequence = review.sequence;
	}

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

	renderReviewedImages(review, isRequesting);
	renderReviewedTranscripts(review, isRequesting, credentialsConfigured);
}

function imageStatusLabel(image) {
	switch (image.status) {
		case 'selected': {
			return 'Included in this reviewed request';
		}

		case 'available': {
			return 'Available — not included';
		}

		case 'removed': {
			return 'Removed — temporary bytes released';
		}

		case 'capture-failed': {
			return `Capture failed: ${image.failureReason}`;
		}

		default: {
			return `Normalization failed: ${image.failureReason}`;
		}
	}
}

function updateReviewedImageRow(row, image, reviewSequence, locked) {
	row.itemId = image.id;
	row.processedHandleId = image.processedHandleId;
	row.reviewSequence = reviewSequence;
	row.article.dataset.status = image.status;
	row.heading.textContent = image.senderLabel;
	row.context.textContent = image.messageContext;
	row.status.textContent = imageStatusLabel(image);
	if (row.thumbnail) {
		row.thumbnail.hidden = image.status === 'capture-failed' || image.status === 'normalization-failed';
		if (!row.thumbnail.hidden) {
			row.thumbnail.src = image.thumbnailDataUrl;
			row.thumbnail.alt = `Processed image from ${image.senderLabel}`;
		}
	}

	if (row.metadata) {
		row.metadata.textContent = `${image.width} × ${image.height} · ${image.mimeType} · ${image.byteLength.toLocaleString()} bytes`;
	}

	if (row.action) {
		row.action.textContent = image.status === 'available' ? 'Include' : 'Remove';
		row.action.className = image.status === 'available' ? 'secondary' : 'danger';
		row.action.disabled = locked || image.status === 'removed';
		row.action.setAttribute('aria-label', `${row.action.textContent} processed image from ${image.senderLabel}`);
	}
}

function createReviewedImageRow(image, reviewSequence, locked) {
	const article = document.createElement('article');
	article.className = 'reviewed-image';
	const heading = document.createElement('h4');
	const context = document.createElement('p');
	const status = document.createElement('p');
	status.className = 'reviewed-image-status';
	const row = {
		article,
		context,
		heading,
		itemId: image.id,
		reviewSequence,
		status,
	};
	if (image.status === 'capture-failed' || image.status === 'normalization-failed') {
		article.append(heading, context, status);
	} else {
		const thumbnail = document.createElement('img');
		const metadata = document.createElement('p');
		const action = document.createElement('button');
		action.type = 'button';
		row.action = action;
		row.metadata = metadata;
		row.processedHandleId = image.processedHandleId;
		row.thumbnail = thumbnail;
		action.addEventListener('click', async () => {
			const changedIndex = [...reviewedImageRows.keys()].indexOf(row.itemId);
			const state = action.textContent === 'Include'
				? await window.caprineAiAssist.includeReviewedImage(row.reviewSequence, row.itemId, row.processedHandleId)
				: await window.caprineAiAssist.removeReviewedImage(row.reviewSequence, row.itemId, row.processedHandleId);
			render(state);
			if (action.disabled) {
				const remainingRows = [...reviewedImageRows.values()]
					.filter(candidate => candidate.action && !candidate.action.disabled);
				const focusRow = remainingRows[Math.min(changedIndex, remainingRows.length - 1)];
				focusFirstAvailable(focusRow?.action, refreshContextButton);
			}
		});
		article.append(heading, context, thumbnail, metadata, status, action);
	}

	updateReviewedImageRow(row, image, reviewSequence, locked);
	return row;
}

function renderReviewedImages(review, isRequesting) {
	const images = review?.images ?? [];
	const summary = review?.imageSelection;
	imageSelectionSummary.textContent = summary
		? `${summary.selectedCount} selected · ${summary.aggregateBytes.toLocaleString()} bytes`
		: 'No processed images in this review.';
	imageSelectionNotice.textContent = summary?.blockingNotice ?? '';
	const presentIds = new Set();
	const locked = Boolean(review?.locked || isRequesting || review?.editable === false);
	for (const image of images) {
		presentIds.add(image.id);
		let row = reviewedImageRows.get(image.id);
		if (!row) {
			row = createReviewedImageRow(image, review.sequence, locked);
			reviewedImageRows.set(image.id, row);
			reviewedImages.append(row.article);
		}

		updateReviewedImageRow(row, image, review.sequence, locked);
	}

	for (const [id, row] of reviewedImageRows) {
		if (!presentIds.has(id)) {
			row.article.remove();
			reviewedImageRows.delete(id);
		}
	}
}

function historyTime(timestamp) {
	return new Date(timestamp).toLocaleString([], {dateStyle: 'medium', timeStyle: 'short'});
}

function videoTime(seconds) {
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds - (minutes * 60);
	return `${String(minutes).padStart(2, '0')}:${remainder.toFixed(3).padStart(6, '0')}`;
}

function appendHistoryDetail(chat, isRequesting) {
	historyDetail.textContent = '';
	renderedHistoryDeleteButton = undefined;
	renderedHistoryDeleteChatId = undefined;
	if (!chat) {
		historyDetail.textContent = 'Select a chat to inspect its frozen local history.';
		return;
	}

	const heading = document.createElement('h3');
	heading.textContent = chat.title;
	historyDetail.append(heading);
	const deleteActions = document.createElement('div');
	deleteActions.className = 'button-row history-delete-actions';
	const deleteButton = document.createElement('button');
	deleteButton.type = 'button';
	deleteButton.className = 'danger';
	deleteButton.textContent = 'Delete this AI chat';
	deleteButton.disabled = isRequesting;
	renderedHistoryDeleteButton = deleteButton;
	renderedHistoryDeleteChatId = chat.id;
	deleteButton.addEventListener('click', async () => {
		historyDeletionFocusTarget = {chatId: chat.id, scope: 'chat'};
		render(await window.caprineAiAssist.prepareHistoryDeletion('chat', chat.id));
	});
	deleteActions.append(deleteButton);
	historyDetail.append(deleteActions);
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
		const replayActions = document.createElement('div');
		replayActions.className = 'button-row';
		const originalReplay = document.createElement('button');
		originalReplay.type = 'button';
		originalReplay.textContent = 'Regenerate from original context';
		originalReplay.disabled = !interaction.originalReplay.available;
		if (!interaction.originalReplay.available) {
			originalReplay.title = interaction.originalReplay.reason === 'missing-artifacts'
				? 'Original media or artifacts are unavailable for exact replay.'
				: 'Original provider or model metadata is no longer supported.';
		}

		originalReplay.addEventListener('click', async () => {
			render(await window.caprineAiAssist.prepareHistoryReplay(chat.id, interaction.id, 'original'));
		});
		const currentReplay = document.createElement('button');
		currentReplay.type = 'button';
		currentReplay.className = 'secondary';
		currentReplay.textContent = 'Ask again with current conversation context';
		currentReplay.addEventListener('click', async () => {
			render(await window.caprineAiAssist.prepareHistoryReplay(chat.id, interaction.id, 'current'));
			promptInput.focus?.();
		});
		replayActions.append(originalReplay, currentReplay);
		article.append(questionHeading, question, answerHeading, answer, metadata, replayActions);

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

		if (interaction.reviewedTranscripts?.length > 0) {
			const transcriptDetails = document.createElement('details');
			transcriptDetails.className = 'history-reviewed-transcripts';
			const transcriptSummary = document.createElement('summary');
			transcriptSummary.textContent = `Reviewed media transcripts · ${interaction.reviewedTranscripts.length}`;
			transcriptDetails.append(transcriptSummary);
			for (const transcriptItem of interaction.reviewedTranscripts) {
				const heading = document.createElement('h4');
				heading.textContent = `${transcriptItem.kind === 'video' ? 'Video' : 'Voice'} · ${transcriptItem.senderLabel} · ${videoTime(transcriptItem.durationSeconds)} · ${transcriptItem.status === 'included' ? 'Included' : 'Removed before request'}`;
				transcriptDetails.append(heading);
				const transcript = document.createElement('pre');
				transcript.tabIndex = 0;
				const segments = transcriptItem.editedSegments ?? transcriptItem.originalSegments;
				transcript.textContent = `${transcriptItem.editedSegments ? 'Edited transcript' : 'Original transcript'}${transcriptItem.status === 'removed' ? ' (retained in local history only; not sent as context)' : ''}\n${segments.map(segment =>
					`[${videoTime(segment.startSeconds)}–${videoTime(segment.endSeconds)}] ${segment.text}`).join('\n')}`;
				transcriptDetails.append(transcript);
			}

			article.append(transcriptDetails);
		}

		if (interaction.videoArtifact) {
			const video = interaction.videoArtifact;
			const videoDetails = document.createElement('details');
			videoDetails.className = 'history-video-artifact';
			const videoSummary = document.createElement('summary');
			videoSummary.textContent = `Saved video evidence · ${video.coverage} coverage · ${video.sampledFrameCount} sampled frames`;
			videoDetails.append(videoSummary);

			const keyframes = document.createElement('div');
			keyframes.className = 'history-video-keyframes';
			for (const keyframe of video.keyframes) {
				const figure = document.createElement('figure');
				const image = document.createElement('img');
				image.src = keyframe.dataUrl;
				image.alt = `Saved video keyframe at ${videoTime(keyframe.timestampSeconds)}`;
				const caption = document.createElement('figcaption');
				caption.textContent = videoTime(keyframe.timestampSeconds);
				figure.append(image, caption);
				keyframes.append(figure);
			}

			videoDetails.append(keyframes);
			if (video.transcript.length > 0) {
				const transcriptHeading = document.createElement('h4');
				transcriptHeading.textContent = 'Transcript';
				const transcript = document.createElement('pre');
				transcript.tabIndex = 0;
				transcript.textContent = video.transcript.map(segment =>
					`[${videoTime(segment.startSeconds)}–${videoTime(segment.endSeconds)}] ${segment.text}`).join('\n');
				videoDetails.append(transcriptHeading, transcript);
			}

			if (video.timeline.length > 0) {
				const timelineHeading = document.createElement('h4');
				timelineHeading.textContent = 'Timeline';
				const timeline = document.createElement('ul');
				for (const event of video.timeline) {
					const item = document.createElement('li');
					item.textContent = `${videoTime(event.startSeconds)}–${videoTime(event.endSeconds)} · ${event.description}`;
					timeline.append(item);
				}

				videoDetails.append(timelineHeading, timeline);
			}

			if (video.uncertaintyNotes.length > 0) {
				const uncertainty = document.createElement('p');
				uncertainty.textContent = `Uncertainty: ${video.uncertaintyNotes.join(' · ')}`;
				videoDetails.append(uncertainty);
			}

			article.append(videoDetails);
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

function renderHistory(history, isConversationReady, isRequesting) {
	const ready = history?.status === 'ready' && isConversationReady;
	historySearchInput.disabled = !ready || isRequesting;
	historySearchButton.disabled = !ready || isRequesting;
	newHistoryChatButton.disabled = !ready || isRequesting;
	clearConversationHistoryButton.disabled = !ready || isRequesting;
	clearAllHistoryButton.disabled = isRequesting;
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

	appendHistoryDetail(history.chats.find(chat => chat.id === history.selectedChatId), isRequesting);
}

function renderHistoryDeletionConfirmation(confirmation) {
	if (!confirmation) {
		if (historyDeletionDialog.open) {
			historyDeletionDialog.close();
		}

		if (renderedHistoryDeletionToken) {
			const focusTarget = historyDeletionFocusTarget?.scope === 'chat'
				&& historyDeletionFocusTarget.chatId === renderedHistoryDeleteChatId
				? renderedHistoryDeleteButton
				: historyDeletionFocusTarget?.element;
			focusFirstAvailable(focusTarget, newHistoryChatButton, closeButton);
		}

		renderedHistoryDeletionToken = undefined;
		historyDeletionFocusTarget = undefined;
		return;
	}

	historyDeletionTitle.textContent = confirmation.title;
	historyDeletionMessage.textContent = confirmation.message;
	confirmHistoryDeletionButton.textContent = confirmation.confirmLabel;
	confirmHistoryDeletionButton.disabled = false;
	if (!historyDeletionDialog.open) {
		historyDeletionDialog.showModal();
	}

	if (renderedHistoryDeletionToken !== confirmation.authorizationToken) {
		renderedHistoryDeletionToken = confirmation.authorizationToken;
		cancelHistoryDeletionButton.focus?.();
	}
}

function render(state) {
	const isRequesting = state.session.status === 'requesting';
	const isReviewLocked = Boolean(state.review?.locked);
	const isConversationReady = state.conversation.status === 'ready';
	const isMediaResolving = state.media.resolution?.status === 'resolving';
	const isContextCapturing = state.contextCapturePending;
	const isImageSelectionBlocked = Boolean(state.review?.imageSelection?.blockingNotice);
	renderHistory(state.history, isConversationReady, isRequesting);
	renderHistoryDeletionConfirmation(state.history.deletionConfirmation);
	renderDiagnostics(state.diagnostics);
	if (shouldClearPrompt(state)) {
		promptInput.value = '';
		promptCaptureGeneration = undefined;
	}

	renderedCaptureGeneration = state.conversation.captureGeneration;
	renderMessageAnchor(state.anchor);
	contextWindow.value = String(state.contextWindowSize);
	webSearchMode.value = state.review?.browsingMode ?? state.webSearchMode;
	renderContextReview(state.review, isRequesting, state.credentials.configured);
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
	const isOriginalHistoryReplay = state.review?.contextSource === 'historical-original';
	const isPreparedVideoReview = state.review?.editable === false && state.videoAnalysis?.status === 'ready';
	const isSavedVideoHistoryReplay = isOriginalHistoryReplay && isPreparedVideoReview;
	promptInput.disabled = isRequesting || isReviewLocked || (isOriginalHistoryReplay && !isSavedVideoHistoryReplay) || !isConversationReady;
	contextWindow.disabled = isRequesting || isContextCapturing || isOriginalHistoryReplay || isPreparedVideoReview || !isConversationReady;
	webSearchMode.disabled = isRequesting || isReviewLocked || isOriginalHistoryReplay || isPreparedVideoReview || !isConversationReady;
	refreshContextButton.disabled = isRequesting || isContextCapturing || isOriginalHistoryReplay || !isConversationReady;
	refreshContextButton.textContent = state.review?.newMessagesAvailable ? 'Refresh context — new messages available' : 'Refresh context';
	if (isReviewLocked) {
		askButton.textContent = 'Asked — Refresh context to ask again';
	} else if (state.review?.editable === false && state.videoAnalysis?.status === 'ready') {
		askButton.textContent = 'Ask another question with prepared video';
	} else {
		askButton.textContent = state.review ? 'Ask with reviewed context' : 'Review context';
	}

	askButton.disabled = isRequesting
		|| isReviewLocked
		|| isContextCapturing
		|| isImageSelectionBlocked
		|| !isConversationReady
		|| Boolean(state.review && !state.credentials.configured);
	if (isOriginalHistoryReplay) {
		if (renderedOriginalReplaySequence !== state.review.sequence) {
			renderedOriginalReplaySequence = state.review.sequence;
			const replayFocusTarget = askButton.disabled
				? (apiKeyInput.disabled ? closeButton : apiKeyInput)
				: askButton;
			focusFirstAvailable(replayFocusTarget, closeButton);
		}
	} else {
		renderedOriginalReplaySequence = undefined;
	}

	cancelButton.disabled = !isRequesting && !isMediaResolving && !isContextCapturing;
	requestMessage.textContent = state.request.error?.message ?? state.request.notice ?? '';
	requestMessage.classList.toggle('error', Boolean(state.request.error));
	renderAnswer(state);
	renderVideoAnalysis(state);
	renderedInsertion = state.request.insertion;
	insertAnswerButton.disabled = !renderedInsertion || !state.request.answer || !isConversationReady;
	if (!initialFocusApplied) {
		initialFocusApplied = true;
		// Initial focus must not expand a disclosure just to reach its controls.
		const initialFocusTarget = promptInput.disabled ? contextReviewSummary : promptInput;
		initialFocusTarget.focus?.();
	}
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

clearConversationHistoryButton.addEventListener('click', async () => {
	historyDeletionFocusTarget = {element: clearConversationHistoryButton, scope: 'conversation'};
	render(await window.caprineAiAssist.prepareHistoryDeletion('conversation'));
});

clearAllHistoryButton.addEventListener('click', async () => {
	historyDeletionFocusTarget = {element: clearAllHistoryButton, scope: 'all'};
	render(await window.caprineAiAssist.prepareHistoryDeletion('all'));
});

confirmHistoryDeletionButton.addEventListener('click', async () => {
	const token = renderedHistoryDeletionToken;
	if (!token) {
		return;
	}

	confirmHistoryDeletionButton.disabled = true;
	render(await window.caprineAiAssist.confirmHistoryDeletion(token));
});

cancelHistoryDeletionButton.addEventListener('click', async () => {
	const token = renderedHistoryDeletionToken;
	if (token) {
		render(await window.caprineAiAssist.cancelHistoryDeletion(token));
	}
});

historyDeletionDialog.addEventListener('cancel', async event => {
	event.preventDefault();
	const token = renderedHistoryDeletionToken;
	if (token) {
		render(await window.caprineAiAssist.cancelHistoryDeletion(token));
	}
});

copyDiagnosticsButton.addEventListener('click', async () => {
	const copySequence = diagnosticsCopySequence;
	if (!copySequence) {
		return;
	}

	copyDiagnosticsButton.disabled = true;
	diagnosticsCopyStatus.textContent = 'Copying redacted diagnostics…';
	try {
		render(await window.caprineAiAssist.copyDiagnostics(copySequence));
		diagnosticsCopyStatus.textContent = 'Redacted diagnostics copied.';
	} catch {
		diagnosticsCopyStatus.textContent = 'Diagnostics changed before they could be copied. Try again.';
	} finally {
		copyDiagnosticsButton.disabled = false;
	}
});

closeButton.addEventListener('click', async () => {
	await window.caprineAiAssist.close();
});

window.caprineAiAssist.onStateChanged(render);
window.caprineAiAssist.getState().then(render).catch(() => {
	statusElement.textContent = 'AI Assist is unavailable. Close and reopen the panel.';
});
