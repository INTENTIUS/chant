/**
 * The release catalog as a static site (#4595). {@link renderCatalogSite}
 * turns one catalog (./release-catalog.ts) into files a product writes
 * beside its registry: `index.html`, a page per component and per version,
 * `index.json` (the catalog itself, which the search box and
 * `terragucci modules` both read), `style.css` and `search.js`. Every link
 * is relative, so the site works under any prefix and from a bucket.
 *
 * Core renders what every component has. An engine adds its own parts
 * (Terraform inputs and outputs, an npm package's exports) through
 * `sections`, called per component and per version, so no engine word
 * lives here. Text and table cells are escaped; a section of `kind: "html"`
 * is written as given, so only pass HTML the caller built.
 */

import type { CatalogComponent, CatalogVersion, ReleaseCatalog } from "./release-catalog";
import { catalogVersionKey } from "./release-catalog";

/** The body of an engine section. */
export type CatalogSectionBody =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "table"; columns: string[]; rows: string[][] }
  | { kind: "html"; html: string };

/** One titled part of a component or version page. */
export interface CatalogSiteSection {
  title: string;
  body: CatalogSectionBody;
}

/** The engine's parts of each page. Either may be left out. */
export interface CatalogSiteSections {
  component?(component: CatalogComponent): CatalogSiteSection[];
  version?(component: CatalogComponent, version: CatalogVersion): CatalogSiteSection[];
}

/** One file of the site: its path under the site's root, its type and its bytes. */
export interface CatalogSiteFile {
  path: string;
  contentType: string;
  bytes: Uint8Array;
}

/** Options for {@link renderCatalogSite}. */
export interface CatalogSiteOptions {
  /** The site's title, on every page. Default `Release catalog`. */
  title?: string;
}

const encoder = new TextEncoder();

/** HTML-escape `s`. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** A path-safe directory segment for a name or version: `/` keeps the name's nesting, anything outside `[A-Za-z0-9._-]` becomes `_`. */
export function catalogPathSegments(name: string): string[] {
  return name.split("/").map((seg) => {
    const safe = seg.replace(/[^A-Za-z0-9._-]/g, "_");
    return safe === "" || safe === "." || safe === ".." ? `_${safe}` : safe;
  });
}

/** The directory of a component's page, from the site's root. */
export function componentPath(component: string): string {
  return catalogPathSegments(component).join("/");
}

/** The directory of a version's page, from the site's root. */
export function versionPath(component: string, key: string): string {
  return `${componentPath(component)}/${catalogPathSegments(key).join("/")}`;
}

function up(dir: string): string {
  return dir === "" ? "" : "../".repeat(dir.split("/").length);
}

