import {Box, Text, useBoxMetrics, type DOMElement} from 'ink';
import {useRef} from 'react';
import {wrapText} from './Transcript.js';

/**
 * Wrapped prose. Ink's own wrapping keeps the space at a line break, which shows up as a stray
 * leading space on the next line; this measures the available width and wraps with trimming instead.
 */
export function Paragraph({children, color}: {children: string; color?: string}) {
	const ref = useRef<DOMElement>(null);
	const {width, hasMeasured} = useBoxMetrics(ref);
	return (
		// Full width but never flex-grown or shrunk: in a column, growing would squeeze the rows above it to nothing.
		<Box ref={ref} flexDirection="column" width="100%" flexShrink={0}>
			{hasMeasured && width > 0 ? (
				<Text color={color} wrap="truncate">
					{wrapText(children, width).join('\n')}
				</Text>
			) : (
				<Text color={color} wrap="wrap">
					{children}
				</Text>
			)}
		</Box>
	);
}
