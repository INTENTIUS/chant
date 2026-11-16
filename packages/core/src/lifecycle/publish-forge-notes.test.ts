/** #4658, #5153: a forge release's notes, read from a section of a file in the member, generated, or both. */
import { afterAll, describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRedactor } from "./publish-credentials";
import { PublishDeclarationSchema } from "./publish-declaration";
import { memberCommits, releaseNotesSection } from "./publish-forge";
import { createPublishTargets } from "./publish-targets";
import { PublishTargetError, type PublishContext } from "./release-publish";
import { appendCut, makeRelease, persistRelease } from "./release-store";
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

  test("a prerelease label marks the release a prerelease, on GitHub and Forgejo, and GitHub never makes it latest", async () => {
    const dir = member();
    for (const forgeName of ["github", "forgejo"] as const) {
      const api = forgeName === "github" ? "https://api.github.test" : "https://forgejo.test/api/v1";
      const forge = startFakeForge(forgeName, api, "acme/api");
      const [t] = await createPublishTargets([decl({ type: "forge", forge: forgeName, repo: "acme/api", api, assets: ["api-linux.tar.gz"], ...(forgeName === "github" ? { latest: true } : {}) })], { fetch: forge.fetch });
      const ctx = context(dir, { env: { GITHUB_TOKEN: "ghs_x", FORGEJO_TOKEN: "fj" }, label: "v1.4.0-rc.1" });
      await t!.reveal(ctx, await t!.stage(ctx));
      expect(forge.releases[0]).toMatchObject({ draft: false, prerelease: true });
      if (forgeName === "github") expect(forge.releases[0]!.make_latest).toBe("false");
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

/** #5153: notes generated for the release, from the member's commits or by the forge. */
describe("a forge release's generated notes (#5153)", () => {
  const gitIn = (dir: string, ...args: string[]): string => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const commit = (dir: string, file: string, message: string): string => {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), `${message}\n`);
    gitIn(dir, "add", ".");
    gitIn(dir, "commit", "-q", "-m", message);
    return gitIn(dir, "rev-parse", "HEAD");
  };
  const subject = (sha: string) => ({ member: null, commit: sha, artifactDigests: [], targets: [{ env: "dev", params: [], templates: [] }] });

  /** A repo whose v1.0.0 was cut before four more commits; the release being published is v1.1.0 at the last. */
  async function repo(): Promise<{ dir: string; first: string; head: string; ctx: (over?: Partial<PublishContext>) => PublishContext & { lines: string[] } }> {
    const dir = member();
    gitIn(dir, "init", "-q", "-b", "main");
    gitIn(dir, "config", "user.email", "t@chant.dev");
    gitIn(dir, "config", "user.name", "T");
    writeFileSync(join(dir, ".gitignore"), "");
    commit(dir, "src/a.ts", "chore: start");
    const first = commit(dir, "src/b.ts", "feat: first feature");
    const prev = makeRelease(subject(first));
    await persistRelease(prev, [], { cwd: dir });
    await appendCut({ releaseDigest: prev.releaseDigest, label: "v1.0.0", actor: "ci", timestamp: "2026-11-01T00:00:00.000Z", runOrigin: null, signature: null }, { cwd: dir });
    commit(dir, "src/c.ts", "feat(api): stream responses");
    commit(dir, "src/d.ts", "fix: close the socket");
    commit(dir, "src/e.ts", "chore: tidy");
    const head = commit(dir, "src/f.ts", "refactor!: rename the config key");
    const release = makeRelease(subject(head));
    return { dir, first, head, ctx: (over = {}) => context(dir, { release, label: "v1.1.0", releaseTag: "release/v1.1.0", ...over }) };
  }
  const short = (sha: string) => sha.slice(0, 7);
  const FROM_COMMITS = (dir: string) => {
    const log = gitIn(dir, "log", "--format=%H %s", "-4").split("\n").map((l) => [l.slice(0, 40), l.slice(41)] as const);
    const sha = (s: string) => short(log.find(([, m]) => m === s)![0]);
    return [
      "### Breaking changes",
      "",
      `- rename the config key (${sha("refactor!: rename the config key")})`,
      "",
      "### Features",
      "",
      `- api: stream responses (${sha("feat(api): stream responses")})`,
      "",
      "### Fixes",
      "",
      `- close the socket (${sha("fix: close the socket")})`,
    ].join("\n");
  };
  const GH = { type: "forge", forge: "github", repo: "acme/api", api: "https://api.github.test", assets: [], sbom: false } as const;

  test("commits: the plan lists the conventional commits since the previous release, after the file's section and between before and after", async () => {
    const { dir, ctx } = await repo();
    const forge = startFakeForge("github", "https://api.github.test", "acme/api");
    const notes = { ...NOTES, generate: "commits", before: "Release {version}.", after: "Tag {tag}." };
    const [t] = await createPublishTargets([decl({ ...GH, notes })], { fetch: forge.fetch });
    const items = await t!.plan(ctx({ env: { GITHUB_TOKEN: "ghs_x" }, label: "v1.4.0", releaseTag: "release/v1.4.0" }));
    expect(items.at(-1)!.notes).toBe(`Release 1.4.0.\n\n${SECTION}\n\n${FROM_COMMITS(dir)}\n\nTag release/v1.4.0.\n`);
    expect(items.at(-1)!.notes).not.toContain("first feature");
    expect(forge.calls).toEqual([]);
  });

  test("commits: types narrows the list, and generated notes alone need no file", async () => {
    const { ctx } = await repo();
    const forge = startFakeForge("github", "https://api.github.test", "acme/api");
    const [t] = await createPublishTargets([decl({ ...GH, notes: { generate: "commits", types: ["chore"] } })], { fetch: forge.fetch });
    const [item] = await t!.plan(ctx({ env: { GITHUB_TOKEN: "ghs_x" } }));
    expect(item).toMatchObject({ name: "generated notes", destination: "github acme/api release release/v1.1.0, notes" });
    expect(item!.notes).toMatch(/^### Breaking changes\n\n- rename the config key \(\w{7}\)\n\n### Other changes\n\n- tidy \(\w{7}\)\n$/);
  });

  test("commits: the member's first release lists every commit in the member", async () => {
    const { ctx, first } = await repo();
    const forge = startFakeForge("github", "https://api.github.test", "acme/api");
    const [t] = await createPublishTargets([decl({ ...GH, notes: { generate: "commits" } })], { fetch: forge.fetch });
    const [item] = await t!.plan(ctx({ env: { GITHUB_TOKEN: "ghs_x" }, release: makeRelease(subject(first)), label: "v1.0.0", releaseTag: "release/v1.0.0" }));
    expect(item!.notes).toBe(`### Features\n\n- first feature (${short(first)})\n`);
  });

  test("the stage decides the notes: the draft carries them, the record keeps them, and the reveal publishes those", async () => {
    const { dir, ctx } = await repo();
    const forge = startFakeForge("github", "https://api.github.test", "acme/api");
    const [t] = await createPublishTargets([decl({ ...GH, notes: { generate: "commits" } })], { fetch: forge.fetch });
    const c = ctx({ env: { GITHUB_TOKEN: "ghs_x" } });
    const staged = await t!.stage(c);
    const decided = `${FROM_COMMITS(dir)}\n`;
    expect(forge.releases[0]).toMatchObject({ draft: true, body: decided });
    expect(staged.state.notes).toBe(decided);
    // What the reveal publishes is the record's, even when deciding again would give something else.
    await t!.reveal(c, { ...staged, state: { ...staged.state, notes: "as staged" } });
    expect(forge.releases[0]).toMatchObject({ draft: false, body: "as staged" });
  });

  test("a draft an earlier stage left without notes is given them when the stage runs again", async () => {
    const { dir, head, ctx } = await repo();
    const forge = startFakeForge("github", "https://api.github.test", "acme/api", [{ id: 7, tag_name: "release/v1.1.0", draft: true, target: head, assets: [] }]);
    const [t] = await createPublishTargets([decl({ ...GH, notes: { generate: "commits" } })], { fetch: forge.fetch });
    await t!.stage(ctx({ env: { GITHUB_TOKEN: "ghs_x" } }));
    expect(forge.releases).toHaveLength(1);
    expect(forge.releases[0]).toMatchObject({ id: 7, draft: true, body: `${FROM_COMMITS(dir)}\n` });
  });

  test("GitHub forge notes: generate-notes is asked at the stage since the previous release's tag; the plan only names them", async () => {
    const { head, ctx } = await repo();
    const forge = startFakeForge("github", "https://api.github.test", "acme/api");
    const [t] = await createPublishTargets([decl({ ...GH, notes: { ...NOTES, generate: "forge" } })], { fetch: forge.fetch });
    const c = ctx({ env: { GITHUB_TOKEN: "ghs_x" }, label: "v1.4.0", releaseTag: "release/v1.4.0" });
    const [item] = await t!.plan(c);
    expect(item!.notes).toBe(`${SECTION}\n\n(GitHub's generated notes since release/v1.0.0, made when the release stages)\n`);
    expect(forge.calls).toEqual([]);
    await t!.reveal(c, await t!.stage(c));
    const asked = forge.calls.find((x) => x.url.endsWith("/releases/generate-notes"))!;
    expect(JSON.parse(asked.body as string)).toEqual({ tag_name: "release/v1.4.0", target_commitish: head, previous_tag_name: "release/v1.0.0" });
    const body = `${SECTION}\n\ngenerated: tag_name=release/v1.4.0 target_commitish=${head} previous_tag_name=release/v1.0.0\n`;
    expect(forge.releases[0]).toMatchObject({ draft: false, body });
    expect(forge.calls.filter((x) => x.url.endsWith("/releases/generate-notes"))).toHaveLength(1);
  });

  test("GitLab forge notes: the changelog API from the previous release's commit, as the release's description", async () => {
    const { first, head, ctx } = await repo();
    const api = "https://gitlab.test/api/v4";
    const forge = startFakeForge("gitlab", api, "acme/api");
    const [t] = await createPublishTargets([decl({ type: "forge", forge: "gitlab", repo: "acme/api", assets: [], sbom: false, notes: { generate: "forge" } })], { fetch: forge.fetch });
    const c = ctx({ env: { GITLAB_TOKEN: "glpat", CI_API_V4_URL: api } });
    const staged = await t!.stage(c);
    await t!.reveal(c, staged);
    expect(JSON.parse(forge.calls.at(-1)!.body as string).description).toBe(`generated: version=1.1.0 to=${head} from=${first}\n`);
  });

  test("Forgejo has no generated notes, so forge notes are refused at the plan", async () => {
    const { ctx } = await repo();
    const forge = startFakeForge("forgejo", "https://forgejo.test/api/v1", "acme/api");
    const [t] = await createPublishTargets([decl({ type: "forge", forge: "forgejo", repo: "acme/api", api: "https://forgejo.test/api/v1", assets: [], sbom: false, notes: { generate: "forge" } })], { fetch: forge.fetch });
    const err = await t!.plan(ctx({ env: { FORGEJO_TOKEN: "fj" } })).catch((e: unknown) => e);
    expect((err as PublishTargetError).code).toBe("publish-forge-notes-unsupported");
    expect(forge.calls).toEqual([]);
  });

  test("notes generated outside a git checkout are refused", async () => {
    const dir = member();
    const [t] = await createPublishTargets([decl({ ...GH, notes: { generate: "commits" } })], { fetch: startFakeForge("github", "https://api.github.test", "acme/api").fetch });
    const err = await t!.plan(context(dir, { env: { GITHUB_TOKEN: "ghs_x" } })).catch((e: unknown) => e);
    expect((err as PublishTargetError).code).toBe("publish-forge-notes-history");
  });

  test("only the commits in the member's directory are listed", async () => {
    const { dir, head } = await repo();
    commit(dir, "web/x.ts", "feat: web only");
    const top = gitIn(dir, "rev-parse", "HEAD");
    const inSrc = memberCommits({ cwd: join(dir, "src"), release: makeRelease(subject(top)) }, head, "github");
    const inWeb = memberCommits({ cwd: join(dir, "web"), release: makeRelease(subject(top)) }, head, "github");
    expect(inSrc).toEqual([]);
    expect(inWeb.map((c) => c.message)).toEqual(["feat: web only"]);
  });

  test("the declaration: file and heading go together, notes need a source, and types needs commits", () => {
    expect(() => decl({ ...GH, notes: { file: "CHANGES.md" } })).toThrow(/go together/);
    expect(() => decl({ ...GH, notes: { before: "x" } })).toThrow(/file section, generate, or both/);
    expect(() => decl({ ...GH, notes: { generate: "forge", types: ["feat"] } })).toThrow(/notes.types applies to generate/);
  });
});
