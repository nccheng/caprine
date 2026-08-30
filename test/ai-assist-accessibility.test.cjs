const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {restoreMessengerComposerFocus} = require('../dist-js/ai-assist-focus.js');

const repositoryRoot = path.join(__dirname, '..');

test('composer focus restoration fails closed for stale, ambiguous, and non-editable targets', () => {
	const composer = {editable: true, focused: false};
	let conversationId = 'messenger-thread:alpha';
	let composers = [composer];
	const adapter = {
		currentConversationId: () => conversationId,
		focus(candidate) {
			candidate.focused = true;
		},
		isEditable: candidate => candidate.editable,
		isFocused: candidate => candidate.focused,
		visibleComposers: () => composers,
	};

	assert.equal(restoreMessengerComposerFocus('messenger-thread:alpha', adapter), true);
	composer.focused = false;
	conversationId = 'messenger-thread:beta';
	assert.equal(restoreMessengerComposerFocus('messenger-thread:alpha', adapter), false);
	assert.equal(composer.focused, false);
	conversationId = 'messenger-thread:alpha';
	composers = [composer, {editable: true, focused: false}];
	assert.equal(restoreMessengerComposerFocus('messenger-thread:alpha', adapter), false);
	composers = [composer];
	composer.editable = false;
	assert.equal(restoreMessengerComposerFocus('messenger-thread:alpha', adapter), false);
});

test('local panel uses native keyboard controls and non-duplicating answer citation semantics', () => {
	const html = readFileSync(path.join(repositoryRoot, 'static', 'ai-assist', 'index.html'), 'utf8');
	const script = readFileSync(path.join(repositoryRoot, 'static', 'ai-assist', 'panel.js'), 'utf8');

	assert.match(html, /<a class="skip-link" href="#main-content">/);
	assert.match(html, /<main id="main-content" tabindex="-1">/);
	assert.match(html, /<details id="settings-details" class="optional-section">\s*<summary><h2 id="settings-heading">Settings<\/h2><\/summary>/);
	assert.match(html, /<details id="diagnostics-details" class="optional-section">\s*<summary><h2 id="diagnostics-heading">Diagnostics<\/h2><\/summary>/);
	assert.match(html, /<details id="history-details" class="optional-section">\s*<summary><h2 id="history-heading">History<\/h2><\/summary>/);
	assert.match(html, /<details id="context-review-details" class="optional-section">\s*<summary><h2 id="context-heading">Context review<\/h2><\/summary>/);
	assert.match(html, /<pre id="answer-output" role="document" aria-label="Private AI answer" tabindex="0">/);
	assert.match(html, /<details id="answer-sources" class="answer-sources" hidden>\s*<summary id="answer-sources-heading">Cited sources<\/summary>/);
	assert.equal(html.includes('role="button"'), false);
	assert.equal(/tabindex="[1-9]/.test(html), false);
	const citationLabelSource = ['button.setAttribute(\'aria-label\', `Open cited source $', '{marker.sourceNumber}`)'].join('');
	const duplicatedEvidenceSource = ['for cited text: $', '{marker.evidence}'].join('');
	assert.equal(script.includes(citationLabelSource), true);
	assert.equal(script.includes(duplicatedEvidenceSource), false);
	assert.equal(script.includes('answerOutput.innerHTML'), false);
});

test('panel and share decoration define narrow reflow, visible focus, and reduced-motion behavior', () => {
	const css = readFileSync(path.join(repositoryRoot, 'static', 'ai-assist', 'panel.css'), 'utf8');
	const decoration = readFileSync(path.join(repositoryRoot, 'source', 'share-message-decoration.ts'), 'utf8');

	assert.match(css, /summary:focus-visible/);
	assert.match(css, /@media \(width < 420px\)/);
	assert.match(css, /\.diagnostics-list,\s*\.field-row,\s*\.media-fields {\s*grid-template-columns: minmax\(0, 1fr\)/);
	assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
	assert.match(css, /transition-duration: 0\.01ms !important/);
	assert.match(decoration, /summary:focus-visible/);
	assert.match(decoration, /@media \(prefers-reduced-motion: reduce\)/);
});
