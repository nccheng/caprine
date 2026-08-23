export const mediaKinds = ['audio', 'video'] as const;
export type MediaKind = typeof mediaKinds[number];
export const mediaSourceTypes = ['blob', 'https', 'segmented'] as const;
export type MediaSourceType = typeof mediaSourceTypes[number];

export const maximumMediaBytes: Record<MediaKind, number> = {
	audio: 25 * 1024 * 1024,
	video: 200 * 1024 * 1024,
};
