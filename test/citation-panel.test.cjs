const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const {citationExternalUrl} = require('../dist-js/ipc-validation.js');
const {openCitationExternal} = require('../dist-js/citation-navigation.js');

function citation(startIndex, endIndex, url, title) {
	return {
		contentIndex: 0,
		endIndex,
		outputIndex: 1,
		providerEndIndex: endIndex,
		providerStartIndex: startIndex,
		startIndex,
		...(title === undefined ? {} : {title}),
		url,
	};
}

function loadBuilder() {
	const context = {URL, window: {}};
	vm.runInNewContext(readFileSync('static/ai-assist/citation-view-model.js', 'utf8'), context);
	return context.window.caprineCitationViewModel;
}

function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

test('citation view model distinguishes actual search use without inventing prose sources', () => {
	const {build} = loadBuilder();
	assert.deepEqual(plain(build({
		text: 'No web evidence here: https://example.com/not-evidence',
		webSearch: {
			citations: [],
			mode: 'auto',
			ran: false,
			sources: [{title: 'Ignored', url: 'https://example.com/not-evidence'}],
		},
	})), {
		markers: [],
		sourceCount: 0,
		sources: [],
		status: 'unsearched',
		text: 'No web evidence here: https://example.com/not-evidence',
	});
});

test('citation view model preserves repeated and overlapping spans while deduplicating sources', () => {
	const {build} = loadBuilder();
	const answer = {
		text: 'Alpha beta gamma',
		webSearch: {
			citations: [
				citation(0, 10, 'https://example.com/a', 'Alpha source'),
				citation(6, 16, 'https://example.com/b'),
				citation(0, 5, 'https://example.com/a', 'Repeated title'),
			],
			mode: 'always',
			ran: true,
			sources: [{title: 'Uncited provider source', url: 'https://example.com/uncited'}],
		},
	};
	const before = JSON.stringify(answer);
	const view = build(answer);
	assert.equal(JSON.stringify(answer), before);
	assert.equal(view.status, 'searched');
	assert.deepEqual(plain(view.sources), [
		{number: 1, title: 'Alpha source', url: 'https://example.com/a'},
		{number: 2, url: 'https://example.com/b'},
	]);
	assert.deepEqual(plain(view.markers.map(marker => ({
		endIndex: marker.endIndex,
		sourceNumber: marker.sourceNumber,
		startIndex: marker.startIndex,
	}))), [
		{endIndex: 5, sourceNumber: 1, startIndex: 0},
		{endIndex: 10, sourceNumber: 1, startIndex: 0},
		{endIndex: 16, sourceNumber: 2, startIndex: 6},
	]);
});

test('citation view model tolerates missing or malformed titles and bounds the source list', () => {
	const {build, sourceDisplayLimit} = loadBuilder();
	const text = 'x'.repeat(sourceDisplayLimit + 2);
	const citations = Array.from({length: sourceDisplayLimit + 2}, (_, index) => citation(
		index,
		index + 1,
		`https://example.com/${index}`,
		index === 0 ? {not: 'text'} : undefined,
	));
	const view = build({
		text,
		webSearch: {
			citations,
			mode: 'always',
			ran: true,
			sources: [],
		},
	});
	assert.equal(view.status, 'searched');
	assert.equal(view.sourceCount, sourceDisplayLimit + 2);
	assert.equal(view.sources.length, sourceDisplayLimit);
	assert.equal('title' in view.sources[0], false);
	assert.equal(view.markers.length, sourceDisplayLimit + 2);
});

test('citation view model fails closed for malformed annotations', () => {
	const {build} = loadBuilder();
	for (const badCitation of [
		citation(-1, 3, 'https://example.com'),
		// eslint-disable-next-line no-script-url
		citation(0, 4, 'javascript:alert(1)'),
		citation(0, 4, 'https://user:secret@example.com/path'),
	]) {
		assert.equal(build({
			text: 'text',
			webSearch: {
				citations: [badCitation],
				mode: 'always',
				ran: true,
				sources: [],
			},
		}).status, 'malformed');
	}

	assert.equal(build({
		text: 'text',
		webSearch: {
			citations: [citation(0, 4, 'https://example.com')],
			mode: 'auto',
			ran: false,
			sources: [],
		},
	}).status, 'malformed');
});

test('citation external navigation accepts only credential-free HTTPS URLs', () => {
	assert.equal(citationExternalUrl('https://example.com/source?q=1'), 'https://example.com/source?q=1');
	assert.equal(citationExternalUrl('http://example.com/source'), undefined);
	assert.equal(citationExternalUrl('mailto:reader@example.com'), undefined);
	// eslint-disable-next-line no-script-url
	assert.equal(citationExternalUrl('javascript:alert(1)'), undefined);
	assert.equal(citationExternalUrl('https://user:secret@example.com/source'), undefined);
	assert.equal(citationExternalUrl('not a URL'), undefined);
});

test('citation navigation invokes only the validated external opener', async () => {
	const opened = [];
	await openCitationExternal('https://example.com/source', async url => {
		opened.push(url);
	});
	assert.deepEqual(opened, ['https://example.com/source']);
	await assert.rejects(
		openCitationExternal('https://user:secret@example.com/source', async url => {
			opened.push(url);
		}),
		/unsafe AI Assist citation URL/,
	);
	assert.deepEqual(opened, ['https://example.com/source']);
});
