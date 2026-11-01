/**
 * #4676: the Tauri updater target against the forge fake. The stage fills a
 * draft for the rolling tag while the published rolling release stays as it
 * was; the reveal swaps the draft in. Nothing reaches a network.
 */

import { afterAll, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRedactor } from "./publish-credentials";
import { PublishDeclarationSchema } from "./publish-declaration";
import { createPublishTargets } from "./publish-targets";
import { tauriManifest } from "./publish-tauri";
import { PublishTargetError, type PublishContext } from "./release-publish";
import { makeRelease, type ReleaseArtifact } from "./release-store";
import { startFakeForge } from "./__fixtures__/publish-fakes";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const CUT = { actor: "alice", label: "app-v1.4.0", timestamp: "2026-10-17T10:00:00.000Z", runId: "1", signature: null };
function context(cwd: string, over: Partial<PublishContext> & { artifacts?: ReleaseArtifact[] } = {}): PublishContext & { lines: string[] } {
  const env = over.env ?? { GITHUB_TOKEN: "ghs_tokentoken" };
  const redactor = createRedactor(env);
  const lines: string[] = [];
  const release = makeRelease({ member: null, commit: "c0ffee".padEnd(40, "0"), artifactDigests: over.artifacts ?? [], targets: [{ env: "dev", params: [], templates: [] }] });
  return { release, label: "app-v1.4.0", releaseTag: "release/app-v1.4.0", cut: CUT, provenance: { oidc: false, ci: null, reason: "" }, cwd, tag: null, env, redactor, log: (l) => lines.push(redactor.redact(l)), ...over, lines };
}

async function refused(p: Promise<unknown>): Promise<PublishTargetError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof PublishTargetError) return err;
    throw err;
  }
  throw new Error("expected a PublishTargetError");
}

const API = "https://api.github.test";
const digest = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
function member(): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-publish-tauri-"));
  dirs.push(dir);
  mkdirSync(join(dir, "dist"));
  const files: Record<string, string> = {
    "Arugula_aarch64.app.tar.gz": "mac arm bundle",
    "Arugula_aarch64.app.tar.gz.sig": "c2lnbmF0dXJlIGFybQ==\n",
    "Arugula_x64.app.tar.gz": "mac intel bundle",
    "Arugula_x64.app.tar.gz.sig": "c2lnbmF0dXJlIHg2NA==\n",
    "Arugula_1.4.0_amd64.AppImage": "linux bundle",
    "Arugula_1.4.0_amd64.AppImage.sig": "c2lnbmF0dXJlIGxpbnV4\n",
    "Arugula_1.4.0_aarch64.dmg": "dmg",
  };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, "dist", name), text);
  writeFileSync(join(dir, "NOTES.md"), "Faster sync.\n");
  return dir;
}
const declaration = (over: Record<string, unknown> = {}) =>
  PublishDeclarationSchema.parse({
    type: "tauri-updater",
    repo: "arugula-salad/arugula",
    tag: "app-latest",
    api: API,
    platforms: { "darwin-aarch64": "dist/Arugula_aarch64.app.tar.gz", "darwin-x86_64": "dist/Arugula_x64.app.tar.gz", "linux-x86_64": "dist/Arugula_1.4.0_amd64.AppImage" },
    assets: ["dist/Arugula_1.4.0_aarch64.dmg"],
    notes: "NOTES.md",
    ...over,
  });
const NAMES = ["Arugula_aarch64.app.tar.gz", "Arugula_x64.app.tar.gz", "Arugula_1.4.0_amd64.AppImage", "Arugula_1.4.0_aarch64.dmg", "latest.json"];
const download = (name: string) => `https://github.com/arugula-salad/arugula/releases/download/app-latest/${name}`;

