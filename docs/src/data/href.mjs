// A room link's href (see rooms.mjs) as a site address: a slug or a
// lexicon site path gets the base and a trailing slash, an https:// address
// stays as it is.
export function siteHref(base, h) {
	if (/^https:\/\//.test(h)) return h;
	const [path, anchor] = h.split('#');
	const slug = path.replace(/^\/+|\/+$/g, '');
	return `${base}/${slug}/${anchor ? `#${anchor}` : ''}`;
}

/** Escaped text with `code` spans as <code>, the same on the server and in the picker's script. */
export const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const codeHtml = (t) => esc(t).replace(/`([^`]+)`/g, '<code>$1</code>');
