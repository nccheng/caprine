export const openAiResponseModel = 'gpt-5.6-luna';
export const openAiPromptCharacterLimit = 20_000;
export const openAiAnswerCharacterLimit = 20_000;
export const openAiCitationLimit = 100;
export const openAiSourceLimit = 50;
export const openAiImageCountLimit = 4;
export const openAiImageAggregateByteLimit = 20 * 1024 * 1024;
export const openAiImageByteLimit = 20 * 1024 * 1024;
export const openAiVideoFrameCountLimit = 180;
export const openAiVideoFrameByteLimit = 512 * 1024;
export const openAiVideoFrameAggregateByteLimit = 48 * 1024 * 1024;
export const openAiVideoRequestAggregateByteLimit = openAiVideoFrameAggregateByteLimit + openAiImageAggregateByteLimit;
export const openAiVideoPromptCharacterLimit = 160_000;

export const webSearchModes = ['always', 'auto', 'off'] as const;
export type WebSearchMode = typeof webSearchModes[number];

export type OpenAiUrlCitation = {
	contentIndex: number;
	endIndex: number;
	outputIndex: number;
	providerEndIndex: number;
	providerStartIndex: number;
	startIndex: number;
	title?: string;
	url: string;
};

export type OpenAiWebSource = {
	title?: string;
	url: string;
};

export type OpenAiAnswer = {
	text: string;
	webSearch: {
		citations: OpenAiUrlCitation[];
		mode: WebSearchMode;
		ran: boolean;
		sources: OpenAiWebSource[];
	};
};

export type OpenAiImageInput = {
	bytes: Uint8Array;
	label: string;
	mimeType: 'image/png';
};

export type OpenAiVideoFrameInput = {
	bytes: Uint8Array;
	detail: 'high' | 'low';
	label: string;
	mimeType: 'image/jpeg' | 'image/png';
};

export type OpenAiJsonSchema = {
	name: string;
	schema: Record<string, unknown>;
};

const openAiResponsesEndpoint = 'https://api.openai.com/v1/responses';
const defaultTimeoutMilliseconds = 45_000;
const maximumMetadataTextLength = 2000;
const maximumUrlLength = 2048;

export const openAiErrorCodes = [
	'authentication',
	'cancelled',
	'input-too-large',
	'malformed-response',
	'missing-key',
	'output-too-large',
	'provider-unavailable',
	'rate-limit',
	'search-required',
	'timeout',
	'unsupported-annotation',
] as const;

export type OpenAiErrorCode = typeof openAiErrorCodes[number];

export class OpenAiRequestError extends Error {
	constructor(
		readonly code: OpenAiErrorCode,
		message: string,
	) {
		super(message);
		this.name = 'OpenAiRequestError';
	}
}

type OpenAiClientOptions = {
	fetchImplementation?: typeof fetch;
	timeoutMilliseconds?: number;
};

