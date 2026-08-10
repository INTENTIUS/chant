/**
 * Has upstream dogwood moved under chant's pin? (#1688)
 *
 * The dogwood pin (#1657, implemented in #1672/#1677) is a git SHA plus seven
 * blob hashes over `dogwood-policy/dogwood` — a read-only squash-sync mirror of
 * an internal Amazon repository. It has no tags, no releases, no changelog, and
 * a crate version that reads `1.0.0` forever, so there is no version feed to
 * diff and nothing like the release check `emulator-freshness` runs. What there
 * is instead is content: the three `.pest` grammars, `default_macros.dw`, and
 * the three `dogwood-cli/src` files whose report structs are the JSON contract
 * chant's adapter reads. Compare those blob hashes against upstream's current
 * tree and you learn exactly which surface a sync touched.
 *
 * Advisory, never gating, for the same reason the emulator check is: per the
 * #808 policy a pin moves when a consuming test needs the newer upstream, not
 * because upstream moved. A moved surface is a prompt to re-verify #1657's
 * findings, not a build failure.
 *
 * Repo tooling, deliberately outside the cedar package. The pin itself is
 * lexicon surface (`lexicons/cedar/src/dogwood/upstream.ts`); watching GitHub
 * for drift is not, and nothing shipped should reach the network to find out.
 */

/** The shape of {@link DOGWOOD_UPSTREAM}, restated so this module owns no lexicon types. */
export interface UpstreamPin {
  readonly owner: string;
  readonly repo: string;
  readonly revision: string;
  readonly contents: Readonly<Record<string, string>>;
}

/** What happened to one pinned file since the pin was taken. */
export type SurfaceState =
  /** Byte-identical upstream — the blob hash still matches. */
  | "unchanged"
  /** Same path, different content: a sync rewrote it. */
  | "moved"
  /** The path is gone upstream — renamed, split, or deleted. */
  | "missing";

export interface SurfaceResult {
  /** Repo-relative path in `dogwood-policy/dogwood`. */
  path: string;
  /** Blob hash recorded in the pin. */
  pinned: string;
  /** Blob hash on the upstream branch now, or null when the path is gone. */
  upstream: string | null;
  state: SurfaceState;
}

export interface FreshnessReport {
  owner: string;
  repo: string;
  /** The branch read, `main` unless overridden. */
  branch: string;
  pinnedRevision: string;
  upstreamRevision: string;
  /** True when the branch head is no longer the pinned commit. */
  revisionMoved: boolean;
  surfaces: SurfaceResult[];
  /** True when at least one pinned file moved or vanished. */
  surfacesMoved: boolean;
}

/** A commit or tree fetch, reduced to what the comparison needs. */
export interface UpstreamState {
  revision: string;
  /** Pinned path → current blob hash, null when the path no longer exists. */
  blobs: Record<string, string | null>;
}

export interface TransportResponse {
  status: number;
  /** Parsed JSON body, or undefined when the response carried none. */
  body: unknown;
}

/**
 * A single GET against the GitHub REST API.
 *
 * A status rather than a thrown error, because a 404 is a real answer here: it
 * is how the tree endpoint reports a path that a sync deleted, and the caller
 * has to tell that apart from the API being unreachable.
 */
export type JsonTransport = (url: string) => Promise<TransportResponse>;

const API = "https://api.github.com";

/** The default transport: `fetch`, authenticated with `GITHUB_TOKEN` when one is set. */
export function githubTransport(fetchImpl: typeof fetch = fetch): JsonTransport {
  return async (url: string): Promise<TransportResponse> => {
    const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const res = await fetchImpl(url, { headers });
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    return { status: res.status, body };
  };
}

async function getJson(transport: JsonTransport, url: string): Promise<unknown> {
  const res = await transport(url);
  if (res.status !== 200) {
    const message = (res.body as { message?: string } | undefined)?.message;
    throw new Error(`GET ${url}: HTTP ${res.status}${message ? ` — ${message}` : ""}`);
  }
  return res.body;
}

interface TreeEntry {
  path?: string;
  type?: string;
  sha?: string;
}

/**
 * The current head of `branch` and the blob hash of every pinned path there.
 *
 * Two calls in the common case: resolve the branch ref, then read its tree
 * recursively. A recursive tree over dogwood is a few thousand entries, well
 * inside the API's cap, but the endpoint reserves the right to truncate — so
 * any path the tree did not account for is re-read one at a time through the
 * contents endpoint rather than silently reported as deleted.
 */
