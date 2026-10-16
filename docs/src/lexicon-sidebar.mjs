// The "Lexicons" part of the sidebar, read from what each lexicon's docs
// pipeline wrote (chant #3993). `writeDocsSite` in packages/core/src/codegen/
// docs.ts, run in its in-site mode by scripts/build-docs.sh, writes a
// lexicon's pages to src/content/docs/lexicons/<name>/ and, beside them,
// _sidebar.json: the lexicon's collapsed group with its Diátaxis subgroups,
// and the slugs of its hidden pages. Starlight's content loader skips files
// that start with an underscore, so the fragment never becomes a page.
//
// astro.config.mjs calls lexiconGroups() inside its sidebar literal, and
// scripts/check-docs-diataxis.mjs imports this same file to evaluate that
// literal, so the check sees exactly the sidebar the site is built with.
// Plain Node, no dependencies.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultDir = fileURLToPath(new URL('./content/docs/lexicons/', import.meta.url));

/**
 * Every generated lexicon section, sorted by its sidebar label.
 * @param {string} [dir] the content directory holding one folder per lexicon
 * @returns {{ name: string, label: string, group: Record<string, unknown>, hidden: string[] }[]}
 */
export function lexiconFragments(dir = defaultDir) {
	if (!existsSync(dir)) return [];
	const out = [];
	for (const name of readdirSync(dir).sort()) {
		const file = join(dir, name, '_sidebar.json');
		if (!existsSync(file)) continue;
		const fragment = JSON.parse(readFileSync(file, 'utf8'));
		out.push({ name, label: fragment.group.label, group: fragment.group, hidden: fragment.hidden ?? [] });
	}
	return out.sort((a, b) => a.label.localeCompare(b.label, 'en', { sensitivity: 'base' }));
}

/** The lexicon groups, in the order the sidebar lists them. */
export function lexiconGroups(dir = defaultDir) {
	return lexiconFragments(dir).map((f) => f.group);
}

/**
 * The base a lexicon page's root-relative links resolve against, for
 * rehype-base-url's `baseFor`: /chant/lexicons/<name> for a page under
 * src/content/docs/lexicons/<name>/, undefined for every other page.
 * @param {string} path the page's source file
 */
export function lexiconPageBase(path) {
	if (!path.startsWith(defaultDir)) return undefined;
	const name = path.slice(defaultDir.length).split('/')[0];
	return name && path.slice(defaultDir.length).includes('/') ? `/chant/lexicons/${name}` : undefined;
}
