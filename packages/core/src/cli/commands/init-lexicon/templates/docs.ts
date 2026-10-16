/**
 * Docs site template generators for init-lexicon scaffold. The app files
 * (package.json, tsconfig, Astro config, content config) are written only for a
 * lexicon outside the chant repository; inside it, the lexicon's docs are a
 * section of the main site (chant #3993).
 */

import { DOCS_SITE_DEPENDENCIES } from "../../../../codegen/docs-in-site";

export function generateDocsPackageJson(name: string): string {
  return JSON.stringify(
    {
      name: `@intentius/chant-lexicon-${name}-docs`,
      type: "module",
      version: "0.0.1",
      private: true,
      scripts: {
        dev: "astro dev",
        build: "astro build",
        preview: "astro preview",
      },
      dependencies: { ...DOCS_SITE_DEPENDENCIES },
    },
    null,
    2,
  ) + "\n";
}

export function generateDocsTsConfig(): string {
  return JSON.stringify(
    {
      extends: "astro/tsconfigs/strict",
      include: [".astro/types.d.ts", "**/*"],
      exclude: ["dist"],
    },
    null,
    2,
  ) + "\n";
}

export function generateDocsAstroConfig(name: string): string {
  const displayName = name.charAt(0).toUpperCase() + name.slice(1);
  return `// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  integrations: [
    starlight({
      title: '${displayName}',
      sidebar: [
        { label: 'Overview', slug: '' },
      ],
    }),
  ],
});
`;
}

export function generateDocsContentConfig(): string {
  return `import { defineCollection, z } from 'astro:content';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';

export const collections = {
  docs: defineCollection({
    loader: docsLoader(),
    schema: docsSchema({
      extend: z.object({
        // Diátaxis quadrant (https://diataxis.fr), chant #1731.
        diataxis: z.enum(['tutorial', 'how-to', 'reference', 'explanation']).optional(),
      }),
    }),
  }),
};
`;
}

/**
 * First authored page. Lives under docs/pages/; the docs pipeline copies it
 * into src/content/docs/ and builds the sidebar from its `diataxis` field.
 */
export function generateDocsGettingStartedMdx(name: string): string {
  const displayName = name.charAt(0).toUpperCase() + name.slice(1);
  return `---
title: Getting Started
description: First project with the ${displayName} lexicon
diataxis: tutorial
---

Install the lexicon, declare one resource, and build it.

\`\`\`bash
npm install --save-dev @intentius/chant-lexicon-${name}
chant build
\`\`\`

Replace this with a walkthrough a new user can follow start to finish. Other
pages go beside this file in \`docs/pages/\`, each with a \`diataxis\` field
(\`tutorial\`, \`how-to\`, \`reference\` or \`explanation\`).
`;
}

export function generateDocsIndexMdx(name: string): string {
  const displayName = name.charAt(0).toUpperCase() + name.slice(1);
  return `---
title: Overview
description: ${displayName} lexicon for chant
---

Welcome to the ${displayName} lexicon documentation.

Run \`just generate\` to populate this site with generated reference pages.
`;
}
