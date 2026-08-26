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
                  "label": "How-to guides",
                  "items": [
                        {
                              "label": "Custom Lint Rules",
                              "slug": "custom-rules"
                        },
                        {
                              "label": "Deploying to EKS",
                              "slug": "eks-kubernetes"
                        },
                        {
                              "label": "Examples",
                              "slug": "examples"
                        },
                        {
                              "label": "Nested Stacks",
                              "slug": "nested-stacks"
                        },
                        {
                              "label": "Policy Validation",
                              "slug": "policy-validation"
                        }
                  ]
            },
            {
                  "label": "Reference",
                  "items": [
                        {
                              "label": "Intrinsics",
                              "slug": "intrinsics"
                        },
                        {
                              "label": "All Rules",
                              "slug": "rules"
                        },
                        {
                              "label": "Serialization",
                              "slug": "serialization"
                        },
                        {
                              "label": "AI Skills",
                              "slug": "skills"
                        },
                        {
                              "label": "Composites",
                              "slug": "composites"
                        },
                        {
                              "label": "Intrinsics Guide",
                              "slug": "intrinsics-guide"
                        },
                        {
                              "label": "Lint Rules",
                              "slug": "lint-rules"
                        }
                  ]
            },
            {
                  "label": "Explanation",
                  "items": [
                        {
                              "label": "CloudFormation Concepts",
                              "slug": "cloudformation"
                        }
                  ]
            }
      ],
    }),
  ],
});
