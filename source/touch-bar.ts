import {TouchBar, nativeImage} from 'electron';
import config from './config';
import {sendAction, getWindow} from './util';
import {caprineIconPath} from './constants';
import {answerTrustedRenderer} from './trusted-ipc';
import {isConversationList} from './ipc-validation';

const {TouchBarButton} = TouchBar;
const MAX_VISIBLE_LENGTH = 25;
const privateModeTouchBarLabel: Electron.TouchBarButton = new TouchBarButton({
	label: 'Private mode enabled',
	icon: nativeImage.createFromPath(caprineIconPath),
	iconPosition: 'left',
});

function setTouchBar(items: Electron.TouchBarButton[]): void {
	const touchBar = new TouchBar({items});
	const win = getWindow();
	win.setTouchBar(touchBar);
}

function createLabel(label: string): string {
	if (label.length > MAX_VISIBLE_LENGTH) {
		// If the label is too long, we'll render a truncated one with "…" appended
		return `${label.slice(0, MAX_VISIBLE_LENGTH)}…`;
	}

	return label;
}

function createTouchBarButton({label, selected, icon}: Conversation, index: number): Electron.TouchBarButton {
	return new TouchBarButton({
		label: createLabel(label),
		backgroundColor: selected ? '#0084ff' : undefined,
		icon: nativeImage.createFromDataURL(icon),
		iconPosition: 'left',
		click() {
			sendAction('jump-to-conversation', index + 1);
		},
	});
}

answerTrustedRenderer<unknown, void>(getWindow(), 'conversations', value => {
	if (!isConversationList(value)) {
		throw new TypeError('Invalid payload for privileged IPC channel: conversations');
	}

	const conversations = value;
	if (config.get('privateMode')) {
		setTouchBar([privateModeTouchBarLabel]);
	} else {
		setTouchBar(conversations.map((conversation, index) => createTouchBarButton(conversation, index)));
	}
});
