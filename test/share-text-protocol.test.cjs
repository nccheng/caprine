const assert = require('node:assert/strict');
const test = require('node:test');
const {
	caprineAiShareAnswerCharacterLimit,
	caprineAiShareAssistantLabel,
	caprineAiShareModelLabelCharacterLimit,
	caprineAiShareProtocolVersion,
	caprineAiShareQuestionCharacterLimit,
	caprineAiShareSharerLabel,
	caprineAiShareSourceLimit,
	formatCaprineAiShareText,
	parseCaprineAiShareText,
} = require('../dist-js/share-text-protocol.js');

const basicInput = (overrides = {}) => ({
	answer: 'A complete private answer.',
	modelLabel: 'gpt-5.6-luna',
	question: 'What happened?',
	sources: [],
	...overrides,
});

test('caprine-ai/1 round trips unsearched and searched answers as readable plain text', () => {
	const unsearchedText = formatCaprineAiShareText(basicInput());
	assert.match(unsearchedText, /^<<< caprine-ai\/1 >>>\nCaprine AI Assist\nAI response shared by Derek\n/);
	assert.match(unsearchedText, /--- Question ---\nWhat happened\?\n--- Answer ---\nA complete private answer\./);
	assert.match(unsearchedText, /--- Sources \(0\) ---\n<<< \/caprine-ai\/1 >>>$/);
	assert.deepEqual(parseCaprineAiShareText(unsearchedText), {
		answer: 'A complete private answer.',
		displayMetadata: {
			assistantLabel: caprineAiShareAssistantLabel,
			modelLabel: 'gpt-5.6-luna',
			sharerLabel: caprineAiShareSharerLabel,
		},
		protocolVersion: caprineAiShareProtocolVersion,
		question: 'What happened?',
		sources: [],
	});

	const searched = basicInput({
		answer: 'Current answer [1].',
		sources: [
			{title: 'Primary evidence', url: 'https://example.com/one'},
			{url: 'https://example.com/two'},
		],
	});
	assert.deepEqual(parseCaprineAiShareText(formatCaprineAiShareText(searched)), {
		answer: searched.answer,
		displayMetadata: {
			assistantLabel: caprineAiShareAssistantLabel,
			modelLabel: searched.modelLabel,
			sharerLabel: caprineAiShareSharerLabel,
		},
		protocolVersion: caprineAiShareProtocolVersion,
		question: searched.question,
		sources: searched.sources,
	});
});

test('caprine-ai/1 normalizes newline variants deterministically', () => {
	const text = formatCaprineAiShareText(basicInput({
		answer: 'first\rsecond\r\nthird',
		question: 'line one\r\nline two',
	}));
	assert.equal(text.includes('\r'), false);
	const parsed = parseCaprineAiShareText(text.replaceAll('\n', '\r\n'));
	assert.equal(parsed.question, 'line one\nline two');
	assert.equal(parsed.answer, 'first\nsecond\nthird');
});

test('HTML, Markdown, and code blocks remain inert readable answer text', () => {
	const answer = '<b>not HTML</b>\n**not rendered Markdown**\n```js\nalert(1)\n```';
	const text = formatCaprineAiShareText(basicInput({answer}));
	assert.equal(parseCaprineAiShareText(text).answer, answer);
	assert.match(text, /<b>not HTML<\/b>/);
});

test('formatter rejects marker injection, controls, bidi overrides, invalid URLs, and oversized fields', () => {
	const invalidInputs = [
		basicInput({answer: 'before\n--- Answer ---\nafter'}),
		basicInput({question: 'before\n<<< /caprine-ai/1 >>>\nafter'}),
		basicInput({answer: 'nul\0byte'}),
		basicInput({answer: 'C1\u0085control'}),
		basicInput({answer: 'Arabic\u061Cmark'}),
		basicInput({answer: 'bidi\u202Eoverride'}),
		basicInput({answer: 'line\u2028<<< /caprine-ai/1 >>>'}),
		basicInput({modelLabel: 'line\nbreak'}),
		basicInput({modelLabel: 'm'.repeat(caprineAiShareModelLabelCharacterLimit + 1)}),
		basicInput({question: 'q'.repeat(caprineAiShareQuestionCharacterLimit + 1)}),
		basicInput({answer: 'a'.repeat(caprineAiShareAnswerCharacterLimit + 1)}),
		basicInput({sources: [{url: 'http://example.com'}]}),
		basicInput({sources: [{url: 'https://user:password@example.com'}]}),
		basicInput({sources: Array.from({length: caprineAiShareSourceLimit + 1}, () => ({url: 'https://example.com'}))}),
	];
	for (const input of invalidInputs) {
		assert.throws(() => formatCaprineAiShareText(input), TypeError);
	}
});

test('parser fails closed for unknown, missing, nested, duplicated, incomplete, and forged payloads', () => {
	const valid = formatCaprineAiShareText(basicInput());
	const malformed = [
		valid.replace('caprine-ai/1', 'caprine-ai/2'),
		valid.replace('--- Answer ---\n', ''),
		valid.replace('--- Answer ---\n', '--- Answer ---\n--- Answer ---\n'),
		valid.replace('A complete private answer.', 'A complete private answer.\n<<< caprine-ai/1 >>>'),
		`${valid}\n<<< /caprine-ai/1 >>>`,
		valid.replace('AI response shared by Derek', 'AI response shared by Mallory'),
		valid.replace('--- Sources (0) ---', '--- Sources (1) ---'),
		valid.slice(0, -10),
		`prefix\n${valid}`,
		'<div>Caprine AI Assist</div>',
		'**AI response shared by Derek**',
		'```\n<<< caprine-ai/1 >>>\n```',
		valid.replace('complete', 'com\u2066plete'),
		valid.replace('complete', 'com\u0085plete'),
		valid.replace('complete', 'com\u061Cplete'),
		valid.replace('complete', 'complete\u2029<<< /caprine-ai/1 >>>'),
		valid.replace('A complete private answer.', 'A complete private answer.\n<<< caprine-ai/ >>>'),
		valid.replace('A complete private answer.', 'A complete private answer.\n--- Sources (x) ---'),
		valid.replace('A complete private answer.', 'A complete private answer.\n--- Sources ((x)) ---'),
		valid.replace('A complete private answer.', 'A complete private answer.\n--- Sources (x ---'),
	];
	for (const text of malformed) {
		assert.equal(parseCaprineAiShareText(text), undefined);
	}
});

test('source grammar and fixed bounds reject malformed or excessive source text', () => {
	const valid = formatCaprineAiShareText(basicInput({
		sources: [{title: 'Evidence', url: 'https://example.com/source'}],
	}));
	for (const text of [
		valid.replace('1. Title: Evidence', '2. Title: Evidence'),
		valid.replace('   URL: https://', 'URL: https://'),
		valid.replace('https://example.com/source', `java${'script'}:alert(1)`),
		valid.replace('--- Sources (1) ---', '--- Sources (01) ---'),
		valid.replace('--- Sources (1) ---', '--- Sources (999) ---'),
	]) {
		assert.equal(parseCaprineAiShareText(text), undefined);
	}
});

test('unsupported payloads remain untouched ordinary text', () => {
	const ordinaryText = 'AI response shared by someone else\nThis is ordinary Messenger text.';
	assert.equal(parseCaprineAiShareText(ordinaryText), undefined);
	assert.equal(ordinaryText, 'AI response shared by someone else\nThis is ordinary Messenger text.');
});