describe("tauri updater (#4676)", () => {
  test("writes the v2 updater manifest from the bundles' .sig files, stages it with the bundles on a draft, and swaps the rolling release at the reveal", async () => {
    const dir = member();
    const old = { id: 7, tag_name: "app-latest", draft: false, target: "old".padEnd(40, "0"), assets: [{ name: "latest.json", digest: digest("old"), bytes: "old" }], name: "app-latest 1.3.0" };
    const forge = startFakeForge("github", API, "arugula-salad/arugula", [old]);
    const [target] = await createPublishTargets([declaration()], { fetch: forge.fetch });
    const ctx = context(dir);

    const manifest = {
      version: "1.4.0",
      notes: "Faster sync.",
      pub_date: "2026-10-17T10:00:00.000Z",
      platforms: {
        "darwin-aarch64": { signature: "c2lnbmF0dXJlIGFybQ==", url: download("Arugula_aarch64.app.tar.gz") },
        "darwin-x86_64": { signature: "c2lnbmF0dXJlIHg2NA==", url: download("Arugula_x64.app.tar.gz") },
        "linux-x86_64": { signature: "c2lnbmF0dXJlIGxpbnV4", url: download("Arugula_1.4.0_amd64.AppImage") },
      },
    };
    const text = `${JSON.stringify(manifest, null, 2)}\n`;
    const plan = await target!.plan(ctx);
    expect(plan.map((i) => i.name)).toEqual([...NAMES.slice(0, 4).map((n) => `dist/${n}`), "latest.json"]);
    expect(plan.at(-1)).toEqual({ name: "latest.json", destination: "github arugula-salad/arugula release app-latest, asset latest.json", digest: digest(text) });
    expect(forge.calls).toEqual([]);

    // The second upload fails: the draft keeps the first, and the rolling release still serves the old manifest.
    forge.failOnce("POST https://uploads.forge.test/repos/arugula-salad/arugula/releases/101/assets?name=Arugula_x64");
    expect((await refused(target!.stage(ctx))).code).toBe("publish-tauri-failed");
    const staged = await target!.stage(ctx);
    expect(staged.items.map((i) => i.present ?? false)).toEqual([true, false, false, false, false]);
    expect(staged.state).toEqual({ releaseId: "101" });
    expect(forge.visible()).toEqual([{ tag: "app-latest", assets: ["latest.json"] }]);
    const draft = forge.releases.find((r) => r.id === 101)!;
    expect(draft).toMatchObject({ draft: true, name: "app-latest 1.4.0", target: ctx.release.commit });
    expect(JSON.parse(draft.assets.find((a) => a.name === "latest.json")!.bytes)).toEqual(manifest);

    await target!.reveal(ctx, staged);
    expect(forge.visible()).toEqual([{ tag: "app-latest", assets: NAMES }]);
    expect(forge.releases.some((r) => r.id === 7)).toBe(false);
    expect(forge.tags.get("app-latest")).toBe(ctx.release.commit);
    expect(forge.releases.find((r) => r.id === 101)!.make_latest).toBe("false");
    expect(ctx.lines.join("\n")).not.toContain("ghs_tokentoken");

    // Run again: the reveal finds the draft published; a stage finds every file there and stages nothing.
    const n = forge.calls.length;
    await target!.reveal(ctx, staged);
    expect(forge.calls.slice(n).map((c) => c.method)).toEqual(["GET"]);
    const again = await target!.stage(ctx);
    expect(again.state).toEqual({ published: "101" });
    expect(again.items.every((i) => i.present)).toBe(true);
  });

  test("with no rolling release yet, the reveal only publishes the draft, with the declared latest and url", async () => {
    const dir = member();
    const forge = startFakeForge("github", API, "arugula-salad/arugula");
    const [target] = await createPublishTargets([declaration({ latest: "legacy", url: "https://dl.arugula.example/{version}/{name}", notes: undefined, assets: undefined })], { fetch: forge.fetch });
    const ctx = context(dir, { cut: null });
    await target!.reveal(ctx, await target!.stage(ctx));
    const rel = forge.releases[0]!;
    expect(rel).toMatchObject({ draft: false, make_latest: "legacy" });
    const manifest = JSON.parse(rel.assets.find((a) => a.name === "latest.json")!.bytes) as Record<string, unknown>;
    expect(Object.keys(manifest)).toEqual(["version", "platforms"]);
    expect(manifest.platforms).toMatchObject({ "linux-x86_64": { url: "https://dl.arugula.example/1.4.0/Arugula_1.4.0_amd64.AppImage" } });
  });

  test("refuses a bundle that is not the release's, a missing .sig, a release with no version, a missing token, and a draft asset that differs", async () => {
    const make = async (fetch = startFakeForge("github", API, "arugula-salad/arugula").fetch, over: Record<string, unknown> = {}) => (await createPublishTargets([declaration(over)], { fetch }))[0]!;
    const dir = member();
    const artifacts: ReleaseArtifact[] = [{ component: "app", kind: "asset", path: "dist/Arugula_x64.app.tar.gz.sig", digest: `sha256:${"0".repeat(64)}` }];
    expect((await refused((await make()).plan(context(dir, { artifacts })))).code).toBe("publish-artifact-digest-mismatch");
    expect((await refused((await make(undefined, { platforms: { "windows-x86_64-nsis": "dist/Arugula_1.4.0_aarch64.dmg" } })).plan(context(dir)))).code).toBe("publish-file-missing");
    expect((await refused((await make()).plan(context(dir, { label: "latest" })))).code).toBe("publish-tauri-no-version");
    expect((await refused((await make()).plan(context(dir, { env: {} })))).code).toBe("publish-credentials-missing");
    const differs = startFakeForge("github", API, "arugula-salad/arugula", [
      { id: 9, tag_name: "app-latest", draft: true, target: "x", name: "app-latest 1.4.0", assets: [{ name: "latest.json", digest: digest("other"), bytes: "other" }] },
    ]);
    expect((await refused((await make(differs.fetch)).stage(context(dir)))).code).toBe("publish-tauri-asset-exists");
    expect(() => declaration({ platforms: { macos: "x" } })).toThrow();
    expect(() => declaration({ platforms: {} })).toThrow();
  });

  test("the manifest's keys are in Tauri's order and its platforms sorted", () => {
    const bytes = tauriManifest({ version: "1.0.0", notes: null, pubDate: "2026-01-01T00:00:00Z", platforms: { "windows-x86_64": { signature: "s", url: "u" }, "darwin-aarch64": { signature: "t", url: "v" } } });
    expect(Buffer.from(bytes).toString()).toBe(
      `${JSON.stringify({ version: "1.0.0", pub_date: "2026-01-01T00:00:00Z", platforms: { "darwin-aarch64": { signature: "t", url: "v" }, "windows-x86_64": { signature: "s", url: "u" } } }, null, 2)}\n`,
    );
  });
});
