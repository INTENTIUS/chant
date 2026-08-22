import { defineCollection, z } from 'astro:content';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';

export const collections = {
  docs: defineCollection({
    loader: docsLoader(),
    schema: docsSchema({
      extend: z.object({
        // Diátaxis quadrant (https://diataxis.fr). chant #1731.
        diataxis: z.enum(['tutorial', 'how-to', 'reference', 'explanation']).optional(),
      }),
    }),
  }),
};
