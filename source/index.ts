import path from 'node:path';
import {readFileSync, existsSync, promises as fs} from 'node:fs';
import {exec} from 'node:child_process';
import process from 'node:process';
import {
	app,
	nativeImage,
	screen as electronScreen,
	session,
	shell,
	BrowserWindow,
	Menu,
	Notification,
	MenuItemConstructorOptions,
	systemPreferences,
	nativeTheme,
} from 'electron';
import {ipcMain as ipc} from 'electron-better-ipc';
import electronDl from 'electron-dl';
import electronContextMenu from 'electron-context-menu';
import electronLocalshortcut from 'electron-localshortcut';
import electronDebug from 'electron-debug';
import {is, darkMode} from 'electron-util';
import {bestFacebookLocaleFor} from 'facebook-locales';
import doNotDisturb from '@sindresorhus/do-not-disturb';
import updateAppMenu from './menu';
import config, {StoreType} from './config';
import tray from './tray';
import {
	sendAction,
	sendBackgroundAction,
	messengerDomain,
	stripTrackingFromUrl,
} from './util';
import {process as processEmojiUrl} from './emoji';
import ensureOnline from './ensure-online';
import {setUpMenuBarMode} from './menu-bar-mode';
import {caprineIconPath} from './constants';
import {answerTrustedRenderer} from './trusted-ipc';
import {initializeAiAssist} from './ai-assist';
import {
	externalUrl,
	isConversationList,
	isDownloadRequest,
	isEmojiStyle,
	isMessageCount,
	isNotificationRequest,
	isTrustedMessengerOrigin,
	isZoomFactor,
} from './ipc-validation';

ipc.setMaxListeners(100);

electronDebug({
	isEnabled: true, // TODO: This is only enabled to allow `Command+R` because facebook.com sometimes gets stuck after computer waking up
	showDevTools: false,
});

electronDl();
electronContextMenu({
	showCopyImageAddress: true,
	prepend(defaultActions) {
		/*
		TODO: Use menu option or use replacement of options (https://github.com/sindresorhus/electron-context-menu/issues/70)
		See explanation for this hacky solution here: https://github.com/sindresorhus/caprine/pull/1169
		*/
		defaultActions.copyLink({
			transform: stripTrackingFromUrl,
		});

		return [];
	},
});

app.setAppUserModelId('com.nccheng.caprine');

if (!config.get('hardwareAcceleration')) {
	app.disableHardwareAcceleration();
}

let mainWindow: BrowserWindow;
let isQuitting = false;
let previousMessageCount = 0;
let dockMenu: Menu;
let isDNDEnabled = false;

function saveWindowState(): void {
	if (!mainWindow) {
		return;
	}

	const bounds = mainWindow.getNormalBounds();
	const {isMaximized} = config.get('lastWindowState');

	// Validate window dimensions - ensure they're at least minimum size
	// This prevents saving corrupted/invalid window states on Linux
	const validWidth = Math.max(bounds.width, 400);
	const validHeight = Math.max(bounds.height, 200);

	// Get the scale factor of the display where the window is located
	// This is needed to handle HiDPI/fractional scaling on Linux
	const display = electronScreen.getDisplayMatching(bounds);
	const {scaleFactor} = display;

	config.set('lastWindowState', {
		x: bounds.x,
		y: bounds.y,
		width: validWidth,
		height: validHeight,
		isMaximized,
		scaleFactor,
	});
}

if (!app.requestSingleInstanceLock()) {
	app.quit();
}

app.on('second-instance', () => {
	if (mainWindow) {
		if (mainWindow.isMinimized()) {
			mainWindow.restore();
		}

		mainWindow.show();
	}
});

// Preserves the window position when a display is removed and Caprine is moved to a different screen.
app.on('ready', () => {
	electronScreen.on('display-removed', () => {
		const [x, y] = mainWindow.getPosition();
		mainWindow.setPosition(x, y);
	});
});

