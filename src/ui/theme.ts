const noColor = Boolean(process.env.NO_COLOR);

/** Colors are undefined under NO_COLOR, so status is always carried by icons + words, never color alone. */
const c = (name: string) => (noColor ? undefined : name);

export const theme = {
	accent: c('cyan'),
	ok: c('green'),
	fail: c('red'),
	warn: c('yellow'),
	muted: c('gray'),
	border: c('gray'),
};

export const icons = {
	ok: '✓',
	fail: '✗',
	warn: '⚠',
	pointer: '›',
	dot: '·',
	branch: '⎇',
};

export const MIN_COLUMNS = 60;
export const MIN_ROWS = 16;
