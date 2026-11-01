/**
 * #4676: the Homebrew tap target against a GitHub repository fake. The stage
 * commits the rendered formula to a staging branch that brew does not read,
 * and the tap branch moves only at the reveal. Nothing reaches a network.
 */

import { afterAll, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRedactor } from "./publish-credentials";
import { PublishDeclarationSchema } from "./publish-declaration";
import { fillUrl, releaseVersion, renderFormula } from "./publish-homebrew";
import { createPublishTargets } from "./publish-targets";
import { PublishTargetError, type PublishContext } from "./release-publish";
import { makeRelease, type ReleaseArtifact } from "./release-store";
import { startFakeGitHubRepo } from "./__fixtures__/publish-fakes";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function context(cwd: string, over: Partial<PublishContext> & { artifacts?: ReleaseArtifact[] } = {}): PublishContext & { lines: string[] } {
  const env = over.env ?? { HOMEBREW_TAP_TOKEN: "ghp_taptokentap" };
  const redactor = createRedactor(env);
  const lines: string[] = [];
  const release = makeRelease({ member: null, commit: "c0ffee".padEnd(40, "0"), artifactDigests: over.artifacts ?? [], targets: [{ env: "dev", params: [], templates: [] }] });
  return { release, label: "v1.4.0", releaseTag: "release/v1.4.0", provenance: { oidc: false, ci: null, reason: "" }, cwd, tag: null, env, redactor, log: (l) => lines.push(redactor.redact(l)), ...over, lines };
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

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const API = "https://api.github.test";
const FILES = { "arugula-darwin-arm64.tar.gz": "mac arm", "arugula-darwin-amd64.tar.gz": "mac intel", "arugula-linux-arm64.tar.gz": "linux arm", "arugula-linux-amd64.tar.gz": "linux intel" };
const TEMPLATE = `class Arugula < Formula
  desc "Arugula daemon"
  homepage "https://arugula.example"
  version "{{version}}"

  on_macos do
    on_arm do
      url "{{url:arugula-darwin-arm64.tar.gz}}"
      sha256 "{{sha256:arugula-darwin-arm64.tar.gz}}"
    end
    on_intel do
      url "{{url:arugula-darwin-amd64.tar.gz}}"
      sha256 "{{sha256:arugula-darwin-amd64.tar.gz}}"
    end
  end

  on_linux do
    on_arm do
      url "{{url:arugula-linux-arm64.tar.gz}}"
      sha256 "{{sha256:arugula-linux-arm64.tar.gz}}"
    end
    on_intel do
      url "{{url:arugula-linux-amd64.tar.gz}}"
      sha256 "{{sha256:arugula-linux-amd64.tar.gz}}"
    end
  end

  def install
    bin.install "arugula"
  end
end
`;

function member(template = TEMPLATE): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-publish-homebrew-"));
  dirs.push(dir);
  mkdirSync(join(dir, "dist"));
  mkdirSync(join(dir, "packaging"));
  for (const [name, bytes] of Object.entries(FILES)) writeFileSync(join(dir, "dist", name), bytes);
  writeFileSync(join(dir, "packaging", "arugula.rb"), template);
  return dir;
}

const declaration = (over: Record<string, unknown> = {}) =>
  PublishDeclarationSchema.parse({
    type: "homebrew",
    tap: "arugula-salad/homebrew-tap",
    formula: "Formula/arugula.rb",
    template: "packaging/arugula.rb",
    assets: Object.keys(FILES).map((n) => `dist/${n}`),
    url: "https://github.com/arugula-salad/arugula/releases/download/{tag}/{name}",
    api: API,
    ...over,
  });

