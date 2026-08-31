type MessageAnchorShortcut = {
	altKey: boolean;
	code: string;
	ctrlKey: boolean;
	metaKey: boolean;
	shiftKey: boolean;
};

export type MessageAnchorRectangle = {
	bottom: number;
	height: number;
	left: number;
	right: number;
	top: number;
	width: number;
};

export function messageAnchorContentRectangle(row: HTMLElement, text?: string): MessageAnchorRectangle {
	const candidates = [...row.querySelectorAll<HTMLElement>('[data-ad-preview="message"], [dir="auto"]')]
		.filter(element => element.textContent === text
			&& !element.closest('blockquote, [data-reply-to-message-id], [aria-label="前往已回覆的訊息"], [aria-label="Go to replied message"]'))
		.map(element => element.getBoundingClientRect())
		.filter(rectangle => rectangle.width > 0 && rectangle.height > 0)
		.sort((a, b) => (a.width * a.height) - (b.width * b.height));
	return candidates[0] ?? row.getBoundingClientRect();
}

export function messageAnchorPosition(
	message: MessageAnchorRectangle,
	conversation: MessageAnchorRectangle,
	viewport: {width: number; height: number},
	button: {width: number; height: number},
): {left: number; top: number} | undefined {
	const leftEdge = Math.max(8, conversation.left + 8);
	const rightEdge = Math.min(viewport.width - 8, conversation.right - 8);
	if (!isMessageAnchorRectangleVisible(message, viewport.width, viewport.height) || rightEdge - leftEdge < button.width) {
		return;
	}

	const preferredLeft = message.right + button.width + 8 <= rightEdge
		? message.right + 8 : message.left - button.width - 8;
	return {
		left: Math.max(leftEdge, Math.min(preferredLeft, rightEdge - button.width)),
		top: Math.max(8, Math.min(message.top + 4, viewport.height - button.height - 8)),
	};
}

export function isWithinMessageAnchorBridge(
	point: {x: number; y: number},
	message: MessageAnchorRectangle,
	button: MessageAnchorRectangle,
): boolean {
	return point.x >= Math.min(message.left, button.left) && point.x <= Math.max(message.right, button.right)
		&& point.y >= Math.min(message.top, button.top) && point.y <= Math.max(message.bottom, button.bottom);
}

export function isMessageAnchorShortcut(shortcut: MessageAnchorShortcut): boolean {
	return shortcut.code === 'KeyA'
		&& shortcut.altKey
		&& !shortcut.ctrlKey
		&& !shortcut.metaKey
		&& !shortcut.shiftKey;
}

export function isMessageAnchorRectangleVisible(
	rectangle: MessageAnchorRectangle,
	viewportWidth: number,
	viewportHeight: number,
): boolean {
	return rectangle.width > 0
		&& rectangle.height > 0
		&& rectangle.right > 0
		&& rectangle.bottom > 0
		&& rectangle.left < viewportWidth
		&& rectangle.top < viewportHeight;
}
