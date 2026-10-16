// The prompts handed to a coding agent, one source for the site and the
// checks. The page header (components/PageTitle.astro) shows a page's
// `prompt:` front matter under its title, the home page and the agents room
// show the setup prompt, and llms-full.txt carries each one
// (remark-agent-prompt.mjs). README.md quotes the setup prompt word for word.
// scripts/lint-prompts.mjs fails a prompt that does not name its own page or
// lacks the never-line, a tutorial or how-to page with no prompt, and a
// README, agents page or home page that does not carry this setup prompt.

export const SITE = 'https://intentius.io/chant';

/** In every prompt, word for word. People deploy to real environments, approve, override and merge. */
export const neverLine =
	"Never deploy to a real cloud account or shared environment (with `chant run`, `chant components` or a platform's own CLI), approve (a pull request review, `chant approve` or `chant run approve`), override a policy denial (`chant approve policy-override`), or merge; never touch `.chant/allowed_signers` or `chant/lifecycle`.";

/** The site address of a docs page, by slug (`guide/ops`, `lexicons/aws/examples`, `index`). */
export const pageUrl = (slug) => (slug === 'index' || slug === '' ? `${SITE}/` : `${SITE}/${slug.replace(/\/?index$/, '')}/`);

export const setupPrompt = [
	'Set up chant in this repository.',
	`Read ${SITE}/llms.txt first, then`,
	`${pageUrl('agents')} and follow it.`,
	'Stop when `npx chant build` and `npx chant lint` pass, and open a pull request with the result.',
	neverLine,
].join('\n');

/**
 * A page's `prompt:` front matter, as its text. `prompt: setup` stands for the
 * setup prompt, so a page carries it without a second copy.
 */
export function promptText(prompt) {
	const text = typeof prompt === 'string' ? prompt.trim() : undefined;
	if (!text) return undefined;
	return text === 'setup' ? setupPrompt : text;
}
