const assert = require('node:assert/strict');
const test = require('node:test');
const {
	buildOpenAiInput,
	OpenAiClient,
	OpenAiRequestError,
	openAiAnswerCharacterLimit,
	openAiImageAggregateByteLimit,
	openAiImageCountLimit,
	openAiResponseModel,
	openAiSourceLimit,
} = require('../dist-js/openai-client.js');

function outputText(text, annotations) {
	return {
		...(annotations === undefined ? {} : {annotations}),
		text,
		type: 'output_text',
	};
}

function openAiResponse(text, {annotations, searched = false, sources = []} = {}) {
	const output = [];
	if (searched) {
		output.push({
			action: {query: 'current answer', sources, type: 'search'},
			status: 'completed',
			type: 'web_search_call',
		});
	}

	output.push({content: [outputText(text, annotations)], type: 'message'});
	return new Response(JSON.stringify({output}), {
		headers: {'Content-Type': 'application/json'},
		status: 200,
	});
}

async function expectCode(promise, code) {
	await assert.rejects(promise, error => {
		assert.ok(error instanceof OpenAiRequestError);
		assert.equal(error.code, code);
		return true;
	});
}

test('OpenAI input builder preserves text-only requests and ordered reviewed PNG bytes', () => {
	assert.equal(buildOpenAiInput('Text only'), 'Text only');
	assert.deepEqual(buildOpenAiInput('Question', [{
		bytes: Uint8Array.of(1, 2, 3),
		label: 'Received from Alex',
		mimeType: 'image/png',
	}, {
		bytes: Uint8Array.of(4, 5),
		label: 'Sent by you',
		mimeType: 'image/png',
	}]), [{
		content: [
			{text: 'Question', type: 'input_text'},
			{text: 'Reviewed image 1 — Received from Alex', type: 'input_text'},
			// Provider-owned request field names are snake_case.
			// eslint-disable-next-line camelcase
			{image_url: 'data:image/png;base64,AQID', type: 'input_image'},
			{text: 'Reviewed image 2 — Sent by you', type: 'input_text'},
			// Provider-owned request field names are snake_case.
			// eslint-disable-next-line camelcase
			{image_url: 'data:image/png;base64,BAU=', type: 'input_image'},
		],
		role: 'user',
	}]);
});

test('OpenAI input builder revalidates image count, per-image, aggregate, MIME, and labels', () => {
	const image = {
		bytes: Uint8Array.of(1),
		label: 'Reviewed source',
		mimeType: 'image/png',
	};
	assert.throws(
		() => buildOpenAiInput('Question', Array.from({length: openAiImageCountLimit + 1}, () => image)),
		error => error instanceof OpenAiRequestError && error.code === 'input-too-large',
	);
	assert.throws(
		() => buildOpenAiInput('Question', [{...image, bytes: new Uint8Array(openAiImageAggregateByteLimit + 1)}]),
		error => error instanceof OpenAiRequestError && error.code === 'input-too-large',
	);
	assert.throws(
		() => buildOpenAiInput('Question', [{...image, mimeType: 'image/jpeg'}]),
		error => error instanceof OpenAiRequestError && error.code === 'input-too-large',
	);
	assert.throws(
		() => buildOpenAiInput('Question', [{...image, label: ' '}]),
		error => error instanceof OpenAiRequestError && error.code === 'input-too-large',
	);
});

test('OpenAI client submits exact multimodal input only when reviewed images are supplied', async () => {
	const bodies = [];
	const client = new OpenAiClient({
		async fetchImplementation(_url, options) {
			bodies.push(JSON.parse(options.body));
			return openAiResponse('Private answer');
		},
	});
	await client.createResponse('sk-private', 'Text only', 'off');
	await client.createResponse('sk-private', 'With image', 'off', {
		images: [{
			bytes: Uint8Array.of(9, 8, 7),
			label: 'Received from Alex',
			mimeType: 'image/png',
		}],
	});
	assert.equal(bodies[0].input, 'Text only');
	assert.deepEqual(bodies[1].input[0].content, [
		{text: 'With image', type: 'input_text'},
		{text: 'Reviewed image 1 — Received from Alex', type: 'input_text'},
		// Provider-owned request field names are snake_case.
		// eslint-disable-next-line camelcase
		{image_url: 'data:image/png;base64,CQgH', type: 'input_image'},
	]);
});