async function updateBadge(messageCount: number): Promise<void> {
	// Close all notifications when all messages are read to clear GNOME dock badge
	if (messageCount === 0 && notifications.size > 0) {
		for (const [id, notification] of notifications) {
			notification.close();
			notifications.delete(id);
		}
	}

	if (!is.windows) {
		app.badgeCount = (config.get('showUnreadBadge') && !isDNDEnabled) ? messageCount : 0;

		if (
			is.macos
			&& !isDNDEnabled
			&& config.get('bounceDockOnMessage')
			&& previousMessageCount !== messageCount
		) {
			app.dock!.bounce('informational');
		}
	}

	if (!is.macos) {
		tray.setBadge(config.get('showUnreadBadge') ? messageCount > 0 : false);

		if (config.get('flashWindowOnMessage')) {
			// Only flash when there are new unread messages (count increased from previous)
			// This prevents repeated flashing from DOM mutations without new messages
			const hasNewMessages = messageCount > previousMessageCount;

			if (hasNewMessages) {
				mainWindow.flashFrame(true);
			} else if (messageCount === 0) {
				// Reset flash state when all messages are read
				mainWindow.flashFrame(false);
			}
		}
	}

	tray.update(messageCount);

	if (is.windows) {
		if (!config.get('showUnreadBadge') || messageCount === 0) {
			mainWindow.setOverlayIcon(null, '');
		} else {
			// Delegate drawing of overlay icon to renderer process
			updateOverlayIcon(await ipc.callRenderer(mainWindow, 'render-overlay-icon', messageCount));
		}
	}

	// Update previousMessageCount for next comparison
	// This is used to detect new messages vs repeated DOM mutations
	previousMessageCount = messageCount;
}

function updateOverlayIcon({data, text}: {data: string; text: string}): void {
	const img = nativeImage.createFromDataURL(data);
	mainWindow.setOverlayIcon(img, text);
}

function updateTitlebar(messageCount: number): void {
	if (!config.get('showUnreadCountOnTitlebar') || messageCount === 0) {
		mainWindow.setTitle(app.name);
	} else {
		mainWindow.setTitle(`(${messageCount}) ${app.name}`);
	}
}

type BeforeSendHeadersResponse = {
	cancel?: boolean;
	requestHeaders?: Record<string, string>;
};

type OnSendHeadersDetails = {
	id: number;
	url: string;
	method: string;
	webContentsId?: number;
	resourceType: string;
	referrer: string;
	timestamp: number;
	requestHeaders: Record<string, string>;
};

function enableHiresResources(): void {
	const scaleFactor = Math.max(
		...electronScreen.getAllDisplays().map(display => display.scaleFactor),
	);

	if (scaleFactor === 1) {
		return;
	}

	const filter = {urls: [`*://*.${messengerDomain}/`]};

	session.defaultSession.webRequest.onBeforeSendHeaders(
		filter,
		(details: OnSendHeadersDetails, callback: (response: BeforeSendHeadersResponse) => void) => {
			let cookie = details.requestHeaders.Cookie;

			if (cookie && details.method === 'GET') {
				cookie = /(?:; )?dpr=\d/.test(cookie) ? cookie.replace(/dpr=\d/, `dpr=${scaleFactor}`) : `${cookie}; dpr=${scaleFactor}`;

				(details.requestHeaders as any).Cookie = cookie;
			}

			callback({
				cancel: false,
				requestHeaders: details.requestHeaders,
			});
		},
	);
}

function initRequestsFiltering(): void {
	const filter = {
		urls: [
			`*://*.${messengerDomain}/*typ.php*`, // Type indicator blocker
			`*://*.${messengerDomain}/*change_read_status.php*`, // Seen indicator blocker
			`*://*.${messengerDomain}/*delivery_receipts*`, // Delivery receipts indicator blocker
			`*://*.${messengerDomain}/*unread_threads*`, // Delivery receipts indicator blocker
			'*://*.fbcdn.net/images/emoji.php/v9/*', // Emoji
			'*://*.facebook.com/images/emoji.php/v9/*', // Emoji
		],
	};

	session.defaultSession.webRequest.onBeforeRequest(filter, async ({url}, callback) => {
		if (url.includes('emoji.php')) {
			callback(await processEmojiUrl(url));
		} else if (url.includes('typ.php')) {
			callback({cancel: config.get('block.typingIndicator' as any)});
		} else if (url.includes('change_read_status.php')) {
			callback({cancel: config.get('block.chatSeen' as any)});
		} else if (url.includes('delivery_receipts') || url.includes('unread_threads')) {
			callback({cancel: config.get('block.deliveryReceipt' as any)});
		}
	});

	session.defaultSession.webRequest.onHeadersReceived({
		urls: ['*://static.xx.fbcdn.net/rsrc.php/*'],
	}, ({responseHeaders}, callback) => {
		if (!config.get('callRingtoneMuted') || !responseHeaders) {
			callback({});
			return;
		}

		const callRingtoneHash = '2NAu/QVqg211BbktgY5GkA==';
		callback({
			cancel: responseHeaders['content-md5'][0] === callRingtoneHash,
		});
	});
}

