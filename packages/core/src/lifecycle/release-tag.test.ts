import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkTagCollisions,
  findTagCollision,
  labelOfTag,
  memberTags,
  renderFloatingTag,
  renderReleaseTag,
  resolveTagTemplate,
  shapesOverlap,
  tagShape,
  ReleaseTagError,
  type MemberTags,
  type TagPlace,
} from "./release-tag";
import { releaseTagName } from "./release-workstation";
import { floatingTagPlan } from "./release-publish";

const root: TagPlace = { member: null, path: null };
const core: TagPlace = { member: "npm/core", path: "release/core" };
const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (err) {
    return err instanceof ReleaseTagError ? err.code : String(err);
  }
  return undefined;
};

describe("release.tag templates (#5150)", () => {
  test("an unset release.tag makes exactly the tags chant always made", () => {
    for (const [place, label] of [[root, "1.4.0"], [core, "0.125.0"], [{ member: "services/api", path: "services/api" }, "v1.2.0"]] as const) {
      const t = resolveTagTemplate(undefined, place.member);
      expect(t.legacy).toBe(true);
      expect(renderReleaseTag(t, place, label)).toBe(releaseTagName(place.member, label));
    }
    expect(renderReleaseTag(resolveTagTemplate(undefined, null), root, "v1.2.0")).toBe("release/v1.2.0");
    expect(renderReleaseTag(resolveTagTemplate(undefined, "npm/core"), core, "0.125.0")).toBe("release/npm/core/0.125.0");
  });

  test("placeholders: {version} drops one leading v, {label} keeps it, {member} and {path} fill in", () => {
    const t = (s: string) => resolveTagTemplate(s, core.member);
    expect(renderReleaseTag(t("v{version}"), core, "1.4.0")).toBe("v1.4.0");
    expect(renderReleaseTag(t("v{version}"), core, "v1.4.0")).toBe("v1.4.0");
    expect(renderReleaseTag(t("{label}"), core, "v1.4.0")).toBe("v1.4.0");
    expect(renderReleaseTag(t("cli-v{version}"), core, "2.0.0-rc.1")).toBe("cli-v2.0.0-rc.1");
    expect(renderReleaseTag(t("{member}/v{version}"), core, "1.0.0")).toBe("npm/core/v1.0.0");
    expect(renderReleaseTag(t("{path}/v{version}"), core, "1.0.0")).toBe("release/core/v1.0.0");
  });

  test("a template that is not one is refused", () => {
    for (const bad of ["release", "v{version}-{label}", "v{major}", "{nope}/{version}", "v{version", "/v{version}", "a..b{version}", "tags/{version}.lock", "v {version}"]) {
      expect(codeOf(() => resolveTagTemplate(bad, null)), bad).toBe("release-tag-template-invalid");
    }
    expect(codeOf(() => resolveTagTemplate({ name: "v{version}", floating: "v{version}" }, null))).toBe("release-tag-template-invalid");
    expect(codeOf(() => renderReleaseTag(resolveTagTemplate("{member}-v{version}", null), root, "1.0.0"))).toBe("release-tag-template-invalid");
    expect(codeOf(() => renderReleaseTag(resolveTagTemplate("{path}/v{version}", null), root, "1.0.0"))).toBe("release-tag-template-invalid");
  });

  test("the floating tag names the major of a stable version only", () => {
    const t = resolveTagTemplate({ name: "v{version}", floating: "v{major}" }, null);
    expect(renderFloatingTag(t, root, "1.4.2")).toBe("v1");
    expect(renderFloatingTag(t, root, "v12.0.0")).toBe("v12");
    expect(renderFloatingTag(t, root, "1.5.0-rc.1")).toBeNull();
    expect(renderFloatingTag(resolveTagTemplate("v{version}", null), root, "1.4.2")).toBeNull();
  });

  test("a tag is read back through the ledger's labels, never parsed", () => {
    const t = resolveTagTemplate("v{version}", null);
    expect(labelOfTag(t, root, "v1.4.0", ["1.3.0", "v1.4.0"])).toBe("v1.4.0");
    expect(labelOfTag(t, root, "v1.4.0", ["1.3.0", "1.4.0"])).toBe("1.4.0");
    expect(labelOfTag(t, root, "v1", ["1.4.0"])).toBeNull();
  });

  test("shapes overlap when some tag fits both", () => {
    const s = (template: string, place: TagPlace = root) => tagShape(template, place);
    expect(shapesOverlap(s("release/{label}"), s("release/npm/core/{label}"))).toBe(false);
    expect(shapesOverlap(s("v{version}"), s("cli-v{version}"))).toBe(false);
    expect(shapesOverlap(s("v{version}"), s("v{version}-cli"))).toBe(true);
    expect(shapesOverlap(s("v{version}"), s("{label}"))).toBe(true);
    expect(shapesOverlap(s("core/v{version}"), s("v{version}"))).toBe(false);
    expect(shapesOverlap(s("v{version}"), s("v{major}"))).toBe(true);
    expect(shapesOverlap(s("a-{label}"), s("{label}-b"))).toBe(true);
  });

  test("templates that can collide across members are found; a member's own pair is not", () => {
    const m = (member: string | null, tag: Parameters<typeof resolveTagTemplate>[0]): MemberTags => ({ place: { member, path: member }, template: resolveTagTemplate(tag, member) });
    expect(findTagCollision([m("cli", "v{version}"), m("lib", "v{version}")])).not.toBeNull();
    expect(findTagCollision([m("cli", "{member}-v{version}"), m("lib", "{member}-v{version}")])).toBeNull();
    expect(findTagCollision([m("cli", "cli-v{version}"), m("lib", "lib-v{version}")])).toBeNull();
    expect(findTagCollision([m("cli", { name: "v{version}", floating: "v{major}" })])).toBeNull();
    expect(findTagCollision([m("cli", "{label}"), m("lib", undefined)])).toBeNull();
    expect(findTagCollision([m(null, "release/{label}"), m("lib", undefined)])).toBeNull();
    expect(findTagCollision([m("action", { name: "action-v{version}", floating: "v{major}" }), m("cli", "v{version}")])).not.toBeNull();
  });

  test("the floating tag moves only for the newest stable release of its major, with no channel", () => {
    const tags: MemberTags = { place: root, template: resolveTagTemplate({ name: "v{version}", floating: "v{major}" }, null) };
    expect(floatingTagPlan(tags, "1.4.0", "c", null, ["1.3.0", "1.4.0", "2.0.0"])).toEqual({ name: "v1", commit: "c", move: true, reason: null });
    expect(floatingTagPlan(tags, "1.3.1", "c", null, ["1.3.1", "1.4.0"])?.move).toBe(false);
    expect(floatingTagPlan(tags, "1.4.0", "c", "beta", ["1.4.0"])?.move).toBe(false);
    // #5166: a prerelease label leaves the floating tag where it is, by the shared prerelease check.
    expect(floatingTagPlan(tags, "1.5.0-rc.1", "c", null, [])).toEqual({ name: "v1", commit: "c", move: false, reason: "1.5.0-rc.1 is a prerelease, and only a stable version moves it" });
    expect(floatingTagPlan(tags, "v2.0.0-beta.3", "c", null, ["1.4.0"])?.move).toBe(false);
    expect(floatingTagPlan({ place: root, template: resolveTagTemplate("v{version}", null) }, "1.4.0", "c", null, [])).toBeNull();
  });
});

