/**
 * Docs site template generators for init-lexicon scaffold.
 */

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
      dependencies: {
        "@astrojs/starlight": "^0.37.6",
        astro: "^5.6.1",
        sharp: "^0.34.2",
      },
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
  return `import { defineCollection } from 'astro:content';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';

export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
};
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