test('OpenAI client maps Always, Auto, and Off to the only supported hosted tool', async () => {
	const requests = [];
	const client = new OpenAiClient({
		async fetchImplementation(url, options) {
			const body = JSON.parse(options.body);
			requests.push({body, options, url});
			return openAiResponse('Private answer', {searched: body.tools !== undefined});
		},
	});

	const alwaysAnswer = await client.createResponse('sk-private', 'Always question');
	const autoAnswer = await client.createResponse('sk-private', 'Auto question', 'auto');
	const offAnswer = await client.createResponse('sk-private', 'Off question', 'off');
	assert.equal(alwaysAnswer.text, 'Private answer');
	assert.equal(autoAnswer.webSearch.ran, true);
	assert.equal(offAnswer.webSearch.ran, false);

	for (const {body, options, url} of requests) {
		assert.equal(url, 'https://api.openai.com/v1/responses');
		assert.equal(options.redirect, 'error');
		assert.equal(options.headers.Authorization, 'Bearer sk-private');
		assert.equal(body.model, openAiResponseModel);
		assert.equal(body.store, false);
		assert.equal(body.max_output_tokens, 1024);
	}

	assert.deepEqual(requests[0].body.tools, [{type: 'web_search'}]);
	assert.equal(requests[0].body.tool_choice, 'required');
	assert.equal('include' in requests[0].body, false);
	assert.deepEqual(requests[1].body.tools, [{type: 'web_search'}]);
	assert.equal(requests[1].body.tool_choice, 'auto');
	assert.equal('include' in requests[1].body, false);
	assert.equal('tools' in requests[2].body, false);
	assert.equal('tool_choice' in requests[2].body, false);
	assert.equal('include' in requests[2].body, false);
});

test('Always rejects a response without completed search execution', async () => {
	const client = new OpenAiClient({fetchImplementation: async () => openAiResponse('Unsearched answer')});
	await expectCode(client.createResponse('sk-private', 'Always question'), 'search-required');
});

test('Auto reports actual search use and Off rejects unexpected search output', async () => {
	const searchedClient = new OpenAiClient({fetchImplementation: async () => openAiResponse('Searched', {searched: true})});
	const unsearchedClient = new OpenAiClient({fetchImplementation: async () => openAiResponse('Not searched')});
	const searchedAnswer = await searchedClient.createResponse('sk-private', 'Question', 'auto');
	const unsearchedAnswer = await unsearchedClient.createResponse('sk-private', 'Question', 'auto');
	assert.equal(searchedAnswer.webSearch.ran, true);
	assert.equal(unsearchedAnswer.webSearch.ran, false);
	await expectCode(searchedClient.createResponse('sk-private', 'Question', 'off'), 'malformed-response');

	const unsupportedEvidence = new OpenAiClient({
		fetchImplementation: async () => openAiResponse('Answer [1]', {
			annotations: [{
				// Provider-owned response field names are snake_case.
				// eslint-disable-next-line camelcase
				end_index: 10,
				// eslint-disable-next-line camelcase
				start_index: 7,
				type: 'url_citation',
				url: 'https://example.com',
			}],
		}),
	});
	await expectCode(unsupportedEvidence.createResponse('sk-private', 'Question', 'auto'), 'malformed-response');
});