function setUserLocale(): void {
	const userLocale = bestFacebookLocaleFor(app.getLocale().replace('-', '_'));
	const cookie = {
		url: 'https://www.facebook.com/',
		name: 'locale',
		secure: true,
		value: userLocale,
	};

	session.defaultSession.cookies.set(cookie);
}

function configurePermissionHandlers(): void {
	const allowedPermissions = new Set(['fullscreen', 'media', 'notifications']);
	const isAllowed = (permission: string, requestingUrl: string): boolean =>
		allowedPermissions.has(permission) && (
			requestingUrl === 'about:blank'
			|| requestingUrl === 'about:blank#blocked'
			|| isTrustedMessengerOrigin(requestingUrl)
		);

	session.defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) =>
		isAllowed(permission, requestingOrigin),
	);

	session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
		const requestingUrl = details.requestingUrl || webContents.getURL();
		callback(isAllowed(permission, requestingUrl));
	});
}

async function openExternalUrl(url: unknown): Promise<void> {
	const validatedUrl = externalUrl(url);
	if (validatedUrl) {
		await shell.openExternal(validatedUrl);
	}
}

function invalidIpcPayload(channel: string): never {
	throw new TypeError(`Invalid payload for privileged IPC channel: ${channel}`);
}

function requireNoIpcPayload(channel: string, value: unknown): void {
	if (value !== undefined) {
		invalidIpcPayload(channel);
	}
}

function truncateUtf8(value: string, maximumBytes: number): string {
	let result = value;
	while (Buffer.byteLength(result) > maximumBytes) {
		result = result.slice(0, -1);
	}

	return result;
}

function downloadFilename(requestedFilename: string): string {
	const filename = path.basename(requestedFilename.trim()) || 'download';
	const extension = truncateUtf8(path.extname(filename), 32);
	const name = truncateUtf8(path.basename(filename, path.extname(filename)), 200 - Buffer.byteLength(extension));
	return `${name || 'download'}${extension}`;
}

function setNotificationsMute(status: boolean): void {
	const label = 'Mute Notifications';
	const muteMenuItem = Menu.getApplicationMenu()!.getMenuItemById('mute-notifications')!;

	config.set('notificationsMuted', status);
	muteMenuItem.checked = status;

	if (is.macos) {
		const item = dockMenu.items.find(x => x.label === label);
		item!.checked = status;
	}
}

