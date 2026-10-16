export interface RehypeBaseUrlOptions {
  /** Site base, e.g. "/chant" or "/chant/lexicons/aws". Trailing/leading slashes optional. */
  base: string;
  /** Project-wide base used to detect already-correctly-prefixed cross-site links. */
  projectBase?: string;
  /** Per-page base, by the page's source path; undefined falls back to `base`. */
  baseFor?: (path: string) => string | undefined;
}

type HastNode = {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

export default function rehypeBaseUrl(
  opts: RehypeBaseUrlOptions,
): (tree: HastNode, file?: { path?: string }) => void;
