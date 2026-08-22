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
  /** Slugs of auto-generated pages to suppress (e.g. "pseudo-parameters") */
  suppressPages?: string[];
  /** Source directory for scanning rule files (defaults to srcDir sibling of distDir) */
  srcDir?: string;
  /** Base path for the generated Astro site (e.g. '/lexicons/aws/') */
  basePath?: string;
  /** Root directory for resolving {{file:...}} markers in extra page content */
  examplesDir?: string;
  /**
   * Directory of authored `.mdx` pages, each tagged with a Diátaxis quadrant
   * (chant #1733). Defaults to `<outDir>/pages`. See docs-pages.ts. This is
   * the only way a lexicon adds prose pages; `extraPages` (prose in docs.ts
   * template literals) and `sidebarExtra` (hand-listed content files) were
   * removed in chant #1757.
   */
  pagesDir?: string;
}

/** Diátaxis quadrant (https://diataxis.fr). */
export type Quadrant = "tutorial" | "how-to" | "reference" | "explanation";

/** One sidebar entry, as the quadrant-grouped sidebar builder sees it. */
export interface SidebarPage {
  slug: string;
  label: string;
  quadrant: Quadrant;
  /** Nested subgroup label inside the quadrant. */
  group?: string;
  /** Lower sorts first within its group; unordered pages follow, by label. */
  order?: number;
  /** Keep out of the sidebar. */
  hidden?: boolean;
}

export interface DocsResult {
  pages: Map<string, string>;
  /** Every page the sidebar should list, authored and generated, by quadrant. */
  sidebarPages: SidebarPage[];
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
    /** chant #1044 — the call-form fold opt-in, as published in the lexicon's manifest. Absent in any manifest built before #1044, which reads the same as "not opted in". */
    foldsAsCall?: boolean;
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