export async function fetchUpstreamState(
  pin: UpstreamPin,
  branch: string,
  transport: JsonTransport,
): Promise<UpstreamState> {
  const base = `${API}/repos/${pin.owner}/${pin.repo}`;

  const ref = (await getJson(transport, `${base}/git/ref/heads/${branch}`)) as {
    object?: { sha?: string };
  };
  const revision = ref?.object?.sha;
  if (!revision) throw new Error(`${pin.owner}/${pin.repo}: branch ${branch} returned no commit sha`);

  const tree = (await getJson(transport, `${base}/git/trees/${revision}?recursive=1`)) as {
    tree?: TreeEntry[];
    truncated?: boolean;
  };
  const byPath = new Map<string, string>();
  for (const entry of tree?.tree ?? []) {
    if (entry.type === "blob" && entry.path && entry.sha) byPath.set(entry.path, entry.sha);
  }

  const blobs: Record<string, string | null> = {};
  for (const path of Object.keys(pin.contents)) {
    const sha = byPath.get(path);
    if (sha) {
      blobs[path] = sha;
    } else if (tree?.truncated) {
      blobs[path] = await blobShaFromContents(base, path, revision, transport);
    } else {
      blobs[path] = null;
    }
  }
  return { revision, blobs };
}

/** One file's blob hash via the contents endpoint; null when it is not there. */
async function blobShaFromContents(
  base: string,
  path: string,
  revision: string,
  transport: JsonTransport,
): Promise<string | null> {
  const url = `${base}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${revision}`;
  const res = await transport(url);
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error(`GET ${url}: HTTP ${res.status}`);
  return (res.body as { sha?: string } | undefined)?.sha ?? null;
}

/** Diff the pin against a fetched upstream state. Pure — this is the tested half. */
export function buildReport(pin: UpstreamPin, branch: string, state: UpstreamState): FreshnessReport {
  const surfaces: SurfaceResult[] = Object.entries(pin.contents).map(([path, pinned]) => {
    const upstream = state.blobs[path] ?? null;
    const outcome: SurfaceState = upstream === null ? "missing" : upstream === pinned ? "unchanged" : "moved";
    return { path, pinned, upstream, state: outcome };
  });
  return {
    owner: pin.owner,
    repo: pin.repo,
    branch,
    pinnedRevision: pin.revision,
    upstreamRevision: state.revision,
    revisionMoved: state.revision !== pin.revision,
    surfaces,
    surfacesMoved: surfaces.some((s) => s.state !== "unchanged"),
  };
}

const short = (sha: string): string => sha.slice(0, 8);

/** One line per pinned surface, plus the revision line. For a terminal or a job log. */
export function formatReport(report: FreshnessReport): string[] {
  const lines = [
    report.revisionMoved
      ? `⚠ ${report.owner}/${report.repo}@${report.branch}: pinned ${short(report.pinnedRevision)} → head ${short(report.upstreamRevision)}`
      : `✓ ${report.owner}/${report.repo}@${report.branch}: pinned ${short(report.pinnedRevision)} is the current head`,
  ];
  for (const s of report.surfaces) {
    if (s.state === "unchanged") lines.push(`  ✓ ${s.path} — unchanged (${short(s.pinned)})`);
    else if (s.state === "moved") lines.push(`  ⚠ ${s.path} — moved ${short(s.pinned)} → ${short(s.upstream!)}`);
    else lines.push(`  ⚠ ${s.path} — gone upstream (pinned ${short(s.pinned)})`);
  }
  lines.push(
    report.surfacesMoved
      ? `${report.surfaces.filter((s) => s.state !== "unchanged").length} of ${report.surfaces.length} pinned surfaces moved — advisory, re-verify #1657's findings before bumping`
      : `All ${report.surfaces.length} pinned surfaces are unchanged`,
  );
  return lines;
}

/** The same report as Markdown, for a job summary or an uploaded artifact. */
export function markdownReport(report: FreshnessReport): string {
  const rows = report.surfaces.map((s) => {
    const status =
      s.state === "unchanged"
        ? "unchanged"
        : s.state === "moved"
          ? `moved \`${short(s.pinned)}\` → \`${short(s.upstream!)}\``
          : `**gone upstream** (pinned \`${short(s.pinned)}\`)`;
    return `| \`${s.path}\` | ${status} |`;
  });
  return [
    `## dogwood upstream freshness — ${report.owner}/${report.repo}@${report.branch}`,
    "",
    `Pinned revision \`${short(report.pinnedRevision)}\`; branch head \`${short(report.upstreamRevision)}\`` +
      (report.revisionMoved ? " — the mirror has synced since the pin was taken." : " — the pin is the head."),
    "",
    "| Pinned surface | Status |",
    "| --- | --- |",
    ...rows,
    "",
    report.surfacesMoved
      ? "At least one pinned surface changed. That is a prompt to re-read the #1657 verification for the affected file, not a build failure: per the #808 policy the pin moves when a consuming test needs the newer upstream, not because upstream moved."
      : "Every pinned surface is byte-identical to the pin. A revision move with no surface move is a docs or example sync.",
    "",
    "The pin lives in `lexicons/cedar/src/dogwood/upstream.ts`.",
  ].join("\n");
}
