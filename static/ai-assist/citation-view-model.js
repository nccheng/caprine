(() => {
	const sourceDisplayLimit = 12;

	function safeHttpsUrl(value) {
		if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
			return;
		}

		try {
			const url = new URL(value);
			if (url.protocol !== 'https:' || url.username || url.password) {
				return;
			}

			return url.toString();
		} catch {}
	}

	function malformed(text = '') {
		return {
			markers: [],
			sourceCount: 0,
			sources: [],
			status: 'malformed',
			text,
		};
	}

	function build(answer) {
		if (!answer || typeof answer !== 'object' || typeof answer.text !== 'string' || !answer.webSearch || typeof answer.webSearch !== 'object') {
			return malformed();
		}

		const {text, webSearch} = answer;
		if (typeof webSearch.ran !== 'boolean' || !Array.isArray(webSearch.citations)) {
			return malformed(text);
		}

		if (!webSearch.ran && webSearch.citations.length > 0) {
			return malformed(text);
		}

		const sourcesByUrl = new Map();
		const markers = [];
		const markerKeys = new Set();
		for (const citation of webSearch.citations) {
			if (
				!citation
				|| typeof citation !== 'object'
				|| !Number.isSafeInteger(citation.startIndex)
				|| !Number.isSafeInteger(citation.endIndex)
				|| citation.startIndex < 0
				|| citation.endIndex <= citation.startIndex
				|| citation.endIndex > text.length
			) {
				return malformed(text);
			}

			const url = safeHttpsUrl(citation.url);
			if (!url) {
				return malformed(text);
			}

			const title = typeof citation.title === 'string' && citation.title.length > 0 && citation.title.length <= 2000
				? citation.title
				: undefined;
			let source = sourcesByUrl.get(url);
			if (!source) {
				source = {
					number: sourcesByUrl.size + 1,
					...(title ? {title} : {}),
					url,
				};
				sourcesByUrl.set(url, source);
			} else if (!source.title && title) {
				source.title = title;
			}

			const markerKey = `${citation.startIndex}:${citation.endIndex}:${url}`;
			if (markerKeys.has(markerKey)) {
				continue;
			}

			markerKeys.add(markerKey);
			markers.push({
				endIndex: citation.endIndex,
				evidence: text.slice(citation.startIndex, citation.endIndex),
				sourceNumber: source.number,
				startIndex: citation.startIndex,
				url,
			});
		}

		markers.sort((left, right) => left.endIndex - right.endIndex || left.startIndex - right.startIndex || left.sourceNumber - right.sourceNumber);
		const sources = [...sourcesByUrl.values()];
		return {
			markers,
			sourceCount: sources.length,
			sources: sources.slice(0, sourceDisplayLimit),
			status: webSearch.ran ? 'searched' : 'unsearched',
			text,
		};
	}

	window.caprineCitationViewModel = Object.freeze({build, sourceDisplayLimit});
})();
