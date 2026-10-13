/**
 * Pull a Helm chart out of an OCI registry over plain HTTP, and read its files.
 *
 * Generation used to shell out to `helm pull` for these. A machine without
 * helm on PATH (a fresh CI runner, a container) then dropped the chart's kinds
 * with only a warning, and the generated surface depended on which tools the
 * host happened to have. The registry API is three requests, and a chart is a
 * small gzipped tarball, so neither needs the binary.
 */

import { createHash } from "crypto";
import { gunzipSync } from "zlib";
import { fetchWithRetry } from "@intentius/chant/codegen/fetch";

/** The layer media type Helm pushes a chart's content under. */
export const HELM_CHART_LAYER = "application/vnd.cncf.helm.chart.content.v1.tar+gzip";

const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * The two kinds of request a pull makes. `probe` must return a 401 as a
 * response (the registry's auth challenge); `get` throws on any failure and
 * retries transient ones.
 */
export interface OciHttp {
  probe: Fetch;
  get: Fetch;
}

const defaultHttp: OciHttp = {
  probe: (url, init) => fetch(url, init),
  get: (url, init) => fetchWithRetry(url, undefined, undefined, init),
};

export interface OciChartRef {
  /** Registry host, e.g. "ghcr.io". */
  host: string;
  /** Repository path inside the registry, e.g. "codriverlabs/helm/kube-microvm-operator". */
  repository: string;
}

/** Split an `oci://host/repo/path` chart reference. */
export function parseOciRef(chart: string): OciChartRef {
  const m = /^oci:\/\/([^/]+)\/(.+)$/.exec(chart);
  if (!m) throw new Error(`not an oci:// chart reference: ${chart}`);
  return { host: m[1], repository: m[2].replace(/\/+$/, "") };
}

/**
 * Get an anonymous pull token, following the registry's own challenge
 * (`WWW-Authenticate: Bearer realm=...,service=...`). Returns undefined when
 * the registry does not ask for one.
 */
async function anonymousToken(ref: OciChartRef, http: OciHttp): Promise<string | undefined> {
  const probe = await http.probe(`https://${ref.host}/v2/`);
  if (probe.status !== 401) return undefined;
  const challenge = probe.headers.get("www-authenticate") ?? "";
  const params = Object.fromEntries(
    [...challenge.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]),
  );
  if (!/^bearer/i.test(challenge) || !params.realm) {
    throw new Error(`registry ${ref.host} asks for auth this loader does not speak: ${challenge || "(no challenge)"}`);
  }
  const url = new URL(params.realm);
  if (params.service) url.searchParams.set("service", params.service);
  url.searchParams.set("scope", `repository:${ref.repository}:pull`);
  const res = await http.get(url.toString());
  const body = (await res.json()) as { token?: string; access_token?: string };
  const token = body.token ?? body.access_token;
  if (!token) throw new Error(`registry ${ref.host} returned no token for ${ref.repository}`);
  return token;
}

/**
 * Download a chart's content layer (the .tgz `helm pull` would fetch).
 *
 * @param digest  When given ("sha256:..."), the layer must have this digest.
 *                Pinning it makes the source content-addressed: a re-pushed
 *                tag fails loudly instead of changing generated output.
 */
export async function pullOciChart(
  chart: string,
  version: string,
  digest?: string,
  http: OciHttp = defaultHttp,
): Promise<Buffer> {
  const ref = parseOciRef(chart);
  const token = await anonymousToken(ref, http);
  const auth: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const base = `https://${ref.host}/v2/${ref.repository}`;

  const manifestRes = await http.get(`${base}/manifests/${version}`, {
    headers: { ...auth, Accept: MANIFEST_ACCEPT },
  });
  const manifest = (await manifestRes.json()) as { layers?: Array<{ mediaType: string; digest: string }> };
  const layer = manifest.layers?.find((l) => l.mediaType === HELM_CHART_LAYER);
  if (!layer) {
    throw new Error(`${chart}:${version} has no layer of type ${HELM_CHART_LAYER}; is it a Helm chart?`);
  }
  if (digest && layer.digest !== digest) {
    throw new Error(
      `${chart}:${version} chart layer is ${layer.digest}, but the source pins ${digest}. ` +
      "The tag was re-pushed; review the new chart and update the pin.",
    );
  }

  const blobRes = await http.get(`${base}/blobs/${layer.digest}`, { headers: auth });
  const blob = Buffer.from(await blobRes.arrayBuffer());
  const actual = `sha256:${createHash("sha256").update(blob).digest("hex")}`;
  if (actual !== layer.digest) {
    throw new Error(`${chart}:${version} chart layer downloaded as ${actual}, expected ${layer.digest}`);
  }
  return blob;
}

/**
 * Read the regular files out of a gzipped tarball, as path to content.
 * Handles ustar, plus the pax (`x`) and GNU (`L`) long-name records Helm's
 * Go archiver may write.
 */
export function readTarGz(tgz: Buffer): Map<string, Buffer> {
  const tar = gunzipSync(tgz);
  const files = new Map<string, Buffer>();
  let offset = 0;
  let longName: string | undefined;

  const field = (start: number, len: number): string => {
    const raw = tar.subarray(offset + start, offset + start + len);
    const nul = raw.indexOf(0);
    return raw.subarray(0, nul === -1 ? raw.length : nul).toString("utf8");
  };

  while (offset + 512 <= tar.length) {
    // Two zero blocks end the archive; one is enough to stop reading.
    if (tar.subarray(offset, offset + 512).every((b) => b === 0)) break;

    const size = parseInt(field(124, 12).trim() || "0", 8);
    const type = field(156, 1) || "0";
    const prefix = field(345, 155);
    const name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    const data = tar.subarray(offset + 512, offset + 512 + size);
    longName = undefined;

    if (type === "x") {
      const path = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString("utf8"));
      if (path) longName = path[1];
    } else if (type === "L") {
      longName = data.toString("utf8").replace(/\0+$/, "");
    } else if (type === "0" || type === "\0") {
      files.set(name, Buffer.from(data));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

/**
 * The YAML files directly inside `<chart dir>/<subdir>/`, sorted by path so
 * the concatenation does not depend on archive order.
 */
export function chartYamlFiles(files: Map<string, Buffer>, subdir: string): Array<[string, string]> {
  const dir = subdir.replace(/^\/+|\/+$/g, "");
  return [...files.entries()]
    .filter(([path]) => {
      // Strip the single top-level chart directory, whatever it is named.
      const rest = path.split("/").slice(1).join("/");
      if (!rest.startsWith(`${dir}/`)) return false;
      const leaf = rest.slice(dir.length + 1);
      return !leaf.includes("/") && (leaf.endsWith(".yaml") || leaf.endsWith(".yml"));
    })
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, buf]) => [path, buf.toString("utf8")]);
}
