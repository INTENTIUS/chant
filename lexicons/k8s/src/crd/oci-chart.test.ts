import { describe, test, expect } from "vitest";
import { createHash } from "crypto";
import { gzipSync } from "zlib";
import {
  HELM_CHART_LAYER,
  chartYamlFiles,
  parseOciRef,
  pullOciChart,
  readTarGz,
  type OciHttp,
} from "./oci-chart";

/** A minimal ustar writer, enough to stand in for a Helm chart archive. */
function tarGz(entries: Array<{ name: string; body: string; type?: string }>): Buffer {
  const blocks: Buffer[] = [];
  for (const { name, body, type = "0" } of entries) {
    const data = Buffer.from(body, "utf8");
    const header = Buffer.alloc(512);
    header.write(name.slice(0, 100), 0, "utf8");
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
    header.write("00000000000\0", 136);
    header.write("        ", 148);
    header.write(type, 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    let sum = 0;
    for (const b of header) sum += b;
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

const CHART = tarGz([
  { name: "op/Chart.yaml", body: "name: op\n" },
  { name: "op/templates/deployment.yaml", body: "kind: Deployment\n" },
  { name: "op/crds/b.yml", body: "kind: B\n" },
  { name: "op/crds/a.yaml", body: "kind: A\n" },
  { name: "op/crds/README.md", body: "not yaml\n" },
  { name: "op/crds/nested/c.yaml", body: "kind: C\n" },
]);

describe("readTarGz / chartYamlFiles", () => {
  test("reads regular files and keeps only YAML directly in the subdir, sorted", () => {
    const files = readTarGz(CHART);
    expect(files.get("op/Chart.yaml")?.toString()).toBe("name: op\n");
    expect(chartYamlFiles(files, "crds")).toEqual([
      ["op/crds/a.yaml", "kind: A\n"],
      ["op/crds/b.yml", "kind: B\n"],
    ]);
  });

  test("follows a GNU long-name record", () => {
    const long = `op/crds/${"x".repeat(120)}.yaml`;
    const files = readTarGz(
      tarGz([
        { name: "././@LongLink", body: long + "\0", type: "L" },
        { name: "truncated", body: "kind: Long\n" },
      ]),
    );
    expect(files.get(long)?.toString()).toBe("kind: Long\n");
  });

  test("follows a pax path record", () => {
    const long = `op/crds/${"y".repeat(120)}.yaml`;
    const record = `path=${long}\n`;
    const len = String(record.length + 4).length + 1 + record.length;
    const files = readTarGz(
      tarGz([
        { name: "PaxHeader", body: `${len} ${record}`, type: "x" },
        { name: "truncated", body: "kind: Pax\n" },
      ]),
    );
    expect(files.get(long)?.toString()).toBe("kind: Pax\n");
  });
});

describe("parseOciRef", () => {
  test("splits host and repository", () => {
    expect(parseOciRef("oci://ghcr.io/org/helm/op")).toEqual({ host: "ghcr.io", repository: "org/helm/op" });
  });

  test("rejects a non-oci reference", () => {
    expect(() => parseOciRef("https://charts.example.com/op")).toThrow(/not an oci:\/\//);
  });
});

describe("pullOciChart", () => {
  const digest = `sha256:${createHash("sha256").update(CHART).digest("hex")}`;

  /** A registry that challenges, hands out a token, and serves one chart. */
  function registry(layerDigest = digest, blob = CHART): { http: OciHttp; seen: string[] } {
    const seen: string[] = [];
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    const http: OciHttp = {
      probe: async (url) => {
        seen.push(url);
        return new Response("", {
          status: 401,
          headers: { "www-authenticate": 'Bearer realm="https://reg.test/token",service="reg.test"' },
        });
      },
      get: async (url, init) => {
        seen.push(url);
        if (url.startsWith("https://reg.test/token")) {
          expect(new URL(url).searchParams.get("scope")).toBe("repository:org/op:pull");
          return json({ token: "t0k" });
        }
        expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer t0k");
        if (url.endsWith("/manifests/1.2.3")) {
          return json({ layers: [{ mediaType: HELM_CHART_LAYER, digest: layerDigest }] });
        }
        if (url.endsWith(`/blobs/${layerDigest}`)) return new Response(blob, { status: 200 });
        throw new Error(`unexpected ${url}`);
      },
    };
    return { http, seen };
  }

  test("pulls the chart layer with an anonymous token, without helm", async () => {
    const { http, seen } = registry();
    const blob = await pullOciChart("oci://reg.test/org/op", "1.2.3", digest, http);
    expect(blob.equals(CHART)).toBe(true);
    expect(seen).toEqual([
      "https://reg.test/v2/",
      "https://reg.test/token?service=reg.test&scope=repository%3Aorg%2Fop%3Apull",
      "https://reg.test/v2/org/op/manifests/1.2.3",
      `https://reg.test/v2/org/op/blobs/${digest}`,
    ]);
  });

  test("refuses a re-pushed tag whose layer no longer matches the pin", async () => {
    const { http } = registry();
    await expect(pullOciChart("oci://reg.test/org/op", "1.2.3", "sha256:" + "0".repeat(64), http)).rejects.toThrow(
      /re-pushed/,
    );
  });

  test("refuses a blob whose bytes do not match its digest", async () => {
    const { http } = registry(digest, gzipSync(Buffer.from("tampered")));
    await expect(pullOciChart("oci://reg.test/org/op", "1.2.3", undefined, http)).rejects.toThrow(
      /downloaded as sha256:/,
    );
  });
});
