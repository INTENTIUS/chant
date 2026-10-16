// Runs after `astro build` (npm run build) and fails it when a room page, the
// home page or src/data/rooms.mjs links a page or an anchor that does not
// exist. A link into a lexicon's docs site (/chant/lexicons/<name>/) passes
// when lexicons/<name>/docs is a site in this repository: those sites are
// built separately by scripts/build-docs.sh and served beside this one, where
// lychee checks them. It also fails when the sidebar's "Start here" group and
// the rooms' tiles and roles disagree.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROLES, TILES, roomLinks } from '../src/data/rooms.mjs';
import { hasLexiconSite } from '../src/data/proof.mjs';
import { siteHref } from '../src/data/href.mjs';

const base = '/chant';
const docs = fileURLToPath(new URL('..', import.meta.url));
const dist = join(docs, 'dist');
const problems = [];

const ids = new Map();
const idsOf = (file) => {
	if (!ids.has(file)) ids.set(file, new Set([...readFileSync(file, 'utf8').matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])));
	return ids.get(file);
};

/** The built file a site path is served from, or undefined. */
const target = (path) => {
	const p = join(dist, decodeURIComponent(path.slice(base.length)));
	if (existsSync(p) && statSync(p).isFile()) return p;
	if (existsSync(join(p, 'index.html'))) return join(p, 'index.html');
	return undefined;
};

/** Why a site address leads nowhere, or undefined when it resolves. `from` is the page it sits on. */
const broken = (href, from) => {
	if (/^(https?:|mailto:|data:|\/\/)/.test(href)) return undefined;
	const [path, anchor] = href.split('#');
	let file = from;
	if (path) {
		if (!path.startsWith(`${base}/`)) return `${href} is outside ${base}/`;
		const lexicon = path.match(/^\/chant\/lexicons\/([^/]+)\//)?.[1];
		file = target(path.split('?')[0]);
		if (!file) {
			if (lexicon && hasLexiconSite(lexicon)) return undefined;
			return `${href} leads nowhere`;
		}
	}
	if (anchor && file?.endsWith('.html') && !idsOf(file).has(decodeURIComponent(anchor))) return `${href} names an anchor the page does not have`;
	return undefined;
};

if (!existsSync(dist)) {
	console.error('docs/dist is missing: run astro build first');
	process.exit(1);
}

// The links as rooms.mjs writes them.
for (const l of roomLinks()) {
	const why = broken(siteHref(base, l.href));
	if (why) problems.push(`src/data/rooms.mjs: room ${l.room} links "${l.label}": ${why}`);
}

// Every link in the main column of the built room pages and the home page,
// the picker included. The sidebar is left to lychee, which sees every site.
const pages = [join(dist, 'index.html')];
const forDir = join(dist, 'for');
if (existsSync(forDir)) for (const id of readdirSync(forDir)) pages.push(join(forDir, id, 'index.html'));
for (const room of [...TILES, ...ROLES].map((x) => x.room)) {
	if (!existsSync(join(forDir, room, 'index.html'))) problems.push(`dist/for/${room}/: the room page was not built`);
}
for (const f of pages.filter(existsSync)) {
	const page = readFileSync(f, 'utf8');
	const html = page.slice(page.indexOf('<main'), page.lastIndexOf('</main>'));
	if (!html) problems.push(`${relative(dist, f)}: no <main> to check`);
	for (const [, raw] of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
		const why = broken(raw.replace(/&amp;/g, '&'), f);
		if (why) problems.push(`${relative(dist, f)}: ${why}`);
	}
}

// The sidebar's "Start here" group, against the tiles and roles.
const config = readFileSync(join(docs, 'astro.config.mjs'), 'utf8');
const listed = [...config.matchAll(/link: '\/for\/([^/']+)\/'/g)].map((m) => m[1]);
const rooms = [...TILES, ...ROLES].map((x) => x.room);
if (listed.join(' ') !== rooms.join(' ')) {
	problems.push(`astro.config.mjs: "Start here" lists ${listed.join(', ')}, but rooms.mjs has ${rooms.join(', ')}`);
}

for (const p of problems) console.error(p);
if (problems.length) process.exit(1);
console.log(`rooms: ${rooms.length} rooms and the home page, every link resolves`);
