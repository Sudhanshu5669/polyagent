import {formatSettingValue, type SettingKey} from '../core/config.js';
import {loadContext} from '../core/context.js';
import {detectAll, type Detection} from '../core/detect.js';
import {globalConfigPath, tildify} from '../core/paths.js';
import {PROVIDERS} from '../core/providers.js';
import {s} from './style.js';

const SOURCE_LABEL: Record<string, string> = {
	saved: 'saved path',
	path: 'found on PATH',
	'known-location': 'found in a known install folder',
	manual: 'added manually',
};

/** Prints a health report. Exit code 0 when at least one provider works. Never writes config. */
export async function doctor(cwd: string, json: boolean): Promise<number> {
	const ctx = await loadContext(cwd);
	const detections = await detectAll(ctx.global);
	const usable = detections.some(d => d.status === 'found');

	if (json) {
		console.log(
			JSON.stringify(
				{
					providers: detections,
					workspace: {root: ctx.workspace.root, exists: ctx.workspace.exists, branch: ctx.workspace.git?.branch ?? null},
					settings: ctx.settings,
					globalConfig: globalConfigPath(),
				},
				null,
				2,
			),
		);
		return usable ? 0 : 1;
	}

	const out: string[] = [s.bold('Agent CLIs')];
	const width = Math.max(...Object.values(PROVIDERS).map(p => p.label.length));
	for (const d of detections) out.push('  ' + formatDetection(d, width));

	out.push('', s.bold('Workspace'));
	const ws = ctx.workspace;
	if (ws.exists) {
		const branch = ws.git?.branch ? s.dim(`  on ${ws.git.branch}`) : '';
		out.push(`  ${s.ok('✓')} ${tildify(ws.dir)}${branch}`);
	} else {
		out.push(`  ${s.dim('·')} Not set up here. Run ${s.accent('polyagent init')} to set up ${tildify(ws.root)}`);
	}

	for (const w of ws.warnings) out.push(`  ${s.warn('⚠')} ${w}`);

	out.push('', s.bold('Settings'));
	for (const [key, value] of Object.entries(ctx.settings.values)) {
		const source = ctx.settings.sources[key as keyof typeof ctx.settings.values];
		out.push(`  ${key.padEnd(17)} ${formatSettingValue(key as SettingKey, value).padEnd(12)} ${s.dim(source)}`);
	}

	out.push('', s.dim(`Global config: ${tildify(globalConfigPath())}`));
	if (!usable) out.push('', s.fail('No agent CLI is working. Install at least one of the tools above, then run polyagent again.'));
	console.log(out.join('\n'));
	return usable ? 0 : 1;
}

function formatDetection(d: Detection, width: number): string {
	const def = PROVIDERS[d.provider];
	const label = def.label.padEnd(width);
	switch (d.status) {
		case 'found':
			return `${s.ok('✓')} ${label}  ${tildify(d.path)}  ${s.dim(d.version)}  ${s.dim(SOURCE_LABEL[d.source] ?? '')}`;
		case 'broken':
			return `${s.fail('✗')} ${label}  ${tildify(d.path)}  ${s.fail(`doesn't run: ${d.error}`)}`;
		case 'missing': {
			const how = def.install[0] ? `install: ${def.install[0]}` : `see ${def.docsUrl}`;
			return `${s.fail('✗')} ${label}  ${s.dim('not found')}  ${s.dim(how)}`;
		}
	}
}
