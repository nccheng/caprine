export const caprineAiShareProtocolVersion = 'caprine-ai/1';
export const caprineAiShareAssistantLabel = 'Caprine AI Assist';
export const caprineAiShareSharerLabel = 'AI response shared by Derek';
export const caprineAiShareQuestionCharacterLimit = 4000;
export const caprineAiShareAnswerCharacterLimit = 20_000;
export const caprineAiShareModelLabelCharacterLimit = 200;
export const caprineAiShareSourceLimit = 10;
export const caprineAiShareSourceTitleCharacterLimit = 300;
export const caprineAiShareUrlCharacterLimit = 2048;
export const caprineAiShareTextCharacterLimit = 50_000;

const startMarker = `<<< ${caprineAiShareProtocolVersion} >>>`;
const endMarker = `<<< /${caprineAiShareProtocolVersion} >>>`;
const questionMarker = '--- Question ---';
const answerMarker = '--- Answer ---';
const sourcesMarkerPattern = /^--- Sources \((0|[1-9]\d*)\) ---$/;
const structuralLinePattern = /^(?:<<< \/?caprine-ai(?:\/[^>]*)? >>>|--- (?:Question|Answer) ---|--- Sources.* ---)$/;
// The protocol rejects ASCII controls at the plain-text trust boundary.
// eslint-disable-next-line no-control-regex
const unsafeCharacterPattern = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028-\u202E\u2066-\u2069\uFEFF]/;

export type CaprineAiShareSource = {
	title?: string;
	url: string;
};

export type CaprineAiShareInput = {
	answer: string;
	modelLabel: string;
	question: string;
	sources: readonly CaprineAiShareSource[];
};

export type ParsedCaprineAiShareText = {
	answer: string;
	displayMetadata: {
		assistantLabel: string;
		modelLabel: string;
		sharerLabel: string;
	};
	protocolVersion: typeof caprineAiShareProtocolVersion;
	question: string;
	sources: CaprineAiShareSource[];
};

function normalizeNewlines(value: string): string {
	return value.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
}

function isSafeText(value: unknown, maximumLength: number, multiline: boolean): value is string {
	return typeof value === 'string'
		&& value.length > 0
		&& value.length <= maximumLength
		&& value.trim().length > 0
		&& !unsafeCharacterPattern.test(value)
		&& (multiline || !value.includes('\n'));
}

function hasStructuralLine(value: string): boolean {
	return value.split('\n').some(line => structuralLinePattern.test(line));
}

function isSafeUrl(value: unknown): value is string {
	if (typeof value !== 'string' || value.length === 0 || value.length > caprineAiShareUrlCharacterLimit || value.includes('\n') || unsafeCharacterPattern.test(value)) {
		return false;
	}

	try {
		const url = new URL(value);
		return url.protocol === 'https:' && !url.username && !url.password;
	} catch {
		return false;
	}
}

function normalizeSource(value: unknown): CaprineAiShareSource | undefined {
	if (typeof value !== 'object' || value === null) {
		return;
	}

	const source = value as Record<string, unknown>;
	if (!Object.keys(source).every(key => key === 'title' || key === 'url') || !isSafeUrl(source.url)) {
		return;
	}

	if (source.title !== undefined && !isSafeText(source.title, caprineAiShareSourceTitleCharacterLimit, false)) {
		return;
	}

	return {
		...(source.title === undefined ? {} : {title: source.title}),
		url: source.url,
	};
}

function normalizeInput(input: Readonly<CaprineAiShareInput>): CaprineAiShareInput {
	const answer = normalizeNewlines(input.answer);
	const modelLabel = normalizeNewlines(input.modelLabel);
	const question = normalizeNewlines(input.question);
	if (
		!isSafeText(answer, caprineAiShareAnswerCharacterLimit, true)
		|| !isSafeText(modelLabel, caprineAiShareModelLabelCharacterLimit, false)
		|| !isSafeText(question, caprineAiShareQuestionCharacterLimit, true)
		|| hasStructuralLine(answer)
		|| hasStructuralLine(modelLabel)
		|| hasStructuralLine(question)
		|| !Array.isArray(input.sources)
		|| input.sources.length > caprineAiShareSourceLimit
	) {
		throw new TypeError('Invalid caprine-ai/1 share input');
	}

	const sources = input.sources.map(source => normalizeSource(source));
	if (sources.includes(undefined)) {
		throw new TypeError('Invalid caprine-ai/1 share source');
	}

	return {
		answer,
		modelLabel,
		question,
		sources: sources as CaprineAiShareSource[],
	};
}