function createMainWindow(): BrowserWindow {
	const lastWindowState = config.get('lastWindowState');

	// Messenger or Work Chat
	const mainURL = config.get('useWorkChat')
		? 'https://work.facebook.com/chat'
		: 'https://www.facebook.com/messages/';

	// Determine background color based on theme to prevent flash of white
	const theme = config.get('theme');
	const shouldUseDarkColors = theme === 'dark' || (theme === 'system' && nativeTheme.shouldUseDarkColors);
	const backgroundColor = shouldUseDarkColors ? '#1e1e1e' : undefined;

	// Handle HiDPI/fractional scaling on Linux
	// getNormalBounds() returns logical pixels (scaled by display scale factor)
	// We need to convert saved logical pixels to physical pixels, then to current display's logical pixels
	let windowWidth = lastWindowState.width;
	let windowHeight = lastWindowState.height;

	if (is.linux && lastWindowState.scaleFactor) {
		// Get the display where the window will be created
		const display = electronScreen.getDisplayNearestPoint({
			x: lastWindowState.x ?? 0,
			y: lastWindowState.y ?? 0,
		});
		const currentScaleFactor = display.scaleFactor;
		const savedScaleFactor = lastWindowState.scaleFactor;

		if (savedScaleFactor !== currentScaleFactor) {
			// Convert: saved_logical * saved_scale / current_scale = current_logical
			// This maintains the same physical pixel size
			windowWidth = Math.round((windowWidth * savedScaleFactor) / currentScaleFactor);
			windowHeight = Math.round((windowHeight * savedScaleFactor) / currentScaleFactor);
		}
	}

	const win = new BrowserWindow({
		title: app.name,
		show: false,
		x: lastWindowState.x,
		y: lastWindowState.y,
		width: windowWidth,
		height: windowHeight,
		icon: is.linux ? caprineIconPath : undefined,
		minWidth: 400,
		minHeight: 200,
		alwaysOnTop: config.get('alwaysOnTop'),
		titleBarStyle: 'hiddenInset',
		trafficLightPosition: {
			x: 18,
			y: 16,
		},
		autoHideMenuBar: config.get('autoHideMenuBar'),
		backgroundColor,
		webPreferences: {
			preload: path.join(__dirname, 'preload/browser.js'),
			contextIsolation: true,
			nodeIntegration: false,
			nodeIntegrationInSubFrames: false,
			nodeIntegrationInWorker: false,
			sandbox: true,
			spellcheck: config.get('isSpellCheckerEnabled'),
			plugins: true,
			webviewTag: false,
		},
	});

	setUserLocale();
	initRequestsFiltering();

	let previousDarkMode = darkMode.isEnabled;
	darkMode.onChange(() => {
		if (darkMode.isEnabled !== previousDarkMode) {
			previousDarkMode = darkMode.isEnabled;
			ipc.callRenderer(win, 'set-theme');
		}
	});

	if (is.macos) {
		win.setSheetOffset(40);
	}

	win.loadURL(mainURL);

	win.on('close', event => {
		if (config.get('quitOnWindowClose')) {
			app.quit();
			return;
		}

		// Workaround for https://github.com/electron/electron/issues/20263
		// Closing the app window when on full screen leaves a black screen
		// Exit fullscreen before closing
		if (is.macos && mainWindow.isFullScreen()) {
			mainWindow.once('leave-full-screen', () => {
				mainWindow.hide();
			});
			mainWindow.setFullScreen(false);
		}

		if (!isQuitting) {
			event.preventDefault();

			// Workaround for https://github.com/electron/electron/issues/10023
			win.blur();
			if (is.macos) {
				// On macOS we're using `app.hide()` in order to focus the previous window correctly
				app.hide();
			} else {
				win.hide();
			}
		}
	});

	win.on('focus', () => {
		if (config.get('flashWindowOnMessage')) {
			// This is a security in the case where messageCount is not reset by page title update
			win.flashFrame(false);
		}
	});

	win.on('resize', () => {
		saveWindowState();
	});

	win.on('maximize', () => {
		config.set('lastWindowState.isMaximized', true);
	});

	win.on('unmaximize', () => {
		config.set('lastWindowState.isMaximized', false);
	});

	return win;
}

