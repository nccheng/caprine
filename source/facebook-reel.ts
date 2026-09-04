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
const videoIdKeys = new Set(['id', 'video_id', 'videoId', 'videoID']);

function isFacebookHostname(hostname: string): boolean {
	return hostname === 'facebook.com' || hostname.endsWith('.facebook.com');
}

function decodeHtmlEntities(value: string): string {
	return value
		.replaceAll(/&amp;|&#38;|&#x26;/giu, '&')
		.replaceAll(/&quot;|&#34;|&#x22;/giu, '"');
}

function normalizedPlayableUrl(value: unknown): string | undefined {
	if (typeof value !== 'string' || value.length > 8192) {
		return;
	}

	const decoded = decodeHtmlEntities(value).replaceAll('\\/', '/');
	return isAllowedFacebookMediaUrl(decoded) ? decoded : undefined;
}

function jsonDocuments(html: string): unknown[] {
	const documents: unknown[] = [];
	const values = [html.trim()];
	for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/giu)) {
		values.push(match[1].trim());
	}

	for (const value of values) {
		if (!value.startsWith('{') && !value.startsWith('[')) {
			continue;
		}

		try {
			documents.push(JSON.parse(value));
		} catch {}
	}

	return documents;
}

function collectBoundVideoCandidates(
	value: unknown,
	expectedReelId: string,
	candidates: Array<{rank: number; url: string}>,
	budget: {remaining: number},
	depth = 0,
): void {
	if (!value || typeof value !== 'object' || depth > 64 || budget.remaining-- <= 0) {
		return;
	}

	if (Array.isArray(value)) {
		for (const child of value) {
			collectBoundVideoCandidates(child, expectedReelId, candidates, budget, depth + 1);
		}

		return;
	}

	const record = value as Record<string, unknown>;
	const ownsTargetId = Object.entries(record)
		.some(([key, child]) => videoIdKeys.has(key) && String(child) === expectedReelId);
	if (ownsTargetId) {
		for (const [key, rank] of playableUrlKeys) {
			const url = normalizedPlayableUrl(record[key]);
			if (url) {
				candidates.push({rank, url});
			}
		}
	}

	for (const child of Object.values(record)) {
		collectBoundVideoCandidates(child, expectedReelId, candidates, budget, depth + 1);
	}
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
	return facebookReelUrlInText(text) !== undefined;
}

export function facebookReelUrlInText(text: string): string | undefined {
	for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/giu)) {
		const normalized = normalizeFacebookReelUrl(match[0].replace(trailingUrlPunctuation, ''));
		if (normalized) {
			return normalized;
		}
	}

	return undefined;
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

	const candidates: Array<{rank: number; url: string}> = [];
	for (const document of jsonDocuments(html)) {
		collectBoundVideoCandidates(document, expectedReelId, candidates, {remaining: 50_000});
	}

	candidates.sort((left, right) => left.rank - right.rank);
	return candidates[0]?.url;
}