export function formatCaprineAiShareText(input: Readonly<CaprineAiShareInput>): string {
	const {answer, modelLabel, question, sources} = normalizeInput(input);
	const lines = [
		startMarker,
		caprineAiShareAssistantLabel,
		caprineAiShareSharerLabel,
		`Model: ${modelLabel}`,
		questionMarker,
		question,
		answerMarker,
		answer,
		`--- Sources (${sources.length}) ---`,
	];
	for (const [index, source] of sources.entries()) {
		lines.push(
			`${index + 1}. Title: ${source.title ?? ''}`,
			`   URL: ${source.url}`,
		);
	}

	lines.push(endMarker);
	const text = lines.join('\n');
	if (text.length > caprineAiShareTextCharacterLimit) {
		throw new TypeError('caprine-ai/1 share text is too large');
	}

	return text;
}

function parseSources(lines: readonly string[], count: number): CaprineAiShareSource[] | undefined {
	if (count > caprineAiShareSourceLimit || lines.length !== count * 2) {
		return;
	}

	const sources: CaprineAiShareSource[] = [];
	for (let index = 0; index < count; index += 1) {
		const titlePrefix = `${index + 1}. Title: `;
		const urlPrefix = '   URL: ';
		const titleLine = lines[index * 2];
		const urlLine = lines[(index * 2) + 1];
		if (!titleLine.startsWith(titlePrefix) || !urlLine.startsWith(urlPrefix)) {
			return;
		}

		const title = titleLine.slice(titlePrefix.length);
		const source = normalizeSource({
			...(title === '' ? {} : {title}),
			url: urlLine.slice(urlPrefix.length),
		});
		if (!source) {
			return;
		}

		sources.push(source);
	}

	return sources;
}

export function parseCaprineAiShareText(value: unknown): ParsedCaprineAiShareText | undefined {
	if (typeof value !== 'string') {
		return;
	}

	const text = normalizeNewlines(value);
	if (text.length === 0 || text.length > caprineAiShareTextCharacterLimit || unsafeCharacterPattern.test(text)) {
		return;
	}

	const lines = text.split('\n');
	if (
		lines.length < 10
		|| lines[0] !== startMarker
		|| lines.at(-1) !== endMarker
		|| lines[1] !== caprineAiShareAssistantLabel
		|| lines[2] !== caprineAiShareSharerLabel
		|| !lines[3].startsWith('Model: ')
		|| lines[4] !== questionMarker
	) {
		return;
	}

	const answerMarkerIndex = lines.indexOf(answerMarker, 5);
	const sourcesMarkerIndex = lines.findIndex((line, index) => index > answerMarkerIndex && sourcesMarkerPattern.test(line));
	if (
		answerMarkerIndex < 6
		|| sourcesMarkerIndex <= answerMarkerIndex + 1
		|| lines.filter(line => structuralLinePattern.test(line)).length !== 5
	) {
		return;
	}

	const sourcesMatch = sourcesMarkerPattern.exec(lines[sourcesMarkerIndex]);
	const sourceCount = Number(sourcesMatch?.[1]);
	if (!Number.isSafeInteger(sourceCount)) {
		return;
	}

	const modelLabel = lines[3].slice('Model: '.length);
	const question = lines.slice(5, answerMarkerIndex).join('\n');
	const answer = lines.slice(answerMarkerIndex + 1, sourcesMarkerIndex).join('\n');
	const sources = parseSources(lines.slice(sourcesMarkerIndex + 1, -1), sourceCount);
	if (
		!isSafeText(modelLabel, caprineAiShareModelLabelCharacterLimit, false)
		|| !isSafeText(question, caprineAiShareQuestionCharacterLimit, true)
		|| !isSafeText(answer, caprineAiShareAnswerCharacterLimit, true)
		|| sources === undefined
	) {
		return;
	}

	return {
		answer,
		displayMetadata: {
			assistantLabel: caprineAiShareAssistantLabel,
			modelLabel,
			sharerLabel: caprineAiShareSharerLabel,
		},
		protocolVersion: caprineAiShareProtocolVersion,
		question,
		sources,
	};
}
