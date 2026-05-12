// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import rehypeBaseUrl from './src/rehype-base-url.mjs';

export default defineConfig({
  base: '/chant/lexicons/aws/',
  markdown: {
    rehypePlugins: [[rehypeBaseUrl, { base: '/chant/lexicons/aws/', projectBase: '/chant' }]],
  },
  integrations: [
    starlight({
      title: 'AWS CloudFormation',
      sidebar: [
            {
                  "label": "← chant docs",
                  "link": "../../"
            },
            {
                  "label": "Overview",
                  "slug": "index"
            },
            {
                  "label": "CloudFormation Concepts",
                  "slug": "cloudformation"
            },
            {
                  "label": "Intrinsic Functions",
                  "slug": "intrinsics"
            },
            {
                  "label": "Composites",
                  "slug": "composites"
            },
            {
                  "label": "Lint Rules",
                  "slug": "lint-rules"
            },
            {
                  "label": "Custom Lint Rules",
                  "slug": "custom-rules"
            },
            {
                  "label": "Examples",
                  "slug": "examples"
            },
            {
                  "label": "AI Skills",
                  "slug": "skills"
            },
            {
                  "label": "Serialization",
                  "slug": "serialization"
            },
            {
                  "label": "Deploying to EKS",
                  "slug": "eks-kubernetes"
            }
      ],
    }),
  ],
});
