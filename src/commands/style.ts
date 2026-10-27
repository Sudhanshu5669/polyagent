import {styleText} from 'node:util';

type Format = Parameters<typeof styleText>[0];

/** styleText already drops colors for NO_COLOR, non-TTY streams and dumb terminals. */
const make = (format: Format) => (text: string) => styleText(format, text, {stream: process.stdout});

export const s = {
	bold: make('bold'),
	dim: make('dim'),
	ok: make('green'),
	fail: make('red'),
	warn: make('yellow'),
	accent: make('cyan'),
};
