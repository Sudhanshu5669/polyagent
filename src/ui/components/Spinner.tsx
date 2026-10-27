import {Text, useAnimation} from 'ink';
import {theme} from '../theme.js';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function Spinner() {
	const {frame} = useAnimation({interval: 80});
	return <Text color={theme.accent}>{FRAMES[frame % FRAMES.length]}</Text>;
}