describe("tag collisions in a workspace (#5150)", () => {
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  const workspace = (tags: Record<string, string | null>): string => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "chant-release-tag-")));
    git(dir, "init", "-q");
    writeFileSync(join(dir, "chant.workspace.json"), JSON.stringify({ name: "w", schema: 1, members: Object.keys(tags).map((name) => ({ name, dir: `packages/${name}`, kind: "chant" })) }, null, 2));
    for (const [name, tag] of Object.entries(tags)) {
      mkdirSync(join(dir, "packages", name), { recursive: true });
      writeFileSync(join(dir, "packages", name, "chant.config.ts"), `export default { release: { ${tag ? `tag: ${JSON.stringify(tag)}` : ""} } };\n`);
    }
    return dir;
  };

  test("a member whose template can make another member's tag is refused", async () => {
    const dir = workspace({ cli: "v{version}", lib: "v{version}" });
    const cli = join(dir, "packages", "cli");
    const own = await memberTags(cli);
    expect(own.place).toEqual({ member: "cli", path: "packages/cli" });
    await expect(checkTagCollisions(cli, own)).rejects.toMatchObject({ code: "release-tag-collision" });
  });

  test("{member} keeps members apart, and a legacy sibling never collides", async () => {
    const dir = workspace({ cli: "{member}-v{version}", lib: "{member}-v{version}", old: null });
    const cli = join(dir, "packages", "cli");
    await expect(checkTagCollisions(cli, await memberTags(cli))).resolves.toBeUndefined();
  });
});
