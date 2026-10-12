// Puts a page's `prompt:` front matter into its rendered body as a hidden
// block, so llms-full.txt (starlight-llms-txt renders each page's body to
// Markdown) carries the prompt the page header shows. On the page the block
// has the `hidden` attribute; the visible card is AgentPrompt.astro.
export default function remarkAgentPrompt() {
	return (tree, file) => {
		const prompt = file.data.astro?.frontmatter?.prompt;
		if (typeof prompt !== 'string' || !prompt.trim()) return;
		tree.children.unshift({
			type: 'blockquote',
			data: { hName: 'div', hProperties: { hidden: true, className: ['chant-prompt-text'] } },
			children: [
				// A strong paragraph, not a heading, so the page's table of contents leaves it out.
				{ type: 'paragraph', children: [{ type: 'strong', children: [{ type: 'text', value: 'Optional: hand this page to your coding agent' }] }] },
				{ type: 'code', lang: 'text', value: prompt.trim() },
			],
		});
	};
}