describe("homebrew tap (#4676)", () => {
  test("renders the formula per platform, commits it to a staging branch brew does not read, and fast-forwards the tap branch only at the reveal", async () => {
    const dir = member();
    const tap = startFakeGitHubRepo(API, "arugula-salad/homebrew-tap", "main", { "Formula/arugula.rb": "old formula\n", "README.md": "tap\n" });
    const [target] = await createPublishTargets([declaration()], { fetch: tap.fetch });
    const ctx = context(dir);
    const formula = TEMPLATE.replace("{{version}}", "1.4.0").replace(/\{\{(url|sha256):([^}]+)\}\}/g, (_, k: string, name: string) =>
      k === "url" ? `https://github.com/arugula-salad/arugula/releases/download/release/v1.4.0/${name}` : sha(FILES[name as keyof typeof FILES]),
    );
    const digest = `sha256:${sha(formula)}`;
    expect(await target!.plan(ctx)).toEqual([{ name: "Formula/arugula.rb", destination: "arugula-salad/homebrew-tap@the default branch:Formula/arugula.rb", digest }]);
    expect(tap.calls).toEqual([]);

    const main = tap.branches.get("main");
    const staged = await target!.stage(ctx);
    expect(staged.items).toEqual([{ name: "Formula/arugula.rb", destination: "arugula-salad/homebrew-tap@main:Formula/arugula.rb", digest }]);
    expect(staged.state).toMatchObject({ branch: "main", staging: "chant-publish/arugula-1.4.0" });
    expect(tap.branches.get("main")).toBe(main);
    expect(tap.read("main", "Formula/arugula.rb")).toBe("old formula\n");
    expect(tap.read("chant-publish/arugula-1.4.0", "Formula/arugula.rb")).toBe(formula);
    expect(tap.calls[0]!.headers).toMatchObject({ authorization: "Bearer ghp_taptokentap" });

    // A stage run again finds the staging branch holding the formula and commits nothing.
    const n = tap.calls.length;
    const again = await target!.stage(ctx);
    expect(again.state).toEqual(staged.state);
    expect(tap.calls.slice(n).map((c) => c.method)).toEqual(["GET", "GET", "GET", "GET", "GET"]);

    await target!.reveal(ctx, staged);
    expect(tap.read("main", "Formula/arugula.rb")).toBe(formula);
    expect(tap.read("main", "README.md")).toBe("tap\n");
    expect(tap.log("main")).toEqual(["init", "arugula 1.4.0"]);
    expect(tap.branches.has("chant-publish/arugula-1.4.0")).toBe(false);
    expect(ctx.lines.join("\n")).not.toContain("ghp_taptokentap");

    // Revealed: a stage finds the tap holding the formula and stages nothing.
    const done = await target!.stage(ctx);
    expect(done.state).toEqual({ branch: "main", present: "true" });
    expect(done.items[0]!.present).toBe(true);
    expect(await target!.reveal(ctx, done)).toMatchObject({ items: [{ present: true }] });
    expect(tap.log("main")).toEqual(["init", "arugula 1.4.0"]);
  });

  test("a tap branch that moved since the stage gets the formula as one commit on top", async () => {
    const dir = member();
    const tap = startFakeGitHubRepo(API, "arugula-salad/homebrew-tap", "main", { "Formula/arugula.rb": "old formula\n" });
    const [target] = await createPublishTargets([declaration({ branch: "main" })], { fetch: tap.fetch });
    const ctx = context(dir);
    const staged = await target!.stage(ctx);
    tap.push("main", { "Formula/other.rb": "other\n" });
    await target!.reveal(ctx, staged);
    expect(tap.log("main")).toEqual(["init", "someone else", "arugula 1.4.0"]);
    expect(tap.read("main", "Formula/other.rb")).toBe("other\n");
    expect(tap.read("main", "Formula/arugula.rb")).toContain('version "1.4.0"');
    expect(tap.branches.has("chant-publish/arugula-1.4.0")).toBe(false);
  });

  test("refuses an asset that is not the release's, a placeholder it can't fill, a release with no version, and a missing token, before any request", async () => {
    const tap = startFakeGitHubRepo(API, "arugula-salad/homebrew-tap", "main", {});
    const make = async (over: Record<string, unknown> = {}) => (await createPublishTargets([declaration(over)], { fetch: tap.fetch }))[0]!;
    const artifacts: ReleaseArtifact[] = [{ component: "daemon", kind: "asset", path: "dist/arugula-linux-amd64.tar.gz", digest: `sha256:${"0".repeat(64)}` }];
    expect((await refused((await make()).plan(context(member(), { artifacts })))).code).toBe("publish-artifact-digest-mismatch");
    expect((await refused((await make()).plan(context(member(TEMPLATE.replace("{{version}}", "{{revision}}")))))).code).toBe("publish-homebrew-template");
    expect((await refused((await make()).plan(context(member(`url "{{url:arugula-windows.zip}}"`))))).message).toContain("no declared asset is named arugula-windows.zip");
    expect((await refused((await make()).plan(context(member(), { label: null, releaseTag: null })))).code).toBe("publish-homebrew-no-version");
    expect((await refused((await make({ tokenEnv: "TAP_PAT" })).plan(context(member())))).code).toBe("publish-credentials-missing");
    expect(tap.calls).toEqual([]);
    expect(() => declaration({ tap: "no-slash" })).toThrow();
    expect(() => declaration({ token: "ghp_x" })).toThrow();
  });

  test("the version, URL and template helpers", () => {
    expect(releaseVersion("v1.4.0")).toBe("1.4.0");
    expect(releaseVersion("app-v2.0.0-rc.1")).toBe("2.0.0-rc.1");
    expect(releaseVersion("latest")).toBeNull();
    expect(fillUrl("https://x.test/{tag}/{name}?v={version}", { tag: "release/v1 0", label: "v1", version: "1", name: "a b.tgz" })).toBe("https://x.test/release/v1%200/a%20b.tgz?v=1");
    expect(renderFormula('version "{{ version }}" # #{bin}', { version: "1.0", label: "v1.0", tag: "t" }, new Map())).toBe('version "1.0" # #{bin}');
  });
});
