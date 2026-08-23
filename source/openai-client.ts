export const openAiResponseModel = 'gpt-5.6-luna';
export const openAiPromptCharacterLimit = 20_000;
export const openAiAnswerCharacterLimit = 20_000;

const openAiResponsesEndpoint = 'https://api.openai.com/v1/responses';
const defaultTimeoutMilliseconds = 45_000;

export const openAiErrorCodes = [
	'authentication',
	'cancelled',
	'input-too-large',
	'malformed-response',
	'missing-key',
	'output-too-large',
	'provider-unavailable',
	'rate-limit',
	'timeout',
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

function extractOutputText(value: unknown): string {
	if (typeof value !== 'object' || value === null || !('output' in value) || !Array.isArray(value.output)) {
		throw new OpenAiRequestError('malformed-response', 'OpenAI returned an unreadable response. Try again.');
	}

	const textParts: string[] = [];
	for (const item of value.output) {
		if (typeof item !== 'object' || item === null || !('content' in item) || !Array.isArray(item.content)) {
			continue;
		}

		for (const content of item.content) {
			if (
				typeof content === 'object'
				&& content !== null
				&& 'type' in content
				&& content.type === 'output_text'
				&& 'text' in content
				&& typeof content.text === 'string'
			) {
				textParts.push(content.text);
			}
		}
	}

	const answer = textParts.join('\n').trim();
	if (!answer) {
		throw new OpenAiRequestError('malformed-response', 'OpenAI returned no answer text. Try again.');
	}

	if (answer.length > openAiAnswerCharacterLimit) {
		throw new OpenAiRequestError('output-too-large', 'OpenAI returned an answer that is too large to preview safely.');
	}

	return answer;
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

export class OpenAiClient {
	private readonly fetchImplementation: typeof fetch;
	private readonly timeoutMilliseconds: number;

	constructor(options: OpenAiClientOptions = {}) {
		this.fetchImplementation = options.fetchImplementation ?? fetch;
		this.timeoutMilliseconds = options.timeoutMilliseconds ?? defaultTimeoutMilliseconds;
	}

	async createResponse(apiKey: string, prompt: string, signal?: AbortSignal): Promise<string> {
		if (!apiKey) {
			throw new OpenAiRequestError('missing-key', 'Add an OpenAI API key in Settings first.');
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
					input: prompt,
					max_output_tokens: 1024,
					model: openAiResponseModel,
					reasoning: {effort: 'low'},
					store: false,
					text: {verbosity: 'low'},
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

			return extractOutputText(result);
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
