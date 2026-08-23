const assert = require('node:assert/strict');
const test = require('node:test');
const {
	OpenAiClient,
	OpenAiRequestError,
	openAiAnswerCharacterLimit,
	openAiResponseModel,
} = require('../dist-js/openai-client.js');

function openAiResponse(text) {
	return new Response(JSON.stringify({
		output: [{
			content: [{type: 'output_text', text}],
			type: 'message',
		}],
	}), {
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

test('OpenAI client sends a bounded non-stored Responses API request', async () => {
	let request;
	const client = new OpenAiClient({
		async fetchImplementation(url, options) {
			request = {url, options};
			return openAiResponse('Private answer');
		},
	});

	assert.equal(await client.createResponse('sk-private', 'Hello'), 'Private answer');
	assert.equal(request.url, 'https://api.openai.com/v1/responses');
	assert.equal(request.options.headers.Authorization, 'Bearer sk-private');
	const body = JSON.parse(request.options.body);
	assert.equal(body.input, 'Hello');
	assert.equal(body.model, openAiResponseModel);
	assert.equal(body.store, false);
	assert.equal(body.max_output_tokens, 1024);
});

test('OpenAI client maps cancellation and timeout without exposing provider bodies', async () => {
	const waitForAbort = async (_url, options) => new Promise((_resolve, reject) => {
		options.signal.addEventListener('abort', () => {
			reject(new DOMException('aborted', 'AbortError'));
		}, {once: true});
	});
	const client = new OpenAiClient({fetchImplementation: waitForAbort, timeoutMilliseconds: 10});
	const cancellation = new AbortController();
	const cancelledRequest = client.createResponse('sk-private', 'Hello', cancellation.signal);
	cancellation.abort();
	await expectCode(cancelledRequest, 'cancelled');
	await expectCode(client.createResponse('sk-private', 'Hello'), 'timeout');
});

test('OpenAI client maps authentication, rate limit, and provider outages', async () => {
	await Promise.all([[401, 'authentication'], [429, 'rate-limit'], [503, 'provider-unavailable']].map(async ([status, code]) => {
		const client = new OpenAiClient({
			fetchImplementation: async () => new Response('sensitive provider body', {status}),
		});
		await expectCode(client.createResponse('sk-private', 'Hello'), code);
	}));
});

test('OpenAI client rejects malformed JSON and oversized output', async () => {
	const malformedClient = new OpenAiClient({
		fetchImplementation: async () => new Response('{not-json', {status: 200}),
	});
	await expectCode(malformedClient.createResponse('sk-private', 'Hello'), 'malformed-response');

	const oversizedClient = new OpenAiClient({
		fetchImplementation: async () => openAiResponse('x'.repeat(openAiAnswerCharacterLimit + 1)),
	});
	await expectCode(oversizedClient.createResponse('sk-private', 'Hello'), 'output-too-large');
});