function page(opts: { title: string; site: string; dir: string; body: string }): string {
  const root = up(opts.dir);
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(opts.title)}</title>`,
    `<link rel="stylesheet" href="${root}style.css">`,
    "</head>",
    "<body>",
    `<header><a href="${root}index.html">${escapeHtml(opts.site)}</a></header>`,
    "<main>",
    opts.body,
    "</main>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

function status(v: CatalogVersion): string {
  return `<span class="status status-${v.status.state}">${v.status.state}</span>`;
}

function table(columns: string[], rows: string[][], raw = false): string {
  const cell = (c: string) => (raw ? c : escapeHtml(c));
  return [
    "<table>",
    `<thead><tr>${columns.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead>`,
    `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${cell(c)}</td>`).join("")}</tr>`).join("")}</tbody>`,
    "</table>",
  ].join("\n");
}

function section(s: CatalogSiteSection): string {
  const b = s.body;
  const inner =
    b.kind === "text"
      ? `<p>${escapeHtml(b.text)}</p>`
      : b.kind === "code"
        ? `<pre><code>${escapeHtml(b.text)}</code></pre>`
        : b.kind === "table"
          ? table(b.columns, b.rows)
          : b.html;
  return `<section><h2>${escapeHtml(s.title)}</h2>\n${inner}\n</section>`;
}

function shortSha(sha: string): string {
  return sha.length > 12 ? sha.slice(0, 12) : sha;
}

function indexPage(catalog: ReleaseCatalog, site: string): string {
  const rows = catalog.components.map((c) => {
    const link = `<a href="${componentPath(c.name)}/index.html">${escapeHtml(c.name)}</a>`;
    const states = [...new Set(c.versions.map((v) => v.status.state))].sort().join(", ");
    return [link, escapeHtml(c.latest ?? "none"), String(c.versions.length), escapeHtml(states)];
  });
  const body = [
    `<h1>${escapeHtml(site)}</h1>`,
    '<input id="search" type="search" placeholder="Search components and versions" aria-label="Search">',
    '<ul id="results"></ul>',
    table(["Component", "Latest", "Versions", "Status"], rows, true),
    '<script src="search.js" defer></script>',
  ].join("\n");
  return page({ title: site, site, dir: "", body });
}

function componentPage(c: CatalogComponent, site: string, sections: CatalogSiteSections): string {
  const dir = componentPath(c.name);
  const rows = c.versions.map((v) => {
    const key = catalogVersionKey(v);
    const href = `${catalogPathSegments(key).join("/")}/index.html`;
    return [`<a href="${href}">${escapeHtml(key)}</a>`, status(v), escapeHtml(v.time), escapeHtml(shortSha(v.commit)), escapeHtml(v.envs.join(", "))];
  });
  const body = [
    `<h1>${escapeHtml(c.name)}</h1>`,
    `<p>Latest: ${escapeHtml(c.latest ?? "none")}</p>`,
    ...(sections.component?.(c) ?? []).map(section),
    "<section><h2>Versions</h2>",
    table(["Version", "Status", "Released", "Commit", "Environments"], rows, true),
    "</section>",
  ].join("\n");
  return page({ title: `${c.name} - ${site}`, site, dir, body });
}

const CHANGE_GROUPS: { kind: CatalogVersion["changelog"]["entries"][number]["kind"]; title: string }[] = [
  { kind: "breaking", title: "Breaking changes" },
  { kind: "feat", title: "Features" },
  { kind: "fix", title: "Fixes" },
  { kind: "other", title: "Other changes" },
];

function versionPage(c: CatalogComponent, v: CatalogVersion, site: string, sections: CatalogSiteSections): string {
  const key = catalogVersionKey(v);
  const dir = versionPath(c.name, key);
  const parts: string[] = [`<h1>${escapeHtml(c.name)} ${escapeHtml(key)}</h1>`, `<p>${status(v)}</p>`];
  if (v.status.state !== "active") {
    const said = [`This version is ${v.status.state}`];
    if (v.status.reason) said.push(`: ${escapeHtml(v.status.reason)}`);
    if (v.status.replacement) {
      const target = c.versions.find((x) => x.version === v.status.replacement || x.digest === v.status.replacement);
      const name = escapeHtml(v.status.replacement);
      said.push(`. Use ${target ? `<a href="../${catalogPathSegments(catalogVersionKey(target)).join("/")}/index.html">${name}</a>` : name} instead`);
    }
    parts.push(`<p class="notice">${said.join("")}.</p>`);
  }
  parts.push(
    table(
      ["Digest", "Commit", "Released", "By", "Environments"],
      [[v.digest, v.commit, v.time, v.actor, v.envs.join(", ")]],
    ),
  );
  const att = [`<p>Attestation: ${escapeHtml(v.attestation.state)}${v.attestation.identity ? `, signed by ${escapeHtml(v.attestation.identity)}` : ""}</p>`];
  if (v.attestation.verify) att.push(`<pre><code>${escapeHtml(v.attestation.verify)}</code></pre>`);
  parts.push(`<section><h2>Attestation</h2>\n${att.join("\n")}\n</section>`);
  if (v.changelog.entries.length > 0) {
    const groups = CHANGE_GROUPS.map((g) => {
      const entries = v.changelog.entries.filter((e) => e.kind === g.kind);
      if (entries.length === 0) return "";
      const items = entries.map((e) => `<li><code>${escapeHtml(shortSha(e.sha))}</code> ${e.scope ? `<b>${escapeHtml(e.scope)}</b> ` : ""}${escapeHtml(e.subject)}</li>`);
      return `<h3>${g.title}</h3>\n<ul>${items.join("")}</ul>`;
    }).filter(Boolean);
    const bump = v.changelog.bump ? `<p>Bump: ${v.changelog.bump}</p>\n` : "";
    parts.push(`<section><h2>Changelog</h2>\n${bump}${groups.join("\n")}\n</section>`);
  }
  if (v.consumers.length > 0) {
    parts.push(
      `<section><h2>Used by</h2>\n${table(
        ["Repository", "Root", "File", "Address"],
        v.consumers.map((u) => [u.repo ?? "", u.root, u.file ?? "", u.address ?? ""]),
      )}\n</section>`,
    );
  }
  parts.push(...(sections.version?.(c, v) ?? []).map(section));
  return page({ title: `${c.name} ${key} - ${site}`, site, dir, body: parts.join("\n") });
}

const STYLE = `body{font-family:system-ui,-apple-system,sans-serif;margin:0;color:#1b1b1b;background:#fff;line-height:1.5}
header{padding:12px 16px;border-bottom:1px solid #ddd}
header a{font-weight:600;text-decoration:none;color:inherit}
main{max-width:960px;margin:0 auto;padding:16px}
table{border-collapse:collapse;width:100%;margin:12px 0;display:block;overflow-x:auto}
th,td{border-bottom:1px solid #e5e5e5;padding:6px 8px;text-align:left;vertical-align:top;word-break:break-word}
pre{background:#f5f5f5;padding:8px;overflow-x:auto}
input[type=search]{width:100%;max-width:480px;padding:6px 8px;font-size:1rem}
.status{padding:1px 6px;border-radius:4px;font-size:.85em}
.status-active{background:#e3f4e6}
.status-deprecated{background:#fff3cd}
.status-yanked{background:#f8d7da}
.notice{border-left:4px solid #c08a00;padding-left:8px}
@media (prefers-color-scheme:dark){body{color:#e6e6e6;background:#141414}header{border-color:#333}th,td{border-color:#2a2a2a}pre{background:#1f1f1f}.status-active{background:#1e3a24}.status-deprecated{background:#4a3b00}.status-yanked{background:#4a1c20}}
`;

const SEARCH = `(function () {
  var input = document.getElementById("search");
  var out = document.getElementById("results");
  if (!input || !out) return;
  var seg = function (s) { return s.split("/").map(function (p) { var x = p.replace(/[^A-Za-z0-9._-]/g, "_"); return x === "" || x === "." || x === ".." ? "_" + x : x; }).join("/"); };
  var entries = [];
  fetch("index.json").then(function (r) { return r.json(); }).then(function (doc) {
    (doc.components || []).forEach(function (c) {
      entries.push({ text: c.name, href: seg(c.name) + "/index.html", label: c.name });
      (c.versions || []).forEach(function (v) {
        var key = v.version || v.digest;
        entries.push({ text: c.name + " " + key + " " + v.status.state, href: seg(c.name) + "/" + seg(key) + "/index.html", label: c.name + " " + key + " (" + v.status.state + ")" });
      });
    });
  });
  input.addEventListener("input", function () {
    var q = input.value.trim().toLowerCase();
    out.textContent = "";
    if (!q) return;
    entries.filter(function (e) { return e.text.toLowerCase().indexOf(q) !== -1; }).slice(0, 50).forEach(function (e) {
      var li = document.createElement("li");
      var a = document.createElement("a");
      a.href = e.href;
      a.textContent = e.label;
      li.appendChild(a);
      out.appendChild(li);
    });
  });
})();
`;

/**
 * Render `catalog` as a static site. Files come back sorted by path; their
 * bytes depend only on the catalog and the sections, so a rerun over the
 * same catalog writes the same bytes and a caller can skip unchanged files.
 */
export function renderCatalogSite(catalog: ReleaseCatalog, sections: CatalogSiteSections = {}, opts: CatalogSiteOptions = {}): CatalogSiteFile[] {
  const site = opts.title ?? "Release catalog";
  const files = new Map<string, { contentType: string; text: string }>();
  const put = (path: string, contentType: string, text: string) => {
    if (files.has(path)) throw new Error(`release catalog site: two pages at ${path}`);
    files.set(path, { contentType, text });
  };
  put("index.html", "text/html; charset=utf-8", indexPage(catalog, site));
  put("index.json", "application/json", `${JSON.stringify(catalog, null, 2)}\n`);
  put("style.css", "text/css; charset=utf-8", STYLE);
  put("search.js", "text/javascript; charset=utf-8", SEARCH);
  for (const c of catalog.components) {
    put(`${componentPath(c.name)}/index.html`, "text/html; charset=utf-8", componentPage(c, site, sections));
    for (const v of c.versions) {
      put(`${versionPath(c.name, catalogVersionKey(v))}/index.html`, "text/html; charset=utf-8", versionPage(c, v, site, sections));
    }
  }
  return [...files.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, f]) => ({ path, contentType: f.contentType, bytes: encoder.encode(f.text) }));
}
