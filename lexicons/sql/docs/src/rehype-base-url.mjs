/**
 * Rehype plugin: prepend a configured `base` to root-relative `<a href>` attributes.
 *
 * Astro/Starlight only base-prefixes its own internal navigation (sidebar `link:`
 * entries, `slug:` entries). Root-relative links written in MD/MDX content body
 * — e.g. `[AWS](/lexicons/aws/)` — are emitted verbatim and 404 in production
 * when the site is served from a non-root `base`.
 *
 * This plugin walks the HAST tree, finds `<a>` elements whose href starts with
 * `/` (single leading slash, not `//`), and prepends the site's `base`. It
 * idempotently skips hrefs that already start with the site's own base or the
 * project-wide base.
 *
 * @typedef {Object} RehypeBaseUrlOptions
 * @property {string} base - Site base, e.g. "/chant" or "/chant/lexicons/aws". Trailing/leading slashes optional.
 * @property {string} [projectBase] - Project-wide base used to detect already-correctly-prefixed cross-site links.
 */

const PROTOCOL_RE = /^[a-z][a-z0-9+.-]*:/i;

function normalizeBase(value) {
  return "/" + value.replace(/^\/+|\/+$/g, "");
}

/**
 * @param {RehypeBaseUrlOptions} opts
 */
export default function rehypeBaseUrl(opts) {
  const base = normalizeBase(opts.base);
  if (base === "/") {
    return () => {};
  }
  const ownPrefix = base + "/";
  const projectPrefix = opts.projectBase
    ? normalizeBase(opts.projectBase) + "/"
    : null;

  function rewrite(node) {
    if (
      node &&
      node.type === "element" &&
      node.tagName === "a" &&
      node.properties &&
      typeof node.properties.href === "string"
    ) {
      const href = node.properties.href;
      if (
        href.length > 0 &&
        !href.startsWith("//") &&
        !PROTOCOL_RE.test(href) &&
        !href.startsWith("#") &&
        href.startsWith("/") &&
        href !== base &&
        !href.startsWith(ownPrefix) &&
        !(projectPrefix && href.startsWith(projectPrefix))
      ) {
        node.properties.href = base + href;
      }
    }
    if (node && node.children) {
      for (const child of node.children) rewrite(child);
    }
  }

  return (tree) => {
    rewrite(tree);
  };
}
