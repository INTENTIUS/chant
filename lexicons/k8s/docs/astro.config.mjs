// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import rehypeBaseUrl from './src/rehype-base-url.mjs';

export default defineConfig({
  base: '/chant/lexicons/k8s/',
  markdown: {
    rehypePlugins: [[rehypeBaseUrl, { base: '/chant/lexicons/k8s/', projectBase: '/chant' }]],
  },
  integrations: [
    starlight({
      title: 'Kubernetes',
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
                  "label": "Tutorials",
                  "items": [
                        {
                              "label": "Getting Started",
                              "slug": "getting-started"
                        }
                  ]
            },
            {
                  "label": "How-to guides",
                  "items": [
                        {
                              "label": "Examples: Composites",
                              "slug": "composite-examples"
                        },
                        {
                              "label": "Examples: Resources",
                              "slug": "examples"
                        },
                        {
                              "label": "Importing Existing YAML",
                              "slug": "importing-yaml"
                        },
                        {
                              "label": "Operational Playbook",
                              "slug": "operational-playbook"
                        },
                        {
                              "label": "Testing & Validation",
                              "slug": "testing"
                        },
                        {
                              "label": "Live Cluster",
                              "items": [
                                    {
                                          "label": "chant kube",
                                          "slug": "kube"
                                    }
                              ]
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
                              "label": "AI Skills",
                              "slug": "skills"
                        },
                        {
                              "label": "Argo CD Composites",
                              "slug": "argo-composites"
                        },
                        {
                              "label": "CRD-Generated Classes",
                              "slug": "crd-classes"
                        },
                        {
                              "label": "Flux Composites",
                              "slug": "flux-composites"
                        },
                        {
                              "label": "Lint Rules",
                              "slug": "lint-rules"
                        },
                        {
                              "label": "Vendor Composites",
                              "items": [
                                    {
                                          "label": "AKS Composites",
                                          "slug": "aks-composites"
                                    },
                                    {
                                          "label": "EKS Composites",
                                          "slug": "eks-composites"
                                    },
                                    {
                                          "label": "GKE Composites",
                                          "slug": "gke-composites"
                                    }
                              ]
                        },
                        {
                              "label": "Live Cluster",
                              "items": [
                                    {
                                          "label": "The API Client",
                                          "slug": "api-client"
                                    }
                              ]
                        }
                  ]
            },
            {
                  "label": "Explanation",
                  "items": [
                        {
                              "label": "Kubernetes Concepts",
                              "slug": "kubernetes-concepts"
                        }
                  ]
            }
      ],
    }),
  ],
});
