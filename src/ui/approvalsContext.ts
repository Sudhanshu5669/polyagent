import {createContext, useContext, useSyncExternalStore} from 'react';
import type {ApprovalBroker, ApprovalRequest} from '../core/approvals.js';

export const ApprovalsContext = createContext<ApprovalBroker | undefined>(undefined);
/** Display names for agent ids, so prompts say "Maya" rather than "maya". */
export const AgentNamesContext = createContext<(agent: string) => string>(agent => agent);

const noop = () => () => {};

/** Pending approval requests, re-rendering whenever they change. */
export function usePendingApprovals(): ApprovalRequest[] {
	const broker = useContext(ApprovalsContext);
	useSyncExternalStore(broker?.subscribe ?? noop, () => broker?.version ?? 0);
	return broker?.pending ?? [];
}