(async () => {
	await Promise.all([ensureOnline(), app.whenReady()]);
	await updateAppMenu();
	configurePermissionHandlers();
	mainWindow = createMainWindow();
	registerMainIpcHandlers();
	initializeAiAssist(mainWindow);

	if (is.windows) {
		const jumpToConversationMatch = process.argv.find(argument => /^--jump-to-conversation=\d+$/.test(argument));
		if (jumpToConversationMatch) {
			const conversationIndex = Number.parseInt(jumpToConversationMatch.split('=')[1], 10);
			await ipc.callRenderer(mainWindow, 'jump-to-conversation', conversationIndex);
		}
	}

	// Workaround for https://github.com/electron/electron/issues/5256
	electronLocalshortcut.register(mainWindow, 'CommandOrControl+=', () => {
		sendAction('zoom-in');
	});

	// Start in menu bar mode if enabled, otherwise start normally
	setUpMenuBarMode(mainWindow);

	if (is.macos) {
		const firstItem: MenuItemConstructorOptions = {
			label: 'Mute Notifications',
			type: 'checkbox',
			visible: is.development,
			checked: false,
			async click(menuItem) {
				setNotificationsMute(await ipc.callRenderer(mainWindow, 'toggle-mute-notifications', {checked: menuItem.checked}));
			},
		};

		dockMenu = Menu.buildFromTemplate([firstItem]);
		app.dock!.setMenu(dockMenu);

		// Dock icon is hidden initially on macOS
		if (config.get('showDockIcon')) {
			app.dock!.show();
		}

		answerTrustedRenderer<unknown, void>(mainWindow, 'conversations', value => {
			if (!isConversationList(value)) {
				invalidIpcPayload('conversations');
			}

			const conversations = value;
			if (conversations.length === 0) {
				return;
			}

			const items = conversations.slice(0, 10).map(({label, icon}, index) => ({
				label: `${label}`,
				icon: nativeImage.createFromDataURL(icon),
				click() {
					mainWindow.show();
					sendAction('jump-to-conversation', index + 1);
				},
			}));

			app.dock!.setMenu(Menu.buildFromTemplate([firstItem, {type: 'separator'}, ...items]));
		});
	}

	if (is.windows) {
		answerTrustedRenderer<unknown, void>(mainWindow, 'conversations', value => {
			if (!isConversationList(value)) {
				invalidIpcPayload('conversations');
			}

			const conversations = value;
			if (conversations.length === 0) {
				app.setJumpList([]);
				return;
			}

			const recentConversations = conversations.slice(0, 10);
			const tasks = recentConversations.map(({label}, index) => ({
				type: 'task' as const,
				title: label,
				program: process.execPath,
				args: '--jump-to-conversation=' + (index + 1),
				iconPath: caprineIconPath,
				iconIndex: 0,
				description: `Open ${label}`,
			}));

			app.setJumpList([
				{
					type: 'custom',
					name: 'Conversations',
					items: tasks,
				},
			]);
		});
	}

	// Update badge on conversations change
	answerTrustedRenderer<unknown, void>(mainWindow, 'update-tray-icon', async value => {
		if (!isMessageCount(value)) {
			invalidIpcPayload('update-tray-icon');
		}

		await updateBadge(value);
	});

	// Update titlebar on unread count change
	answerTrustedRenderer<unknown, void>(mainWindow, 'update-titlebar-count', value => {
		if (!isMessageCount(value)) {
			invalidIpcPayload('update-titlebar-count');
		}

		updateTitlebar(value);
	});

	enableHiresResources();

	const {webContents} = mainWindow;

	webContents.on('dom-ready', async () => {
		// Set window title to Caprine (or with unread count if feature enabled)
		updateTitlebar(previousMessageCount);

		await updateAppMenu();

		const files = ['browser.css', 'dark-mode.css', 'vibrancy.css', 'code-blocks.css', 'autoplay.css', 'scrollbar.css'];

		const cssPath = path.join(__dirname, '..', 'css');

		for (const file of files) {
			if (existsSync(path.join(cssPath, file))) {
				webContents.insertCSS(readFileSync(path.join(cssPath, file), 'utf8'));
			}
		}

		if (config.get('useWorkChat') && existsSync(path.join(cssPath, 'workchat.css'))) {
			webContents.insertCSS(
				readFileSync(path.join(cssPath, 'workchat.css'), 'utf8'),
			);
		}

		if (existsSync(path.join(app.getPath('userData'), 'custom.css'))) {
			webContents.insertCSS(readFileSync(path.join(app.getPath('userData'), 'custom.css'), 'utf8'));
		}

		if (config.get('launchMinimized') || app.getLoginItemSettings().wasOpenedAsHidden) {
			mainWindow.hide();
			tray.create(mainWindow);
		} else {
			if (config.get('lastWindowState').isMaximized) {
				mainWindow.maximize();
			}

			mainWindow.show();
		}

		if (is.macos) {
			// TODO: 'update-dnd-mode' is not called
			answerTrustedRenderer<unknown, boolean>(mainWindow, 'update-dnd-mode', async value => {
				if (typeof value !== 'boolean') {
					invalidIpcPayload('update-dnd-mode');
				}

				const initialSoundsValue = value;
				doNotDisturb.on('change', (doNotDisturb: boolean) => {
					isDNDEnabled = doNotDisturb;
					ipc.callRenderer(mainWindow, 'toggle-sounds', {checked: isDNDEnabled ? false : initialSoundsValue});
				});

				isDNDEnabled = await doNotDisturb.isEnabled();

				return isDNDEnabled ? false : initialSoundsValue;
			});
		}

		ipc.callRenderer(mainWindow, 'toggle-message-buttons', config.get('showMessageButtons'));

		await webContents.executeJavaScript(
			readFileSync(path.join(__dirname, 'notifications-isolated.js'), 'utf8'),
		);

		if (is.macos) {
			await import('./touch-bar');
		}
	});

	webContents.setWindowOpenHandler(details => {
		if (
			details.disposition === 'new-window'
			&& (details.url === 'about:blank' || details.url === 'about:blank#blocked')
			&& details.frameName !== 'about:blank'
		) {
			// Voice/video call popup
			// Its preload does not call the main process, so privileged IPC remains scoped to the Messenger window.
			return {
				action: 'allow',
				overrideBrowserWindowOptions: {
					show: true,
					titleBarStyle: 'default',
					webPreferences: {
						contextIsolation: true,
						nodeIntegration: false,
						nodeIntegrationInSubFrames: false,
						nodeIntegrationInWorker: false,
						preload: path.join(__dirname, 'preload/browser-call.js'),
						sandbox: true,
						webviewTag: false,
					},
				},
			};
		}

		void openExternalUrl(stripTrackingFromUrl(details.url));
		return {action: 'deny'};
	});

	webContents.on('will-navigate', async (event, url) => {
		const isFacebookMessages = (url: string): boolean => {
			const {hostname, pathname} = new URL(url);
			if (hostname !== 'www.facebook.com' && hostname !== 'web.facebook.com') {
				return false;
			}

			// Allow root path for login flow, but we'll redirect to /messages after
			if (pathname === '/' || pathname === '') {
				return true;
			}

			return (
				pathname.startsWith('/messages')
				|| pathname.startsWith('/login')
				|| pathname.startsWith('/checkpoint')
				|| pathname.startsWith('/two_step_verification')
				|| pathname.startsWith('/logout')
			);
		};

		const isWorkChat = (url: string): boolean => {
			const {hostname, pathname} = new URL(url);

			if (hostname === 'work.facebook.com' || hostname === 'work.workplace.com') {
				return true;
			}

			if (
				// Example: https://company-name.facebook.com/login or
				//   		https://company-name.workplace.com/login
				(hostname.endsWith('.facebook.com') || hostname.endsWith('.workplace.com'))
				&& (pathname.startsWith('/login') || pathname.startsWith('/chat'))
			) {
				return true;
			}

			if (hostname === 'login.microsoftonline.com') {
				return true;
			}

			return false;
		};

		if (isFacebookMessages(url) || isWorkChat(url)) {
			return;
		}

		event.preventDefault();
		await openExternalUrl(url);
	});

	// Redirect from Facebook homepage to /messages after login
	webContents.on('did-navigate', (_event, url) => {
		const {hostname, pathname} = new URL(url);
		if ((hostname === 'www.facebook.com' || hostname === 'web.facebook.com') && (pathname === '/' || pathname === '')) {
			// Redirect to messages page after a short delay to allow any login process to complete
			setTimeout(() => {
				webContents.loadURL('https://www.facebook.com/messages/');
			}, 500);
		}
	});
})();

