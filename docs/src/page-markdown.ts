// The text "Copy page as Markdown" puts on the clipboard: the title, the
// page's address, its agent prompt when it has one, then the page source with
// MDX import and export lines taken out (they mean nothing outside the build).
// Components stay as written, so a reader sees where one sat.
export function pageMarkdown({ title, url, prompt, body }: { title: string; url: string; prompt?: string; body: string }): string {
	const source = body
		.split('\n')
		.filter((line) => !/^(import|export)\s/.test(line))
		.join('\n')
		.replace(/^\s+/, '')
		.trimEnd();
	const parts = [`# ${title}`, `Source: ${url}`];
	if (prompt?.trim()) parts.push('Optional: hand this page to your coding agent.', '```text\n' + prompt.trim() + '\n```');
	parts.push(source);
	return parts.join('\n\n') + '\n';
}
