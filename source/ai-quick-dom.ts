// Native Messenger controls observed in English / Traditional Chinese. Unknown
// structures fail closed; no generated class names or private Messenger APIs.
export const quickReplySelector = '[role="button"][aria-label="Reply"], [role="button"][aria-label="Reply to this message"], [role="button"][aria-label="回覆此訊息"]';
const cancelReplySelector = '[role="button"][aria-label="Cancel reply"], [role="button"][aria-label="取消回覆"]';
const quoteJumpSelector = '[role="button"][aria-label="Go to replied message"], [role="button"][aria-label="前往已回覆的訊息"]';

export function quickComposerSurface(composer: HTMLElement): Element | undefined {
	const region = composer.closest('[role="region"]');
	const surface = region?.parentElement;
	return surface && surface.querySelectorAll('[contenteditable="true"]').length === 1
		&& !surface.querySelector('[data-message-id]') ? surface : undefined;
}

export function quickQuotePreview(composer: HTMLElement): Element | undefined {
	const surface = quickComposerSurface(composer);
	const buttons = surface?.querySelectorAll(cancelReplySelector);
	if (buttons?.length !== 1) {
		return undefined;
	}

	const preview = buttons[0].parentElement?.parentElement;
	return preview && preview.parentElement === surface && !preview.contains(composer) ? preview : undefined;
}

export function hasQuickQuote(composer: HTMLElement): boolean {
	const surface = quickComposerSurface(composer);
	return !surface || surface.querySelectorAll(cancelReplySelector).length > 0;
}

export function quickQuoteTextMatches(element: Element, text: string): boolean {
	// Match the complete text, never a truncated preview or a substring.
	return [...element.querySelectorAll('[dir="auto"]')].some(node => node.textContent === text);
}

export function quickHasAttachment(composer: HTMLElement): boolean {
	const surface = quickComposerSurface(composer);
	const quotePreview = quickQuotePreview(composer);
	return !surface || [...surface.querySelectorAll([
		'[data-testid="attachment-preview"]',
		'[data-testid="composer-attachment"]',
		'img',
		'video',
		'audio',
		'[role="progressbar"]',
		'[aria-label*="remove" i]',
		'[aria-label*="移除" i]',
		'[aria-label*="刪除" i]',
	].join(','))].some(element => !quotePreview?.contains(element));
}

export type QuickDomMessage = {id: string; text: string; element: HTMLElement; article: Element};

export function resolveQuickReplyTarget(messages: readonly QuickDomMessage[], id: string): QuickDomMessage | undefined {
	const matches = messages.filter(message => message.id === id);
	return matches.length === 1 ? matches[0] : undefined;
}

export function quickOutgoingMessages(root: Element): QuickDomMessage[] {
	const rows = [...root.querySelectorAll<HTMLElement>('[data-message-id]')];
	if (rows.length > 200) {
		return [];
	}

	return rows.flatMap(element => {
		const id = element.dataset.messageId;
		const label = element.getAttribute('aria-label');
		const text = label?.match(/^at .+?, you:\s?([\s\S]*)$/i)?.[1]
			?? label?.match(/^.+?，你：\s?([\s\S]*)$/)?.[1];
		const article = element.closest('[role="article"]');
		return id && /^[^\s\p{C}]{1,200}$/u.test(id) && text !== undefined
			&& element.dataset.scope === 'messages_table'
			&& article && root.contains(article) && article.querySelectorAll('[data-message-id]').length === 1
			? [{
				id, text, element, article,
			}] : [];
	});
}

export function quickMessageHasQuote(message: QuickDomMessage, question?: string): boolean {
	const quotes = message.article.querySelectorAll(quoteJumpSelector);
	return question === undefined ? quotes.length === 0
		: quotes.length === 1 && quickQuoteTextMatches(quotes[0], question);
}

export function quickObservedMessageIds(
	messages: readonly QuickDomMessage[],
	before: ReadonlySet<string>,
	text: string,
	question?: string,
): string[] {
	// Messenger replaces a numeric optimistic ID with <timestamp>@msgr.<ID>.
	// Wait for a replyable ID; do not hand the disappearing optimistic row to
	// the model/reply phase. Normalize older IDs too, so their acknowledgement
	// cannot be mistaken for this send when the message text is identical.
	const offlineId = (id: string) => /^\d+@msgr\.(\d+)$/.exec(id)?.[1];
	const identity = (id: string) => offlineId(id) ?? id;
	const previous = new Set([...before].map(id => identity(id)));
	const hadPending = [...before].some(id => /^\d+$/.test(id));
	const candidates = messages.filter(message => !previous.has(identity(message.id)) && message.text === text);
	// Mid.* is the other observed native ID format. If an older optimistic
	// row exists, we cannot prove that an unrelated mid.* is new.
	const native = candidates.filter(message => offlineId(message.id) !== undefined || (message.id.startsWith('mid.') && !hadPending));
	const resolved = new Set(native.map(message => identity(message.id)));
	// A pending/unknown row may be this send, while a different native row is
	// syncing from another client. Do not drop that ambiguity. Its quote may
	// also still be hydrating, so wait before applying the native quote check.
	if (candidates.some(message => !resolved.has(identity(message.id)))) {
		return [];
	}

	return native.filter(message => quickMessageHasQuote(message, question)).map(message => message.id);
}
