/**
 * Type definitions for the documentation pipeline.
 */

export interface DocsConfig {
  /** Lexicon name (used for page titles and paths) */
  name: string;
  /** Display name (e.g. "AWS CloudFormation") */
  displayName: string;
  /** Short description of what this lexicon targets */
  description: string;
  /** Path to dist/ directory containing manifest.json and meta.json */
  distDir: string;
  /** Output directory for generated .mdx files */
  outDir: string;
  /** Lexicon-specific overview content (markdown) */
  overview?: string;
  /** Output format description (e.g. "CloudFormation JSON template") */
  outputFormat?: string;
  /** Custom service grouping from resource type (e.g. "AWS::S3::Bucket" → "S3") */
  serviceFromType?: (resourceType: string) => string;
  /** Custom sections to append to overview page */
  extraSections?: Array<{ title: string; content: string }>;
  /** Standalone pages added to the sidebar after Overview */
  extraPages?: Array<{ slug: string; title: string; description?: string; content: string; sidebar?: boolean }>;
  /** Slugs of auto-generated pages to suppress (e.g. "pseudo-parameters") */
  suppressPages?: string[];
  /** Source directory for scanning rule files (defaults to srcDir sibling of distDir) */
  srcDir?: string;
  /** Base path for the generated Astro site (e.g. '/lexicons/aws/') */
  basePath?: string;
  /** Root directory for resolving {{file:...}} markers in extra page content */
  examplesDir?: string;
  /** Extra sidebar entries appended after extraPages (supports Starlight groups) */
  sidebarExtra?: Array<Record<string, unknown>>;
}

export interface DocsResult {
  pages: Map<string, string>;
  stats: {
    resources: number;
    properties: number;
    services: number;
    rules: number;
    intrinsics: number;
  };
}

export interface ManifestJSON {
  name: string;
  version: string;
  namespace?: string;
  intrinsics?: Array<{
    name: string;
    description?: string;
    outputKey?: string;
    isTag?: boolean;
  }>;
  pseudoParameters?: Record<string, string>;
}

export interface MetaEntry {
  resourceType: string;
  kind: "resource" | "property";
  lexicon: string;
  attrs?: Record<string, string>;
  propertyConstraints?: Record<string, unknown>;
  createOnly?: string[];
  writeOnly?: string[];
  primaryIdentifier?: string[];
}

export interface RuleMeta {
  id: string;
  severity: string;
  category: string;
  description: string;
  type: "lint" | "post-synth";
}
