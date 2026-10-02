// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import rehypeBaseUrl from './src/rehype-base-url.mjs';

export default defineConfig({
  base: '/chant/lexicons/sql/',
  markdown: {
    rehypePlugins: [[rehypeBaseUrl, { base: '/chant/lexicons/sql/', projectBase: '/chant' }]],
  },
  integrations: [
    starlight({
      title: 'SQL',
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
                              "label": "Declaring Tables and Views",
                              "slug": "clickhouse-ddl"
                        },
                        {
                              "label": "Importing a Live Server",
                              "slug": "importing"
                        }
                  ]
            },
            {
                  "label": "Reference",
                  "items": [
                        {
                              "label": "All Rules",
                              "slug": "rules"
                        },
                        {
                              "label": "Serialization",
                              "slug": "serialization"
                        },
                        {
                              "label": "Planning and the Change Classifier",
                              "slug": "change-classifier"
                        }
                  ]
            },
            {
                  "label": "Explanation",
                  "items": [
                        {
                              "label": "Where the Types Come From",
                              "slug": "clickhouse-catalog"
                        }
                  ]
            }
      ],
    }),
  ],
});