type OpenAiResponseOptions = {
	images?: ReadonlyArray<Readonly<OpenAiImageInput>>;
	signal?: AbortSignal;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function isBoundedMetadataText(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= maximumMetadataTextLength;
}

function normalizeUrl(value: unknown): string {
	if (typeof value !== 'string' || value.length === 0 || value.length > maximumUrlLength) {
		throw new OpenAiRequestError('malformed-response', 'OpenAI returned malformed web-search metadata. Try again.');
	}

	try {
		const url = new URL(value);
		if (url.protocol !== 'https:' || url.username || url.password) {
			throw new TypeError('Untrusted URL');
		}

		return value;
	} catch {
		throw new OpenAiRequestError('malformed-response', 'OpenAI returned malformed web-search metadata. Try again.');
	}
}

function optionalTitle(value: unknown): string | undefined {
	if (value === undefined || value === '') {
		return;
	}

	if (!isBoundedMetadataText(value)) {
		throw new OpenAiRequestError('malformed-response', 'OpenAI returned malformed web-search metadata. Try again.');
	}

	return value;
}

function extractSources(item: Record<string, unknown>): OpenAiWebSource[] {
	if (!isRecord(item.action) || item.action.sources === undefined) {
		return [];
	}

	if (!Array.isArray(item.action.sources) || item.action.sources.length > openAiSourceLimit) {
		throw new OpenAiRequestError('malformed-response', 'OpenAI returned too many or malformed web-search sources. Try again.');
	}

	return item.action.sources.map(source => {
		if (!isRecord(source) || source.type !== 'url') {
			throw new OpenAiRequestError('malformed-response', 'OpenAI returned malformed web-search source metadata. Try again.');
		}

		const title = optionalTitle(source.title);
		return {
			...(title ? {title} : {}),
			url: normalizeUrl(source.url),
		};
	});
}

function extractOutput(value: unknown, mode: WebSearchMode): OpenAiAnswer {
	if (!isRecord(value) || !Array.isArray(value.output)) {
		throw new OpenAiRequestError('malformed-response', 'OpenAI returned an unreadable response. Try again.');
	}

	const citations: OpenAiUrlCitation[] = [];
	const sources: OpenAiWebSource[] = [];
	const textParts: string[] = [];
	let flattenedTextLength = 0;
	let webSearchRan = false;
	for (const [outputIndex, item] of value.output.entries()) {
		if (!isRecord(item)) {
			continue;
		}

		if (item.type === 'web_search_call') {
			webSearchRan ||= item.status === 'completed';
			sources.push(...extractSources(item));
			if (sources.length > openAiSourceLimit) {
				throw new OpenAiRequestError('malformed-response', 'OpenAI returned too many web-search sources. Try again.');
			}
		}

		if (!Array.isArray(item.content)) {
			continue;
		}

		for (const [contentIndex, content] of item.content.entries()) {
			if (!isRecord(content) || content.type !== 'output_text' || typeof content.text !== 'string') {
				continue;
			}

			const contentStartIndex = flattenedTextLength + (textParts.length > 0 ? 1 : 0);
			textParts.push(content.text);
			flattenedTextLength = contentStartIndex + content.text.length;
			if (content.annotations === undefined) {
				continue;
			}

			if (!Array.isArray(content.annotations) || citations.length + content.annotations.length > openAiCitationLimit) {
				throw new OpenAiRequestError('malformed-response', 'OpenAI returned too many or malformed citations. Try again.');
			}

			for (const annotation of content.annotations) {
				if (!isRecord(annotation) || annotation.type !== 'url_citation') {
					throw new OpenAiRequestError('unsupported-annotation', 'OpenAI returned an unsupported answer annotation. Try again.');
				}

				if (
					!Number.isSafeInteger(annotation.start_index)
					|| !Number.isSafeInteger(annotation.end_index)
					|| (annotation.start_index as number) < 0
					|| (annotation.end_index as number) <= (annotation.start_index as number)
					|| (annotation.end_index as number) > content.text.length
				) {
					throw new OpenAiRequestError('malformed-response', 'OpenAI returned malformed citation offsets. Try again.');
				}

				const title = optionalTitle(annotation.title);
				citations.push({
					contentIndex,
					endIndex: contentStartIndex + (annotation.end_index as number),
					outputIndex,
					providerEndIndex: annotation.end_index as number,
					providerStartIndex: annotation.start_index as number,
					startIndex: contentStartIndex + (annotation.start_index as number),
					...(title ? {title} : {}),
					url: normalizeUrl(annotation.url),
				});
			}
		}
	}

	if (mode === 'always' && !webSearchRan) {
		throw new OpenAiRequestError('search-required', 'OpenAI did not complete the required web search. Nothing was labeled as searched.');
	}

	if (mode === 'off' && webSearchRan) {
		throw new OpenAiRequestError('malformed-response', 'OpenAI unexpectedly returned web-search output while browsing was off.');
	}

	if (!webSearchRan && (citations.length > 0 || sources.length > 0)) {
		throw new OpenAiRequestError('malformed-response', 'OpenAI returned search evidence without a completed web-search call.');
	}

	const text = textParts.join('\n');
	if (!text.trim()) {
		throw new OpenAiRequestError('malformed-response', 'OpenAI returned no answer text. Try again.');
	}

	if (text.length > openAiAnswerCharacterLimit) {
		throw new OpenAiRequestError('output-too-large', 'OpenAI returned an answer that is too large to preview safely.');
	}

	return {
		text,
		webSearch: {
			citations,
			mode,
			ran: webSearchRan,
			sources,
		},
	};
}

export function isOpenAiAnswer(value: unknown): value is OpenAiAnswer {
	if (!isRecord(value) || typeof value.text !== 'string' || value.text.trim().length === 0 || value.text.length > openAiAnswerCharacterLimit || !isRecord(value.webSearch)) {
		return false;
	}

	const answerText = value.text;

	if (!(Object.keys(value).length === 2
		&& Object.keys(value.webSearch).length === 4
		&& webSearchModes.includes(value.webSearch.mode as never)
		&& typeof value.webSearch.ran === 'boolean'
		&& Array.isArray(value.webSearch.citations)
		&& value.webSearch.citations.length <= openAiCitationLimit
		&& Array.isArray(value.webSearch.sources)
		&& value.webSearch.sources.length <= openAiSourceLimit)) {
		return false;
	}

	if ((value.webSearch.mode === 'always' && !value.webSearch.ran) || (value.webSearch.mode === 'off' && value.webSearch.ran)) {
		return false;
	}

	if (!value.webSearch.ran && (value.webSearch.citations.length > 0 || value.webSearch.sources.length > 0)) {
		return false;
	}

	const isSafeNormalizedUrl = (url: unknown): boolean => {
		try {
			normalizeUrl(url);
			return true;
		} catch {
			return false;
		}
	};

	const hasValidTitle = (item: Record<string, unknown>): boolean => item.title === undefined || isBoundedMetadataText(item.title);

	return value.webSearch.sources.every(source => isRecord(source)
		&& Object.keys(source).length === (source.title === undefined ? 1 : 2)
		&& hasValidTitle(source)
		&& isSafeNormalizedUrl(source.url))
		&& value.webSearch.citations.every(citation => isRecord(citation)
			&& Object.keys(citation).length === (citation.title === undefined ? 8 : 9)
			&& hasValidTitle(citation)
			&& Number.isSafeInteger(citation.outputIndex)
			&& (citation.outputIndex as number) >= 0
			&& Number.isSafeInteger(citation.contentIndex)
			&& (citation.contentIndex as number) >= 0
			&& Number.isSafeInteger(citation.startIndex)
			&& (citation.startIndex as number) >= 0
			&& Number.isSafeInteger(citation.endIndex)
			&& (citation.endIndex as number) > (citation.startIndex as number)
			&& (citation.endIndex as number) <= answerText.length
			&& Number.isSafeInteger(citation.providerStartIndex)
			&& (citation.providerStartIndex as number) >= 0
			&& Number.isSafeInteger(citation.providerEndIndex)
			&& (citation.providerEndIndex as number) > (citation.providerStartIndex as number)
			&& isSafeNormalizedUrl(citation.url));
}

function errorForStatus(status: number): OpenAiRequestError {
	if (status === 401 || status === 403) {
		return new OpenAiRequestError('authentication', 'OpenAI rejected the API key. Replace it in Settings.');
	}

	if (status === 429) {
		return new OpenAiRequestError('rate-limit', 'OpenAI is rate limiting requests. Wait a moment and try again.');
	}

	return new OpenAiRequestError('provider-unavailable', 'OpenAI is unavailable right now. Try again later.');
}

function webSearchOptions(mode: WebSearchMode): Record<string, unknown> {
	if (mode === 'off') {
		return {};
	}

	return {
		include: ['web_search_call.action.sources'],
		tool_choice: mode === 'always' ? 'required' : 'auto',
		tools: [{type: 'web_search'}],
	};
}

export function buildOpenAiInput(
	prompt: string,
	images: ReadonlyArray<Readonly<OpenAiImageInput>> = [],
): string | Array<Record<string, unknown>> {
	if (images.length === 0) {
		return prompt;
	}

	if (images.length > openAiImageCountLimit) {
		throw new OpenAiRequestError('input-too-large', `Requests are limited to ${openAiImageCountLimit} reviewed images.`);
	}

	let aggregateBytes = 0;
	const content: Array<Record<string, unknown>> = [{text: prompt, type: 'input_text'}];
	for (const [index, image] of images.entries()) {
		if (
			image.mimeType !== 'image/png'
			|| !(image.bytes instanceof Uint8Array)
			|| image.bytes.byteLength === 0
			|| image.bytes.byteLength > openAiImageByteLimit
			|| !image.label.trim()
			|| image.label.length > maximumMetadataTextLength
		) {
			throw new OpenAiRequestError('input-too-large', 'A reviewed image no longer satisfies the provider input limits.');
		}

		aggregateBytes += image.bytes.byteLength;
		if (aggregateBytes > openAiImageAggregateByteLimit) {
			throw new OpenAiRequestError('input-too-large', `Reviewed images are limited to ${openAiImageAggregateByteLimit / (1024 * 1024)} MB per request.`);
		}

		content.push(
			{text: `Reviewed image ${index + 1} — ${image.label}`, type: 'input_text'},
			{
				image_url: `data:${image.mimeType};base64,${Buffer.from(image.bytes).toString('base64')}`,
				type: 'input_image',
			},
		);
	}

	return [{content, role: 'user'}];
}

export function buildOpenAiVideoInput(
	prompt: string,
	frames: ReadonlyArray<Readonly<OpenAiVideoFrameInput>>,
): Array<Record<string, unknown>> {
	if (frames.length === 0 || frames.length > openAiVideoFrameCountLimit) {
		throw new OpenAiRequestError('input-too-large', `Video analysis requires between 1 and ${openAiVideoFrameCountLimit} sampled frames.`);
	}

	let aggregateBytes = 0;
	const content: Array<Record<string, unknown>> = [{text: prompt, type: 'input_text'}];
	for (const frame of frames) {
		if (
			!['image/jpeg', 'image/png'].includes(frame.mimeType)
			|| !(frame.bytes instanceof Uint8Array)
			|| frame.bytes.byteLength === 0
			|| frame.bytes.byteLength > (frame.mimeType === 'image/jpeg' ? openAiVideoFrameByteLimit : openAiImageByteLimit)
			|| !['high', 'low'].includes(frame.detail)
			|| !frame.label.trim()
			|| frame.label.length > maximumMetadataTextLength
		) {
			throw new OpenAiRequestError('input-too-large', 'A sampled video frame no longer satisfies the provider input limits.');
		}

		aggregateBytes += frame.bytes.byteLength;
		if (aggregateBytes > openAiVideoRequestAggregateByteLimit) {
			throw new OpenAiRequestError('input-too-large', 'Video and reviewed images exceed the 68 MB request limit.');
		}

		content.push(
			{text: frame.label, type: 'input_text'},
			{
				detail: frame.detail,
				image_url: `data:${frame.mimeType};base64,${Buffer.from(frame.bytes).toString('base64')}`,
				type: 'input_image',
			},
		);
	}

	return [{content, role: 'user'}];
}

export class OpenAiClient {
	private readonly fetchImplementation: typeof fetch;
	private readonly timeoutMilliseconds: number;

	constructor(options: OpenAiClientOptions = {}) {
		this.fetchImplementation = options.fetchImplementation ?? fetch;
		this.timeoutMilliseconds = options.timeoutMilliseconds ?? defaultTimeoutMilliseconds;
	}

	async createResponse(
		apiKey: string,
		prompt: string,
		mode: WebSearchMode = 'always',
		signalOrOptions?: AbortSignal | Readonly<OpenAiResponseOptions>,
	): Promise<OpenAiAnswer> {
		const options: Readonly<OpenAiResponseOptions> = signalOrOptions instanceof AbortSignal
			? {signal: signalOrOptions}
			: (signalOrOptions ?? {});
		const {images = [], signal} = options;
		if (!apiKey) {
			throw new OpenAiRequestError('missing-key', 'Add an OpenAI API key in Settings first.');
		}

		if (!webSearchModes.includes(mode)) {
			throw new OpenAiRequestError('malformed-response', 'Select a supported web-search mode.');
		}

		if (!prompt.trim()) {
			throw new OpenAiRequestError('malformed-response', 'Enter a prompt before asking OpenAI.');
		}

		if (prompt.length > openAiPromptCharacterLimit) {
			throw new OpenAiRequestError('input-too-large', `Prompts are limited to ${openAiPromptCharacterLimit.toLocaleString()} characters.`);
		}

		const requestController = new AbortController();
		let timedOut = false;
		const cancelRequest = (): void => {
			requestController.abort();
		};

		if (signal?.aborted) {
			cancelRequest();
		} else {
			signal?.addEventListener('abort', cancelRequest, {once: true});
		}

		const timeout = setTimeout(() => {
			timedOut = true;
			requestController.abort();
		}, this.timeoutMilliseconds);

		try {
			const response = await this.fetchImplementation(openAiResponsesEndpoint, {
				method: 'POST',
				redirect: 'error',
				headers: {
					Authorization: `Bearer ${apiKey}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					input: buildOpenAiInput(prompt, images),
					max_output_tokens: 1024,
					model: openAiResponseModel,
					reasoning: {effort: 'low'},
					store: false,
					text: {verbosity: 'low'},
					...webSearchOptions(mode),
				}),
				signal: requestController.signal,
			});

			if (!response.ok) {
				throw errorForStatus(response.status);
			}

			let result: unknown;
			try {
				result = await response.json();
			} catch {
				throw new OpenAiRequestError('malformed-response', 'OpenAI returned an unreadable response. Try again.');
			}

			return extractOutput(result, mode);
		} catch (error) {
			if (error instanceof OpenAiRequestError) {
				throw error;
			}

			if (signal?.aborted) {
				throw new OpenAiRequestError('cancelled', 'Request cancelled.');
			}

			if (timedOut) {
				throw new OpenAiRequestError('timeout', 'OpenAI took too long to respond. Try again.');
			}

			throw new OpenAiRequestError('provider-unavailable', 'Could not reach OpenAI. Check your connection and try again.');
		} finally {
			clearTimeout(timeout);
			signal?.removeEventListener('abort', cancelRequest);
		}
	}

	async createStructuredVideoTimeline(
		apiKey: string,
		prompt: string,
		frames: ReadonlyArray<Readonly<OpenAiVideoFrameInput>>,
		format: Readonly<OpenAiJsonSchema>,
		signal?: AbortSignal,
	): Promise<unknown> {
		this.validateVideoRequest(apiKey, prompt);
		const value = await this.fetchResponse(apiKey, {
			input: buildOpenAiVideoInput(prompt, frames),
			max_output_tokens: 4096,
			model: openAiResponseModel,
			reasoning: {effort: 'low'},
			store: false,
			text: {
				format: {
					name: format.name,
					schema: format.schema,
					strict: true,
					type: 'json_schema',
				},
				verbosity: 'low',
			},
		}, signal);
		const {text} = extractOutput(value, 'off');
		try {
			return JSON.parse(text) as unknown;
		} catch {
			throw new OpenAiRequestError('malformed-response', 'OpenAI returned an unreadable video timeline. Try again.');
		}
	}

	async createVideoAnswer(
		apiKey: string,
		prompt: string,
		mode: WebSearchMode,
		frames: ReadonlyArray<Readonly<OpenAiVideoFrameInput>>,
		signal?: AbortSignal,
	): Promise<OpenAiAnswer> {
		this.validateVideoRequest(apiKey, prompt);
		if (!webSearchModes.includes(mode)) {
			throw new OpenAiRequestError('malformed-response', 'Select a supported web-search mode.');
		}

		const value = await this.fetchResponse(apiKey, {
			input: buildOpenAiVideoInput(prompt, frames),
			max_output_tokens: 4096,
			model: openAiResponseModel,
			reasoning: {effort: 'low'},
			store: false,
			text: {verbosity: 'low'},
			...webSearchOptions(mode),
		}, signal);
		return extractOutput(value, mode);
	}

	private validateVideoRequest(apiKey: string, prompt: string): void {
		if (!apiKey) {
			throw new OpenAiRequestError('missing-key', 'Add an OpenAI API key in Settings first.');
		}

		if (!prompt.trim()) {
			throw new OpenAiRequestError('malformed-response', 'Enter a prompt before asking OpenAI.');
		}

		if (prompt.length > openAiVideoPromptCharacterLimit) {
			throw new OpenAiRequestError('input-too-large', `Video analysis prompts are limited to ${openAiVideoPromptCharacterLimit.toLocaleString()} characters.`);
		}
	}

	private async fetchResponse(
		apiKey: string,
		body: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<unknown> {
		const requestController = new AbortController();
		let timedOut = false;
		const cancelRequest = (): void => {
			requestController.abort();
		};

		if (signal?.aborted) {
			cancelRequest();
		} else {
			signal?.addEventListener('abort', cancelRequest, {once: true});
		}

		const timeout = setTimeout(() => {
			timedOut = true;
			requestController.abort();
		}, this.timeoutMilliseconds);

		try {
			const response = await this.fetchImplementation(openAiResponsesEndpoint, {
				method: 'POST',
				redirect: 'error',
				headers: {
					Authorization: `Bearer ${apiKey}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(body),
				signal: requestController.signal,
			});

			if (!response.ok) {
				throw errorForStatus(response.status);
			}

			try {
				return await response.json() as unknown;
			} catch {
				throw new OpenAiRequestError('malformed-response', 'OpenAI returned an unreadable response. Try again.');
			}
		} catch (error) {
			if (error instanceof OpenAiRequestError) {
				throw error;
			}

			if (signal?.aborted) {
				throw new OpenAiRequestError('cancelled', 'Request cancelled.');
			}

			if (timedOut) {
				throw new OpenAiRequestError('timeout', 'OpenAI took too long to respond. Try again.');
			}

			throw new OpenAiRequestError('provider-unavailable', 'Could not reach OpenAI. Check your connection and try again.');
		} finally {
			clearTimeout(timeout);
			signal?.removeEventListener('abort', cancelRequest);
		}
	}
}
