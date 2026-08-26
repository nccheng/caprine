const assert = require('node:assert/strict');
const test = require('node:test');
const {
	completeReviewedTranscript,
	createReviewedTranscriptItems,
	editReviewedTranscript,
	removeReviewedTranscript,
	reviewedTranscriptExcerpt,
	transcriptDisclosure,
	transcriptFailure,
	updateReviewedTranscript,
} = require('../dist-js/reviewed-transcripts.js');

function voiceItem(id, messageId, displayName = 'Alex') {
	return {
		id,
		item: {
			attachments: [{kind: 'audio'}],
			confidence: 'high',
			messageId,
			sender: {displayName, role: 'incoming'},
		},
	};
}

test('voice context creates exact review items without granting provider consent', () => {
	const items = createReviewedTranscriptItems([
		voiceItem('context-1', 'message-1'),
		{
			id: 'context-2',
			item: {
				confidence: 'high',
				messageId: 'message-2',
				sender: {role: 'outgoing'},
				text: 'Text',
			},
		},
	], messageId => messageId === 'message-1' ? 3.25 : undefined);
	assert.deepEqual(items, [{
		contextItemId: 'context-1',
		durationSeconds: 3.25,
		id: 'transcript:context-1',
		messageId: 'message-1',
		senderLabel: 'Voice message received from Alex',
		status: 'available',
	}]);
	assert.equal(transcriptDisclosure, 'This media will be sent to OpenAI for transcription');
});

test('completed transcripts preserve the original while exact edits become a distinct snapshot', () => {
	const source = createReviewedTranscriptItems([voiceItem('context-1', 'message-1')])[0];
	const completed = completeReviewedTranscript(source, {
		byteLength: 42,
		durationSeconds: 2.5,
		mimeType: 'audio/ogg',
		segments: [
			{endSeconds: 1.25, startSeconds: 0, text: 'First'},
			{endSeconds: 2.5, startSeconds: 1.25, text: 'Second'},
		],
	});
	const edited = editReviewedTranscript(completed, ['Edited first', 'Second']);
	assert.ok(edited);
	assert.equal(edited.originalSegments[0].text, 'First');
	assert.equal(edited.editedSegments[0].text, 'Edited first');
	assert.match(reviewedTranscriptExcerpt(completed), /^Original transcript:/);
	assert.match(reviewedTranscriptExcerpt(edited), /^Edited transcript:/);
	assert.match(reviewedTranscriptExcerpt(edited), /\[00:00\.000–00:01\.250] Edited first/);
	assert.equal(editReviewedTranscript(completed, ['Wrong count']), undefined);
});

test('edit and remove operations target only the selected transcript item', () => {
	const first = createReviewedTranscriptItems([voiceItem('context-1', 'message-1')])[0];
	const second = createReviewedTranscriptItems([voiceItem('context-2', 'message-2')])[0];
	const items = [first, second];
	const updated = updateReviewedTranscript(items, first.id, item => ({...item, status: 'preparing'}));
	assert.ok(updated);
	assert.equal(updated[0].status, 'preparing');
	assert.deepEqual(updated[1], second);
	assert.equal(updateReviewedTranscript(items, 'transcript:stale', item => item), undefined);
	const removed = removeReviewedTranscript({
		...first,
		byteLength: 4,
		mimeType: 'audio/ogg',
		originalSegments: [{endSeconds: 1, startSeconds: 0, text: 'Keep original separately'}],
		status: 'completed',
	});
	assert.equal(removed.status, 'removed');
	assert.equal(removed.originalSegments, undefined);
	assert.equal(second.status, 'available');
});

test('typed provider failures leave retryable text-only transcript states', () => {
	const item = createReviewedTranscriptItems([voiceItem('context-1', 'message-1')])[0];
	assert.equal(transcriptFailure(item, {code: 'cancelled', message: 'Canceled'}).status, 'canceled');
	assert.equal(transcriptFailure(item, {code: 'oversized', message: 'Large'}).status, 'oversized');
	assert.equal(transcriptFailure(item, {code: 'duration-exceeded', message: 'Long'}).status, 'oversized');
	assert.equal(transcriptFailure(item, {code: 'unsupported-media', message: 'Format'}).status, 'unsupported');
	assert.equal(transcriptFailure(item, {code: 'timeout', message: 'Late'}).status, 'timed-out');
	assert.equal(transcriptFailure(item, {code: 'rate-limit', message: 'Busy'}).status, 'failed');
});
