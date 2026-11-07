/** #4658: a forge release's notes, read from a section of a file in the member. */
import { afterAll, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRedactor } from "./publish-credentials";
import { PublishDeclarationSchema } from "./publish-declaration";
import { releaseNotesSection } from "./publish-forge";
import { createPublishTargets } from "./publish-targets";
import { PublishTargetError, type PublishContext } from "./release-publish";
import { makeRelease } from "./release-store";
import { startFakeForge, writeLockfile } from "./__fixtures__/publish-fakes";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const CHANGES = [
  "# Changes",
  "",
  "## In 1.4.0",
  "",
  "- `api` reads its [config](/docs/config/) once.",
  "- See [the guide](https://example.com/guide) and [a section](#later).",
  "",
  "```sh",
  "# not a heading",
  "api run",
  "```",
  "",
  "### Fixed",
  "",
  "- a crash on start",
  "",
  "## In 1.3.0",
  "",
  "- older",
  "",
].join("\n");

function member(): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-notes-"));
  dirs.push(dir);
  writeFileSync(join(dir, "api-linux.tar.gz"), "binary bytes");
  writeFileSync(join(dir, "CHANGES.md"), CHANGES);
  writeLockfile(dir);
  return dir;
}

function context(cwd: string, over: Partial<PublishContext> = {}): PublishContext & { lines: string[] } {
  const env = over.env ?? {};
  const redactor = createRedactor(env);
  const lines: string[] = [];
  return {
    release: makeRelease({ member: null, commit: "c0ffee".padEnd(40, "0"), artifactDigests: [], targets: [{ env: "dev", params: [], templates: [] }] }),
    label: "v1.4.0",
    releaseTag: "release/v1.4.0",
    provenance: { oidc: false, ci: null, reason: "not in CI" },
    cwd,
    tag: null,
    env,
    redactor,
    log: (l) => lines.push(redactor.redact(l)),
    ...over,
    lines,
  };
}

const decl = (d: unknown) => PublishDeclarationSchema.parse(d);
const NOTES = { file: "CHANGES.md", heading: "## In {version}", linkBase: "https://docs.example.com" };
const SECTION = [
  "- `api` reads its [config](https://docs.example.com/docs/config/) once.",
  "- See [the guide](https://example.com/guide) and [a section](#later).",
  "",
  "```sh",
  "# not a heading",
  "api run",
  "```",
  "",
  "### Fixed",
  "",
  "- a crash on start",
].join("\n");

describe("releaseNotesSection (#4658)", () => {
  test("the section runs to the next heading of its level, past code and lower headings, with root links made absolute", () => {
    expect(releaseNotesSection(CHANGES, "## In 1.4.0", "https://docs.example.com/")).toBe(SECTION);
  });

  test("a changelog's version heading with a date matches; a longer version or a prerelease does not", () => {
    const log = "## [1.2.30] - 2026-11-01\n\n- no\n\n## [1.2.3] - 2026-10-01\n\n- yes\n\n## 1.2.3-rc.1\n\n- no\n";
    expect(releaseNotesSection(log, "## [1.2.3]")).toBe("- yes");
    expect(() => releaseNotesSection("## 1.2.3-rc.1\n\n- rc\n", "## 1.2.3")).toThrow(/no heading "## 1.2.3"/);
  });

  test("a missing or empty section is an error", () => {
    expect(() => releaseNotesSection(CHANGES, "## In 9.9.9")).toThrow(/no heading/);
    expect(() => releaseNotesSection("## In 1.4.0\n\n## In 1.3.0\n- x\n", "## In 1.4.0")).toThrow(/section is empty/);
  });
});