function toggleMaximized(): void {
	if (mainWindow.isMaximized()) {
		mainWindow.unmaximize();
	} else {
		mainWindow.maximize();
	}
}

app.on('activate', () => {
	if (mainWindow) {
		mainWindow.show();
	}
});

app.on('before-quit', () => {
	isQuitting = true;

	// Save window state before quitting
	saveWindowState();

	if (is.windows) {
		app.setJumpList([]);
	}
});

// Handle Linux shutdown signals - SIGTERM is sent during logout/shutdown
if (is.linux) {
	process.on('SIGTERM', () => {
		saveWindowState();
		app.quit();
	});

	process.on('SIGHUP', () => {
		saveWindowState();
		app.quit();
	});
}

const MAX_ACTIVE_NOTIFICATIONS = 100;
const MAX_DOWNLOAD_NAME_ATTEMPTS = 10_000;
const notifications = new Map<number, Notification>();

function registerMainIpcHandlers(): void {
	const answerNoPayload = <ReturnType>(channel: string, callback: () => ReturnType | PromiseLike<ReturnType>): void => {
		answerTrustedRenderer<unknown, ReturnType>(mainWindow, channel, value => {
			requireNoIpcPayload(channel, value);
			return callback();
		});
	};

	if (is.macos) {
		answerNoPayload('set-vibrancy', () => {
			mainWindow.setBackgroundColor('#80FFFFFF'); // Transparent, workaround for vibrancy issue.
			mainWindow.setVibrancy('sidebar');
		});
	}

	answerNoPayload('titlebar-doubleclick', () => {
		if (is.macos) {
			const doubleClickAction = systemPreferences.getUserDefault('AppleActionOnDoubleClick', 'string');

			if (doubleClickAction === 'Minimize') {
				mainWindow.minimize();
			} else if (doubleClickAction === 'Maximize') {
				toggleMaximized();
			}
		} else {
			toggleMaximized();
		}
	});

	answerTrustedRenderer<unknown, void>(mainWindow, 'open-external', async value => {
		const url = externalUrl(value);
		if (!url) {
			invalidIpcPayload('open-external');
		}

		await shell.openExternal(url);
	});

	answerNoPayload('navigate-to-chats', () => {
		mainWindow.webContents.loadURL('https://www.facebook.com/messages/');
	});

	answerTrustedRenderer<unknown, void>(mainWindow, 'save-blob-file', async value => {
		if (!isDownloadRequest(value)) {
			invalidIpcPayload('save-blob-file');
		}

		const filename = downloadFilename(value.filename);
		const downloadsDirectory = path.resolve(app.getPath('downloads'));
		const {name, ext} = path.parse(filename);
		let savePath: string | undefined;

		for (let counter = 0; counter < MAX_DOWNLOAD_NAME_ATTEMPTS; counter++) {
			const candidate = counter === 0 ? filename : `${name} (${counter})${ext}`;
			const candidatePath = path.resolve(downloadsDirectory, candidate);
			if (path.dirname(candidatePath) !== downloadsDirectory) {
				invalidIpcPayload('save-blob-file');
			}

			try {
				// Retrying sequentially is required to preserve exclusive creation without a check/write race.
				// eslint-disable-next-line no-await-in-loop
				await fs.writeFile(candidatePath, Buffer.from(value.data), {flag: 'wx'});
				savePath = candidatePath;
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
					throw error;
				}
			}
		}

		if (!savePath) {
			throw new Error('Could not allocate a unique Downloads filename');
		}

		shell.showItemInFolder(savePath);
	});

	answerTrustedRenderer<unknown, void>(mainWindow, 'notification', value => {
		if (!isNotificationRequest(value)) {
			invalidIpcPayload('notification');
		}

		const {id, title, body = '', icon, silent} = value;
		// Don't send notifications when the window is focused
		if (mainWindow.isFocused()) {
			return;
		}

		// Close existing notification with the same ID if present (prevents duplicates on GNOME/Linux)
		if (notifications.has(id)) {
			notifications.get(id)!.close();
			notifications.delete(id);
		}

		// Skip notification if notifications are muted
		if (config.get('notificationsMuted')) {
			return;
		}

		if (!notifications.has(id) && notifications.size >= MAX_ACTIVE_NOTIFICATIONS) {
			throw new Error('Too many active notifications');
		}

		const notificationIcon = nativeImage.createFromDataURL(icon);
		if (notificationIcon.isEmpty()) {
			invalidIpcPayload('notification');
		}

		const notification = new Notification({
			title,
			body: config.get('notificationMessagePreview') ? body : 'You have a new message',
			hasReply: true,
			icon: notificationIcon,
			silent: silent || is.linux || is.macos,
		});

		notifications.set(id, notification);

		notification.on('click', () => {
			sendAction('notification-callback', {callbackName: 'onclick', id});

			notifications.delete(id);
		});

		notification.on('reply', (_event, reply: string) => {
			// We use onclick event used by messenger to go to the right convo
			sendBackgroundAction('notification-reply-callback', {callbackName: 'onclick', id, reply});

			notifications.delete(id);
		});

		notification.on('close', () => {
			sendBackgroundAction('notification-callback', {callbackName: 'onclose', id});
			notifications.delete(id);
		});

		if (!silent) {
			const appPath = app.getAppPath();
			const isAsar = appPath.includes('.asar');
			const basePath = isAsar ? appPath.replace('.asar', '.asar.unpacked') : appPath;
			const soundPath = path.join(basePath, 'static', 'sounds', 'messenger-notification.mp3');

			if (is.macos) {
				// On macOS, use afplay with the custom sound file
				exec(`afplay "${soundPath}"`);
			} else if (is.linux) {
				// On Linux, try GStreamer (most universal), then PulseAudio/paplay, then ALSA/aplay
				exec(`gst-play-1.0 --no-interactive --quiet "${soundPath}" 2>/dev/null || paplay "${soundPath}" 2>/dev/null || aplay "${soundPath}"`);
			} else if (is.windows) {
				// On Windows, use PowerShell with Windows Media Player
				exec(`powershell -c Add-Type -AssemblyName presentationCore; $player = New-Object system.windows.media.mediaplayer; $player.open('${soundPath}'); $player.Play(); Start-Sleep -s $player.NaturalDuration.TimeSpan.TotalSeconds`);
			}
		}

		notification.show();
	});

	answerNoPayload<StoreType['useWorkChat']>('get-config-useWorkChat', () => config.get('useWorkChat'));
	answerNoPayload<StoreType['showMessageButtons']>('get-config-showMessageButtons', () => config.get('showMessageButtons'));
	answerNoPayload<boolean>('get-native-theme-state', () => {
		nativeTheme.themeSource = config.get('theme');
		return nativeTheme.shouldUseDarkColors;
	});
	answerNoPayload<StoreType['privateMode']>('get-config-privateMode', () => config.get('privateMode'));
	answerNoPayload<StoreType['vibrancy']>('get-config-vibrancy', () => config.get('vibrancy'));
	answerNoPayload<StoreType['sidebar']>('get-config-sidebar', () => config.get('sidebar'));
	answerNoPayload<StoreType['zoomFactor']>('get-config-zoomFactor', () => config.get('zoomFactor'));
	answerTrustedRenderer<unknown, void>(mainWindow, 'set-config-zoomFactor', value => {
		if (!isZoomFactor(value)) {
			invalidIpcPayload('set-config-zoomFactor');
		}

		config.set('zoomFactor', value);
	});
	answerNoPayload<StoreType['keepMeSignedIn']>('get-config-keepMeSignedIn', () => config.get('keepMeSignedIn'));
	answerTrustedRenderer<unknown, void>(mainWindow, 'set-config-keepMeSignedIn', value => {
		if (typeof value !== 'boolean') {
			invalidIpcPayload('set-config-keepMeSignedIn');
		}

		config.set('keepMeSignedIn', value);
	});
	answerNoPayload<StoreType['autoplayVideos']>('get-config-autoplayVideos', () => config.get('autoplayVideos'));
	answerNoPayload<StoreType['emojiStyle']>('get-config-emojiStyle', () => config.get('emojiStyle'));
	answerTrustedRenderer<unknown, void>(mainWindow, 'set-config-emojiStyle', value => {
		if (!isEmojiStyle(value)) {
			invalidIpcPayload('set-config-emojiStyle');
		}

		config.set('emojiStyle', value);
	});
}
