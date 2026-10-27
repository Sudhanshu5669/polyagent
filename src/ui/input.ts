import {useInput, usePaste} from 'ink';
import {createContext, useContext} from 'react';

/**
 * Whether the current screen may read the keyboard. A modal (like an approval prompt) closes the gate
 * so keys meant for it never reach the screen underneath, which stays mounted with its state intact.
 */
export const InputGate = createContext(true);

type InputHandler = Parameters<typeof useInput>[0];
type PasteHandler = Parameters<typeof usePaste>[0];

/** useInput, but silent while the gate is closed. */
export function useKeys(handler: InputHandler, options: {isActive?: boolean} = {}): void {
	const open = useContext(InputGate);
	useInput(handler, {isActive: open && (options.isActive ?? true)});
}

/** usePaste, but silent while the gate is closed. */
export function usePasted(handler: PasteHandler, options: {isActive?: boolean} = {}): void {
	const open = useContext(InputGate);
	usePaste(handler, {isActive: open && (options.isActive ?? true)});
}