test('OpenAI client derives sources only from provider citations without parsing prose URLs', async () => {
	const text = '  Current fact [1]. Visit https://not-evidence.example in prose.  ';
	// Provider-owned response field names are snake_case.
	const annotation = {
		// eslint-disable-next-line camelcase
		end_index: 18,
		// eslint-disable-next-line camelcase
		start_index: 15,
		title: 'Evidence title',
		type: 'url_citation',
		url: 'https://evidence.example/source',
	};
	const client = new OpenAiClient({
		fetchImplementation: async () => openAiResponse(text, {
			annotations: [annotation, {...annotation, title: ''}],
			searched: true,
			sources: [
				{title: 'Evidence title', type: 'url', url: 'https://evidence.example/source'},
				{type: 'url', url: 'https://secondary.example/'},
			],
		}),
	});

	const answer = await client.createResponse('sk-private', 'Question');
	assert.equal(answer.text, text);
	assert.deepEqual(answer.webSearch, {
		citations: [{
			contentIndex: 0,
			endIndex: 18,
			outputIndex: 1,
			providerEndIndex: 18,
			providerStartIndex: 15,
			startIndex: 15,
			title: 'Evidence title',
			url: 'https://evidence.example/source',
		}, {
			contentIndex: 0,
			endIndex: 18,
			outputIndex: 1,
			providerEndIndex: 18,
			providerStartIndex: 15,
			startIndex: 15,
			url: 'https://evidence.example/source',
		}],
		mode: 'always',
		ran: true,
		sources: [
			{title: 'Evidence title', url: 'https://evidence.example/source'},
		],
	});
	assert.equal(answer.webSearch.sources.some(source => source.url.includes('not-evidence')), false);
});

test('OpenAI client translates part-local citation offsets while retaining provider offsets', async () => {
	const client = new OpenAiClient({
		fetchImplementation: async () => new Response(JSON.stringify({
			output: [{
				status: 'completed',
				type: 'web_search_call',
			}, {
				content: [outputText('ab\nc'), outputText('XYZ', [{
					// Provider-owned response field names are snake_case.
					// eslint-disable-next-line camelcase
					end_index: 3,
					// eslint-disable-next-line camelcase
					start_index: 0,
					type: 'url_citation',
					url: 'https://example.com/source',
				}])],
				type: 'message',
			}],
		}), {status: 200}),
	});

	const answer = await client.createResponse('sk-private', 'Question');
	assert.equal(answer.text, 'ab\nc\nXYZ');
	assert.deepEqual(answer.webSearch.citations[0], {
		contentIndex: 1,
		endIndex: 8,
		outputIndex: 1,
		providerEndIndex: 3,
		providerStartIndex: 0,
		startIndex: 5,
		url: 'https://example.com/source',
	});
	assert.equal(answer.text.slice(answer.webSearch.citations[0].startIndex, answer.webSearch.citations[0].endIndex), 'XYZ');
});

test('OpenAI client rejects unsupported annotations, malformed offsets, and unsafe citation URLs', async () => {
	const unsupported = new OpenAiClient({
		fetchImplementation: async () => openAiResponse('Answer', {
			annotations: [{type: 'file_citation'}],
			searched: true,
		}),
	});
	await expectCode(unsupported.createResponse('sk-private', 'Question'), 'unsupported-annotation');

	const malformedOffset = new OpenAiClient({
		fetchImplementation: async () => openAiResponse('Answer', {
			// Provider-owned response field names are snake_case.
			annotations: [{
				// eslint-disable-next-line camelcase
				end_index: 99,
				// eslint-disable-next-line camelcase
				start_index: 0,
				type: 'url_citation',
				url: 'https://example.com',
			}],
			searched: true,
		}),
	});
	await expectCode(malformedOffset.createResponse('sk-private', 'Question'), 'malformed-response');

	const unsafeUrl = new OpenAiClient({
		fetchImplementation: async () => openAiResponse('Answer', {
			annotations: [{
				// Provider-owned response field names are snake_case.
				// eslint-disable-next-line camelcase
				end_index: 6,
				// Provider-owned response field names are snake_case.
				// eslint-disable-next-line camelcase
				start_index: 0,
				type: 'url_citation',
				url: 'https://user:secret@example.com/source',
			}],
			searched: true,
		}),
	});
	await expectCode(unsafeUrl.createResponse('sk-private', 'Question'), 'malformed-response');
});

test('OpenAI client ignores excessive supplemental sources without retrying the provider', async () => {
	let requestCount = 0;
	const text = 'Answer [1]';
	const client = new OpenAiClient({
		async fetchImplementation() {
			requestCount++;
			return openAiResponse(text, {
				annotations: [{
					// Provider-owned response field names are snake_case.
					// eslint-disable-next-line camelcase
					end_index: text.length,
					// Provider-owned response field names are snake_case.
					// eslint-disable-next-line camelcase
					start_index: text.length - 3,
					title: 'Cited evidence',
					type: 'url_citation',
					url: 'https://evidence.example/source',
				}],
				searched: true,
				sources: Array.from({length: openAiSourceLimit + 1}, (_, index) => ({
					title: `Supplemental ${index}`,
					type: 'url',
					url: `https://supplemental.example/${index}`,
				})),
			});
		},
	});

	const answer = await client.createResponse('sk-private', 'Question');
	assert.equal(requestCount, 1);
	assert.deepEqual(answer.webSearch.sources, [{title: 'Cited evidence', url: 'https://evidence.example/source'}]);
});

