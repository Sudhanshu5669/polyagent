import {Text, useAnimation} from 'ink';
import {theme} from '../theme.js';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function Spinner({color = theme.accent}: {color?: string}) {
	const {frame} = useAnimation({interval: 80});
	return <Text color={color}>{FRAMES[frame % FRAMES.length]}</Text>;
}
