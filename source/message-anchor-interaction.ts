type MessageAnchorShortcut = {
	altKey: boolean;
	code: string;
	ctrlKey: boolean;
	metaKey: boolean;
	shiftKey: boolean;
};

type MessageAnchorRectangle = {
	bottom: number;
	height: number;
	left: number;
	right: number;
	top: number;
	width: number;
};

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
