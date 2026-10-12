import { defineCollection, z } from 'astro:content';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';

export const collections = {
  docs: defineCollection({
    loader: docsLoader(),
    schema: docsSchema({
      extend: z.object({
        // Diátaxis quadrant (https://diataxis.fr), chant #1731.
        diataxis: z.enum(['tutorial', 'how-to', 'reference', 'explanation']).optional(),
        // "Optional: hand this page to your coding agent", shown under the
        // title by src/components/AgentPrompt.astro. It has to say what the
        // agent must never do.
        prompt: z
          .string()
          .optional()
          .refine((p) => !p || /^Never\b/m.test(p), 'a prompt needs a line that starts with "Never" (what the agent must not do)'),
      }),
    }),
  }),
};