test('OpenAI client deduplicates cited sources, promotes titles, and bounds only the source list', async () => {
	const text = 'x'.repeat(openAiSourceLimit + 1);
	const annotations = Array.from({length: openAiSourceLimit + 1}, (_, index) => ({
		// Provider-owned response field names are snake_case.
		// eslint-disable-next-line camelcase
		end_index: index + 1,
		// Provider-owned response field names are snake_case.
		// eslint-disable-next-line camelcase
		start_index: index,
		title: index === 0 ? '' : `Source ${index}`,
		type: 'url_citation',
		url: `https://evidence.example/${index}`,
	}));
	annotations.splice(1, 0, {
		// Provider-owned response field names are snake_case.
		// eslint-disable-next-line camelcase
		end_index: 1,
		// Provider-owned response field names are snake_case.
		// eslint-disable-next-line camelcase
		start_index: 0,
		title: 'Promoted title',
		type: 'url_citation',
		url: 'https://evidence.example/0',
	});
	const client = new OpenAiClient({
		fetchImplementation: async () => openAiResponse(text, {annotations, searched: true}),
	});

	const answer = await client.createResponse('sk-private', 'Question');
	assert.equal(answer.webSearch.citations.length, openAiSourceLimit + 2);
	assert.equal(answer.webSearch.sources.length, openAiSourceLimit);
	assert.deepEqual(answer.webSearch.sources[0], {title: 'Promoted title', url: 'https://evidence.example/0'});
	assert.equal(answer.webSearch.sources.some(source => source.url === `https://evidence.example/${openAiSourceLimit}`), false);
});

test('OpenAI client refuses redirects away from the official endpoint', async () => {
	let redirectMode;
	const client = new OpenAiClient({
		async fetchImplementation(_url, options) {
			redirectMode = options.redirect;
			return new Response(null, {headers: {Location: 'https://example.com/collect'}, status: 307});
		},
	});

	await expectCode(client.createResponse('sk-private', 'Private prompt'), 'provider-unavailable');
	assert.equal(redirectMode, 'error');
});

test('OpenAI client maps cancellation and timeout without exposing provider bodies', async () => {
	const waitForAbort = async (_url, options) => new Promise((_resolve, reject) => {
		options.signal.addEventListener('abort', () => {
			reject(new DOMException('aborted', 'AbortError'));
		}, {once: true});
	});
	const client = new OpenAiClient({fetchImplementation: waitForAbort, timeoutMilliseconds: 10});
	const cancellation = new AbortController();
	const cancelledRequest = client.createResponse('sk-private', 'Hello', 'off', cancellation.signal);
	cancellation.abort();
	await expectCode(cancelledRequest, 'cancelled');
	await expectCode(client.createResponse('sk-private', 'Hello', 'off'), 'timeout');
});

test('OpenAI client maps authentication, rate limit, and provider outages', async () => {
	await Promise.all([[401, 'authentication'], [429, 'rate-limit'], [503, 'provider-unavailable']].map(async ([status, code]) => {
		const client = new OpenAiClient({fetchImplementation: async () => new Response('sensitive provider body', {status})});
		await expectCode(client.createResponse('sk-private', 'Hello', 'off'), code);
	}));
});

test('OpenAI client rejects malformed JSON and oversized output', async () => {
	const malformedClient = new OpenAiClient({fetchImplementation: async () => new Response('{not-json', {status: 200})});
	await expectCode(malformedClient.createResponse('sk-private', 'Hello', 'off'), 'malformed-response');

	const oversizedClient = new OpenAiClient({
		fetchImplementation: async () => openAiResponse('x'.repeat(openAiAnswerCharacterLimit + 1)),
	});
	await expectCode(oversizedClient.createResponse('sk-private', 'Hello', 'off'), 'output-too-large');
});
