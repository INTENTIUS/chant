// A room as Markdown, the same sections as components/Room.astro in the same
// order, for "Copy page as Markdown" on the room's page.
import { FORGES, TILES } from './rooms.mjs';
import { lexiconExamples, roomExamples } from './proof.mjs';
import { siteHref } from './href.mjs';
import { promptText } from '../prompts.mjs';

export function roomMarkdown(r, site) {
	const link = (l) => `[${l.label}](${siteHref(site, l.href)})`;
	const out = [r.lede, '', '## Works', '', ...r.works.map((w) => `- ${w}`), '', '## Differs', ''];
	for (const f of FORGES) {
		out.push(`### ${f.label}`, '', ...[...f.differs, ...(r.differs[f.id] ?? [])].map((l) => `- ${l}`), '');
	}
	out.push('## First step', '');
	if (r.first.note) out.push(r.first.note, '');
	if (r.first.command.any) out.push('```sh', r.first.command.any, '```', '');
	else for (const f of FORGES) out.push(`${f.label}:`, '', '```sh', r.first.command[f.id], '```', '');
	out.push(`Next: ${link(r.first.link)}.`, '', 'Or hand this step to your coding agent:', '', '```text', promptText(r.first.prompt), '```', '', '## Proof', '');
	for (const e of roomExamples(r)) out.push(`- [${e.path}](${e.href})`);
	const tile = TILES.find((t) => t.room === r.id);
	for (const l of tile ? lexiconExamples(tile.lexicons) : []) if (l.count) out.push(`- ${l.count} examples in [lexicons/${l.lexicon}/examples](${l.href})`);
	out.push('', '## Then read', '');
	for (const [label, links] of [['Tasks', r.tasks], ['Background', r.background], ['Reference', r.reference]]) {
		if (links.length) out.push(`### ${label}`, '', ...links.map((l) => `- ${link(l)}`), '');
	}
	return out.join('\n');
}
