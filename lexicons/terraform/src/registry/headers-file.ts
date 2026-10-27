/**
 * The `_headers` file Cloudflare Pages and Netlify read beside a static site
 * (terragucci#1287): one rule per version's download path, sending
 * `X-Terraform-Get` with the location the stored body names. A host that
 * reads `_headers` needs no edge function for Terraform to install; a plain
 * bucket, GitHub Pages and GitLab Pages can't set a header per object and do.
 *
 * Cloudflare Pages reads at most 100 rules from `_headers`; a registry with
 * more versions than that needs the edge function there.
 */
import { DOWNLOAD_HEADER } from "./writer";

/** The file's name at the site's root. */
export const HEADERS_FILE = "_headers";
/** Rules Cloudflare Pages reads from `_headers`. */
export const PAGES_HEADER_RULES = 100;

/** One download path (from the site root, leading `/`) and the location its header names. */
export interface DownloadHeaderRule {
  path: string;
  location: string;
}

const rulePath = (path: string): string => `/${path.replace(/^\/+/, "")}`;

/** The download rules an existing `_headers` file holds; other rules are kept by `headersFile` as they are. */
export function readHeadersFile(text: string | undefined): { downloads: DownloadHeaderRule[]; other: string[] } {
  const downloads: DownloadHeaderRule[] = [];
  const other: string[] = [];
  let current: { path: string; lines: string[] } | undefined;
  const flush = () => {
    if (!current) return;
    const header = current.lines.map((l) => /^\s+([^:]+):\s*(.*)$/.exec(l)).find((m) => m && m[1]!.trim().toLowerCase() === DOWNLOAD_HEADER.toLowerCase());
    if (header && current.lines.length === 1) downloads.push({ path: current.path, location: header[2]!.trim() });
    else other.push([current.path, ...current.lines].join("\n"));
    current = undefined;
  };
  for (const line of (text ?? "").split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (/^\s/.test(line)) current?.lines.push(line);
    else {
      flush();
      current = { path: line.trim(), lines: [] };
    }
  }
  flush();
  return { downloads, other };
}

/**
 * A `_headers` file with a rule per download, merged into `existing`: rules
 * for other paths stay as written, a download rule for the same path is
 * replaced, and download rules are sorted by path.
 */
export function headersFile(rules: DownloadHeaderRule[], existing?: string): string {
  const held = readHeadersFile(existing);
  const byPath = new Map(held.downloads.map((r) => [r.path, r.location]));
  for (const r of rules) byPath.set(rulePath(r.path), r.location);
  const downloads = [...byPath.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([path, location]) => `${path}\n  ${DOWNLOAD_HEADER}: ${location}`);
  return `${[...held.other, ...downloads].join("\n\n")}\n`;
}
