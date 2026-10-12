import { defineCollection, z } from 'astro:content';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';

export const collections = {
	docs: defineCollection({
		loader: docsLoader(),
		schema: docsSchema({
			extend: z.object({
				// Diátaxis quadrant (https://diataxis.fr). One mode per page;
				// scripts/check-docs-diataxis.mjs enforces it and the sidebar
				// group it sits in. chant #1731.
				diataxis: z.enum(['tutorial', 'how-to', 'reference', 'explanation']).optional(),
				// "Optional: hand this page to your coding agent": the prompt
				// PageTitle.astro shows under the title and llms-full.txt carries
				// (remark-agent-prompt.mjs). It has to say what the agent must never do.
				prompt: z
					.string()
					.optional()
					.refine((p) => !p || /^Never\b/m.test(p), 'a prompt needs a line that starts with "Never" (what the agent must not do)'),
			}),
		}),
	}),
};
