'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
	DiagnosticsCopyAuthorization,
	formatAiAssistDiagnostics,
	isAiAssistDiagnostics,
} = require('../dist-js/ai-assist-diagnostics.js');

function diagnostics(overrides = {}) {
	return {
		aiEnabled: true,
		contextAdapter: 'degraded',
		copySequence: 7,
		historyDatabase: 'unavailable',
		lastMediaError: 'unsupported',
		lastProviderError: 'authentication',
		messengerConversation: 'degraded',
		openAiKey: 'missing',
		panel: 'loaded',
		videoTools: {ffmpeg: 'missing', ffprobe: 'available'},
		...overrides,
	};
}

test('diagnostics accepts fixed non-sensitive failure states and rejects unknown or arbitrary fields', () => {
	assert.equal(isAiAssistDiagnostics(diagnostics()), true);
	assert.equal(isAiAssistDiagnostics(diagnostics({openAiKey: 'sk-private'})), false);
	assert.equal(isAiAssistDiagnostics(diagnostics({contextAdapter: 'raw DOM failed at Alice'})), false);
	assert.equal(isAiAssistDiagnostics({...diagnostics(), messengerText: 'private message'}), false);
	assert.equal(isAiAssistDiagnostics({...diagnostics(), filePath: '/Users/person/private'}), false);
	assert.equal(isAiAssistDiagnostics(diagnostics({lastProviderError: 'x'.repeat(10_000)})), false);
	assert.equal(isAiAssistDiagnostics(diagnostics({videoTools: {ffmpeg: '/opt/homebrew/bin/ffmpeg', ffprobe: 'available'}})), false);
});

test('copy summary is fixed, redacted, and contains only bounded statuses and error codes', () => {
	const summary = formatAiAssistDiagnostics(diagnostics());
	for (const expected of [
		'OpenAI key: missing',
		'Context adapter: degraded',
		'ffmpeg: missing',
		'ffprobe: available',
		'History database: unavailable',
		'Last provider error: authentication',
		'Last media error: unsupported',
	]) {
		assert.ok(summary.includes(expected));
	}

	for (const forbidden of ['sk-', 'Authorization', 'https://', '/Users/', 'Messenger text', 'AI answer']) {
		assert.equal(summary.includes(forbidden), false);
	}
});

test('diagnostics copy authorization is one-shot and rejects stale or replayed sequences', () => {
	const authorization = new DiagnosticsCopyAuthorization();
	assert.equal(authorization.current, 1);
	assert.equal(authorization.consume(2), false);
	assert.equal(authorization.consume(1), true);
	assert.equal(authorization.consume(1), false);
	assert.equal(authorization.current, 2);
	authorization.advance();
	assert.equal(authorization.consume(2), false);
	assert.equal(authorization.consume(3), true);
});
