import {GIT_TRACKING_MODES, type GitTracking, type SettingKey, type Settings} from '../../core/config.js';
import {PROVIDERS, PROVIDER_IDS} from '../../core/providers.js';

export const GIT_TRACKING_LABELS: Record<GitTracking, string> = {
	'ignore-all': 'Ignore everything',
	'share-team': 'Share team, ignore runs',
	'track-all': 'Track everything',
};

const GIT_TRACKING_HELP: Record<GitTracking, string> = {
	'ignore-all': 'Nothing in .polyagent/ is committed.',
	'share-team': 'Employees, presets and config are committed so your team shares them. Run history stays local.',
	'track-all': 'Everything in .polyagent/ is committed, including run history.',
};

export interface SettingMeta<K extends SettingKey = SettingKey> {
	key: K;
	label: string;
	/** Values to cycle through. Empty for free-text settings, which are typed in. */
	options: Settings[K][];
	/** For free-text settings: turns the typed text into a value (empty → null). */
	parse?: (text: string) => Settings[K];
	format: (value: Settings[K]) => string;
	help: (value: Settings[K]) => string;
}

function meta<K extends SettingKey>(m: SettingMeta<K>): SettingMeta {
	return m as unknown as SettingMeta;
}

export const SETTINGS_META: SettingMeta[] = [
	meta({
		key: 'gitTracking',
		label: 'Git tracking',
		options: [...GIT_TRACKING_MODES],
		format: v => GIT_TRACKING_LABELS[v],
		help: v => GIT_TRACKING_HELP[v],
	}),
	meta({
		key: 'orchestrator',
		label: 'Orchestrator',
		options: [...PROVIDER_IDS],
		format: v => PROVIDERS[v].label,
		help: () => 'The agent that plans the work, briefs employees and reviews their reports.',
	}),
	meta({
		key: 'autoRun',
		label: 'Auto-run plans',
		options: [true, false],
		format: v => (v ? 'On' : 'Off'),
		help: v => (v ? 'Plans start as soon as the orchestrator makes them.' : 'You approve each plan before employees start.'),
	}),
	meta({
		key: 'maxParallel',
		label: 'Parallel limit',
		options: [null, 1, 2, 3, 4, 6, 8, 12, 16],
		format: v => (v === null ? 'Unlimited' : `${v} at a time`),
		help: v =>
			v === null
				? 'Every task that is ready runs at once, each employee in their own git worktree. Set a limit if you hit provider rate limits.'
				: `At most ${v} employees work at the same time.`,
	}),
	meta({
		key: 'approvals',
		label: 'Approvals',
		options: ['ask', 'block'],
		format: v => (v === 'ask' ? 'Ask me' : 'Block'),
		help: v =>
			v === 'ask'
				? 'When a Claude Code employee wants to do something that needs approval (like running a command), you are asked. Codex and Antigravity follow their sandbox instead.'
				: 'Anything that needs approval is blocked and the employee carries on without it.',
	}),
	meta({
		key: 'runBudget',
		label: 'Run budget',
		options: [null, 0.5, 1, 2, 5, 10, 25, 50],
		format: v => (v === null ? 'None' : `$${v}`),
		help: v =>
			v === null
				? 'Runs are never paused for cost. Claude Code reports cost; Codex reports tokens only, so its usage is not counted.'
				: `A run pauses once it has cost $${v}. Resuming allows another $${v}.`,
	}),
	meta({
		key: 'taskTimeout',
		label: 'Task time limit',
		options: [null, 5, 10, 20, 30, 60],
		format: v => (v === null ? 'None' : `${v} min`),
		help: v => (v === null ? 'Tasks can take as long as they need.' : `A task that runs longer than ${v} minutes is stopped and reported as failed.`),
	}),
	meta({
		key: 'orchestratorModel',
		label: 'Orchestrator model',
		options: [],
		parse: text => text.trim() || null,
		format: v => v ?? 'CLI default',
		help: () => 'The model the orchestrator uses, by any name its CLI accepts (e.g. opus, sonnet, haiku). Press ⏎ to type one; leave empty for the default.',
	}),
];
