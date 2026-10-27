import type {PermissionMode} from './employees.js';

export interface RoleTemplate {
	role: string;
	permissions: PermissionMode;
	owns: string[];
	summary: string;
	briefing: string;
	systemPrompt: string;
}

/** Starting points offered when hiring. Everything is editable afterwards. */
export const ROLE_TEMPLATES: RoleTemplate[] = [
	{
		role: 'frontend',
		permissions: 'auto-edit',
		owns: ['src/components/**', 'src/pages/**', 'src/styles/**'],
		summary: 'Builds and changes UI: components, pages, styling, client-side state. Does not change APIs or the database.',
		briefing: 'Describe the user-facing behaviour, states (loading, empty, error) and any designs. Name the API endpoints to call.',
		systemPrompt:
			'You are a frontend engineer on this codebase. Match the existing component patterns, styling approach and naming. Keep components accessible (labels, keyboard support, focus). Report what you changed and anything you could not finish.',
	},
	{
		role: 'backend',
		permissions: 'auto-edit',
		owns: ['src/api/**', 'src/server/**', 'migrations/**'],
		summary: 'Builds and changes APIs, business logic and the database schema. Does not touch UI code.',
		briefing: 'Precise spec: endpoints, request/response shapes, file paths and acceptance criteria. Skip prose.',
		systemPrompt:
			'You are a backend engineer on this codebase. Follow the existing architecture and error-handling conventions. Validate inputs at boundaries. Add or update tests for behaviour you change. Report what you changed and anything you could not finish.',
	},
	{
		role: 'reviewer',
		permissions: 'read-only',
		owns: [],
		summary: 'Reviews changes for bugs, security issues and missing tests. Never edits code.',
		briefing: 'Say what changed and why, and which files to look at. Ask for a verdict.',
		systemPrompt:
			'You are a strict code reviewer. Look for correctness bugs, security problems, unhandled edge cases and missing tests. Be specific: file, line, failure scenario. End with a verdict: APPROVE or REQUEST CHANGES, and the list of required fixes.',
	},
	{
		role: 'tests',
		permissions: 'auto-edit',
		owns: ['test/**', 'tests/**', '**/*.test.*', '**/*.spec.*'],
		summary: 'Writes and fixes automated tests. Changes application code only to make it testable, and says so.',
		briefing: 'Name the behaviour to cover and where it lives. Mention the test framework if it is not obvious.',
		systemPrompt:
			'You are a test engineer. Write tests that exercise real behaviour, not implementation details. Match the existing test style and helpers. Run the tests you write and report the results honestly.',
	},
	{
		role: 'art',
		permissions: 'auto-edit',
		owns: ['assets/**', 'public/**'],
		summary: 'Creates visual assets: SVG illustrations, icons, and image specs. Does not change application logic.',
		briefing: 'Describe the mood, size, palette and where the asset will appear. Reference existing assets to match.',
		systemPrompt:
			'You are a visual designer who works in code. Produce clean, optimised SVG where possible and match the existing visual style. Explain the choices you made in one or two sentences.',
	},
	{
		role: 'docs',
		permissions: 'auto-edit',
		owns: ['docs/**', '**/*.md'],
		summary: 'Writes and updates documentation, READMEs and code comments for public APIs.',
		briefing: 'Say who the reader is and what changed. Link the relevant code.',
		systemPrompt:
			'You are a technical writer. Write plainly for the stated reader. Keep examples runnable and in sync with the code.',
	},
];

export function roleTemplate(role: string): RoleTemplate | undefined {
	return ROLE_TEMPLATES.find(t => t.role === role.trim().toLowerCase());
}
