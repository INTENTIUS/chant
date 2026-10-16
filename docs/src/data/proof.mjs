// The numbers and example lists the picker and the rooms show, read from the
// repository at build time: each tile's lexicons' example projects (the
// directories under lexicons/<name>/examples), and each room's `examples`,
// which must exist. Nothing here is typed by hand.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

// `astro build` runs in docs/, so the repository root is its parent.
const root = resolve(process.cwd(), '..');
if (!existsSync(join(root, 'lexicons'))) throw new Error(`docs/src/data/proof.mjs: expected the chant repository at ${root}`);

export const repoTree = 'https://github.com/INTENTIUS/chant/tree/main';

const dirs = (p) => (existsSync(p) ? readdirSync(p).filter((n) => statSync(join(p, n)).isDirectory()) : []);

/** The example projects under each named lexicon, as { lexicon, count, href }. */
export function lexiconExamples(lexicons) {
	return lexicons.map((lexicon) => {
		if (!existsSync(join(root, 'lexicons', lexicon))) throw new Error(`docs/src/data/rooms.mjs: no lexicon ${lexicon} under lexicons/`);
		return { lexicon, count: dirs(join(root, 'lexicons', lexicon, 'examples')).length, href: `${repoTree}/lexicons/${lexicon}/examples` };
	});
}

/** A room's example directories, each checked to exist, as { path, href }. */
export function roomExamples(room) {
	return room.examples.map((path) => {
		if (!existsSync(join(root, path)) || !statSync(join(root, path)).isDirectory()) {
			throw new Error(`docs/src/data/rooms.mjs: room ${room.id} names the example ${path}, which is not a directory in the repository`);
		}
		return { path, href: `${repoTree}/${path}` };
	});
}

/** Whether lexicons/<name>/docs exists, so a link to /chant/lexicons/<name>/ has a site behind it. */
export const hasLexiconSite = (name) => existsSync(join(root, 'lexicons', name, 'docs', 'astro.config.mjs'));
