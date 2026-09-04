export const maximumFacebookReelPageBytes = 5 * 1024 * 1024;

const trailingUrlPunctuation = /[),.;:!?\]}\u3001\u3002\uFF01\uFF09\uFF0C\uFF1A\uFF1B\uFF1F]+$/u;
const reelPath = /^\/reel\/(\d{5,30})\/?$/u;
const playableUrlKeys = new Map([
	['browser_native_hd_url', 0],
	['playable_url_quality_hd', 1],
	['browser_native_sd_url', 2],
	['playable_url', 3],
	['progressive_url', 4],
]);

function isFacebookHostname(hostname: string): boolean {
	return hostname === 'facebook.com' || hostname.endsWith('.facebook.com');
}

function decodeHtmlEntities(value: string): string {
	return value
		.replaceAll(/&amp;|&#38;|&#x26;/giu, '&')
		.replaceAll(/&quot;|&#34;|&#x22;/giu, '"');
}

function decodePlayableUrl(literal: string): string | undefined {
	let value: unknown;
	try {
		value = JSON.parse(literal);
	} catch {
		return;
	}

	if (typeof value !== 'string' || value.length > 8192) {
		return;
	}

	const decoded = decodeHtmlEntities(value)
		.replaceAll(/\\u([\dA-F]{4})/giu, (_match, hexadecimal: string) => String.fromCodePoint(Number.parseInt(hexadecimal, 16)))
		.replaceAll('\\/', '/');
	return isAllowedFacebookMediaUrl(decoded) ? decoded : undefined;
}

function metaVideoCandidates(html: string): Array<{rank: number; url: string}> {
	const candidates: Array<{rank: number; url: string}> = [];
	for (const match of html.matchAll(/<meta\b[^>]{0,8192}>/giu)) {
		const attributes = new Map<string, string>();
		for (const attribute of match[0].matchAll(/([a-z][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/giu)) {
			attributes.set(attribute[1].toLowerCase(), decodeHtmlEntities(attribute[2] ?? attribute[3] ?? ''));
		}

		const property = (attributes.get('property') ?? attributes.get('name'))?.toLowerCase();
		const url = attributes.get('content');
		if (!url || !['og:video', 'og:video:url', 'og:video:secure_url'].includes(property ?? '') || !isAllowedFacebookMediaUrl(url)) {
			continue;
		}

		candidates.push({rank: property === 'og:video:secure_url' ? 0 : 1, url});
	}

	return candidates;
}

export function normalizeFacebookReelUrl(value: string): string | undefined {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return;
	}

	const match = reelPath.exec(url.pathname);
	if (
		!['http:', 'https:'].includes(url.protocol)
		|| url.username
		|| url.password
		|| !isFacebookHostname(url.hostname.toLowerCase())
		|| !match
	) {
		return;
	}

	return `https://www.facebook.com/reel/${match[1]}`;
}

export function facebookReelId(value: string): string | undefined {
	const normalized = normalizeFacebookReelUrl(value);
	return normalized ? reelPath.exec(new URL(normalized).pathname)?.[1] : undefined;
}

export function containsFacebookReelUrl(text: string): boolean {
	for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/giu)) {
		if (normalizeFacebookReelUrl(match[0].replace(trailingUrlPunctuation, ''))) {
			return true;
		}
	}

	return false;
}

export function isAllowedFacebookMediaUrl(value: string): boolean {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}

	if (url.protocol !== 'https:' || url.username || url.password) {
		return false;
	}

	const hostname = url.hostname.toLowerCase();
	return isFacebookHostname(hostname)
		|| hostname === 'fbcdn.net'
		|| hostname.endsWith('.fbcdn.net')
		|| hostname === 'fbsbx.com'
		|| hostname.endsWith('.fbsbx.com');
}

export function extractFacebookReelVideoUrl(html: string, expectedReelId: string): string | undefined {
	if (
		!/^\d{5,30}$/u.test(expectedReelId)
		|| html.length > maximumFacebookReelPageBytes
		|| !html.includes(expectedReelId)
	) {
		return;
	}

	const candidates = metaVideoCandidates(html).map(candidate => ({...candidate, distance: 0}));
	const documents = [
		html,
		decodeHtmlEntities(html),
		html.replaceAll('\\"', '"'),
	];
	for (const document of documents) {
		let idIndex = document.indexOf(expectedReelId);
		while (idIndex >= 0) {
			const windowStart = Math.max(0, idIndex - 100_000);
			const window = document.slice(windowStart, Math.min(document.length, idIndex + 100_000));
			for (const match of window.matchAll(/"(browser_native_hd_url|playable_url_quality_hd|browser_native_sd_url|playable_url|progressive_url)"\s*:\s*("(?:\\.|[^"\\])*")/giu)) {
				const url = decodePlayableUrl(match[2]);
				if (url) {
					candidates.push({
						distance: Math.abs((windowStart + (match.index ?? 0)) - idIndex),
						rank: playableUrlKeys.get(match[1].toLowerCase()) ?? 5,
						url,
					});
				}
			}

			idIndex = document.indexOf(expectedReelId, idIndex + expectedReelId.length);
		}
	}

	candidates.sort((left, right) => left.rank - right.rank || left.distance - right.distance);
	return candidates[0]?.url;
}