describe("a forge release's notes (#4658)", () => {
  test("the plan carries the notes, with before and after filled in, so a dry run prints them", async () => {
    const dir = member();
    const forge = startFakeForge("github", "https://api.github.test", "acme/api");
    const notes = { ...NOTES, before: "`@acme/api@{version}` on npm.", after: "Tag {tag}, label {label}." };
    const [t] = await createPublishTargets([decl({ type: "forge", forge: "github", repo: "acme/api", api: "https://api.github.test", assets: ["api-linux.tar.gz"], notes })], { fetch: forge.fetch });
    const items = await t!.plan(context(dir, { env: { GITHUB_TOKEN: "ghs_x" } }));
    expect(items.at(-1)).toEqual({
      name: "CHANGES.md",
      destination: "github acme/api release release/v1.4.0, notes",
      notes: `\`@acme/api@1.4.0\` on npm.\n\n${SECTION}\n\nTag release/v1.4.0, label v1.4.0.\n`,
    });
    expect(forge.calls).toEqual([]);
  });

  test("a missing section refuses at the plan, before anything is sent", async () => {
    const dir = member();
    const forge = startFakeForge("github", "https://api.github.test", "acme/api");
    for (const notes of [{ ...NOTES, heading: "## In 2.0.0" }, { ...NOTES, file: "NOPE.md" }]) {
      const [t] = await createPublishTargets([decl({ type: "forge", forge: "github", repo: "acme/api", api: "https://api.github.test", assets: ["api-linux.tar.gz"], notes })], { fetch: forge.fetch });
      const err = await t!.plan(context(dir, { env: { GITHUB_TOKEN: "ghs_x" } })).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PublishTargetError);
      expect((err as PublishTargetError).code).toBe("publish-forge-notes-missing");
    }
    expect(forge.calls).toEqual([]);
  });

  test("GitHub: the draft and the published release carry the notes, and the release is made latest", async () => {
    const dir = member();
    const forge = startFakeForge("github", "https://api.github.test", "acme/api");
    const [t] = await createPublishTargets([decl({ type: "forge", forge: "github", repo: "acme/api", api: "https://api.github.test", assets: ["api-linux.tar.gz"], notes: NOTES })], { fetch: forge.fetch });
    const ctx = context(dir, { env: { GITHUB_TOKEN: "ghs_x" } });
    const staged = await t!.stage(ctx);
    expect(forge.releases[0]).toMatchObject({ draft: true, body: `${SECTION}\n` });
    await t!.reveal(ctx, staged);
    expect(forge.releases[0]).toMatchObject({ draft: false, body: `${SECTION}\n`, make_latest: "true" });

    // A publish run again finds the release published and sends nothing that would change its notes.
    forge.releases[0]!.body = "edited by hand";
    const n = forge.calls.length;
    const again = await t!.stage(ctx);
    await t!.reveal(ctx, again);
    expect(forge.calls.slice(n).map((c) => c.method)).toEqual(["GET"]);
    expect(forge.releases[0]!.body).toBe("edited by hand");
  });

  test("GitHub: a release cut to a channel is not made latest, and a declared latest wins", async () => {
    const dir = member();
    for (const [latest, sent] of [[undefined, "false"], [true, "true"]] as const) {
      const forge = startFakeForge("github", "https://api.github.test", "acme/api");
      const [t] = await createPublishTargets([decl({ type: "forge", forge: "github", repo: "acme/api", api: "https://api.github.test", assets: ["api-linux.tar.gz"], notes: NOTES, ...(latest !== undefined ? { latest } : {}) })], { fetch: forge.fetch });
      const ctx = context(dir, { env: { GITHUB_TOKEN: "ghs_x" }, tag: "beta" });
      await t!.reveal(ctx, await t!.stage(ctx));
      expect(forge.releases[0]!.make_latest).toBe(sent);
    }
  });

  test("Forgejo: the notes are the release's body, and a channel's release is a prerelease", async () => {
    const dir = member();
    for (const [tag, prerelease] of [[null, undefined], ["beta", true]] as const) {
      const forge = startFakeForge("forgejo", "https://forgejo.test/api/v1", "acme/api");
      const [t] = await createPublishTargets([decl({ type: "forge", forge: "forgejo", repo: "acme/api", api: "https://forgejo.test/api/v1", assets: ["api-linux.tar.gz"], notes: NOTES })], { fetch: forge.fetch });
      const ctx = context(dir, { env: { FORGEJO_TOKEN: "fj" }, tag });
      await t!.reveal(ctx, await t!.stage(ctx));
      expect(forge.releases[0]).toMatchObject({ draft: false, body: `${SECTION}\n` });
      expect(forge.releases[0]!.prerelease).toBe(prerelease);
      expect(JSON.parse(forge.calls.at(-1)!.body as string)).not.toHaveProperty("make_latest");
    }
  });

  test("GitLab: the notes are the release's description", async () => {
    const dir = member();
    const api = "https://gitlab.test/api/v4";
    const forge = startFakeForge("gitlab", api, "acme/api");
    const [t] = await createPublishTargets([decl({ type: "forge", forge: "gitlab", repo: "acme/api", assets: ["api-linux.tar.gz"], notes: NOTES })], { fetch: forge.fetch });
    const ctx = context(dir, { env: { GITLAB_TOKEN: "glpat", CI_API_V4_URL: api } });
    await t!.reveal(ctx, await t!.stage(ctx));
    expect(JSON.parse(forge.calls.at(-1)!.body as string).description).toBe(`${SECTION}\n`);
  });

  test("a release of notes alone needs no assets and attaches no provenance statement; with neither, the declaration is refused", async () => {
    const dir = member();
    const forge = startFakeForge("github", "https://api.github.test", "acme/api");
    const [t] = await createPublishTargets([decl({ type: "forge", forge: "github", repo: "acme/api", api: "https://api.github.test", assets: [], sbom: false, notes: NOTES })], { fetch: forge.fetch });
    const ctx = context(dir, { env: { GITHUB_TOKEN: "ghs_x" } });
    await t!.reveal(ctx, await t!.stage(ctx));
    expect(forge.visible()).toEqual([{ tag: "release/v1.4.0", assets: [] }]);
    expect(forge.releases[0]!.body).toBe(`${SECTION}\n`);
    expect(() => decl({ type: "forge", forge: "github", repo: "acme/api", assets: [] })).toThrow(/assets, notes or both/);
  });
});
