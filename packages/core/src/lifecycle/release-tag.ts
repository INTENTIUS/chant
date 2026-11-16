/**
 * The tag a release cut makes, from `release.tag` in the member's
 * `chant.config.ts` (#5150).
 *
 * `release.tag` is a template: `v{version}`, `cli-v{version}`,
 * `{member}/v{version}` or `{path}/v{version}` for a Go module in a
 * subdirectory. Its placeholders:
 *
 * - `{version}`: the label, with one leading `v` dropped when a digit
 *   follows it, so `v{version}` gives `v1.4.0` for the labels `1.4.0` and
 *   `v1.4.0` alike;
 * - `{label}`: the label as given;
 * - `{member}`: the member's ledger name, outermost first and joined by `/`
 *   (`npm/core` for the member `core` of a nested workspace `npm`);
 * - `{path}`: the member's directory from the repository root.
 *
 * The object form adds `floating`, a second template with `{major}` (and
 * `{member}`, `{path}`) for a tag that `chant release publish` moves to the
 * release's commit once every target has revealed, such as `v1` for a
 * GitHub Action. The cut never makes it.
 *
 * A member that sets no `release.tag` gets the tag it always got,
 * `release/<label>`, or `release/<member>/<label>` in a workspace member.
 * That default is written here as the template `release/{label}` or
 * `release/{member}/{label}`, so the rest of the code has one shape.
 *
 * The ledger names a release by its record, not by its tag: a tag is found
 * from a label by rendering the template, and a label from a tag by
 * rendering the template for each label the member's ledger holds
 * ({@link labelOfTag}). Nothing parses a tag.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { prereleaseOf } from "./release-prerelease";
import { NEXT_RELEASE } from "../release-floors";

/** The first chant with `release.tag` in `chant.config.ts`: the cut makes the tag the template renders (`{version}`, `{label}`, `{member}`, `{path}`), refuses one another member's template can render (`release-tag-collision`), `chant release tag` reads a release back from its tag through the ledger, `chant release publish` moves a `floating` tag at reveal, and `chant release workflow` triggers on the template's tags (#5150). */
export const RELEASE_TAG_FLOOR = NEXT_RELEASE;

/** `release.tag` in `chant.config.ts`. */
export type ReleaseTagConfig = string | { name: string; floating?: string };

export type ReleaseTagCode = "release-tag-template-invalid" | "release-tag-collision";

/** A template refused. */
export class ReleaseTagError extends Error {
  constructor(
    readonly code: ReleaseTagCode,
    message: string,
    readonly fix?: string,
  ) {
    super(message);
    this.name = "ReleaseTagError";
  }
}

/** A member's tag templates, checked. */
export interface ReleaseTagTemplate {
  /** The release's own tag. */
  name: string;
  /** The floating tag publish moves, or null. */
  floating: string | null;
  /** True when the config sets no `release.tag` and the tag is the one chant always made. */
  legacy: boolean;
}

/** Where a member's templates are rendered: its ledger name and its directory from the repository root. */
export interface TagPlace {
  member: string | null;
  path: string | null;
}

const NAME_PLACEHOLDERS = ["version", "label", "member", "path"] as const;
const FLOATING_PLACEHOLDERS = ["major", "member", "path"] as const;
/** What a label may hold (`release-store.ts` LABEL_PATTERN): letters, digits and `. _ + -`, so never `/`. */
const LABEL_CHAR = /^[A-Za-z0-9._+-]$/;

/** The default template for a member that sets no `release.tag`. */
export function legacyTagTemplate(member: string | null): string {
  return member ? "release/{member}/{label}" : "release/{label}";
}

function placeholdersOf(template: string): string[] {
  return [...template.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]!);
}

function checkTemplate(field: string, template: string, allowed: readonly string[], variables: readonly string[]): void {
  const fail = (why: string, fix?: string): never => {
    throw new ReleaseTagError("release-tag-template-invalid", `${field} "${template}" ${why}`, fix);
  };
  const literal = template.replace(/\{[^{}]*\}/g, "");
  if (/[{}]/.test(literal)) fail("has a brace that opens or closes no placeholder");
  for (const p of placeholdersOf(template)) if (!allowed.includes(p)) fail(`names {${p}}, which is not one of ${allowed.map((a) => `{${a}}`).join(", ")}`);
  const vars = placeholdersOf(template).filter((p) => variables.includes(p));
  if (vars.length !== 1) {
    fail(
      vars.length === 0 ? `has no ${variables.map((v) => `{${v}}`).join(" or ")}, so every release would get the same tag` : `names ${vars.map((v) => `{${v}}`).join(" and ")}; a tag holds one`,
      `Name it once, as in ${field.endsWith("floating") ? "v{major}" : "v{version}"}.`,
    );
  }
  if (!/^[A-Za-z0-9._+/{}-]+$/.test(template)) fail("holds a character a tag name can't: use letters, digits and . _ + - /");
  if (template.startsWith("/") || template.endsWith("/") || template.includes("//")) fail("starts or ends with /, or holds //");
  if (template.includes("..") || template.endsWith(".") || template.endsWith(".lock") || /(^|\/)\./.test(template)) fail("makes a tag name git refuses: no .., no component that starts with a dot, and no trailing . or .lock");
}

/**
 * The templates `release.tag` declares, checked, or the legacy default when
 * it declares none. Throws {@link ReleaseTagError} `release-tag-template-invalid`.
 */
export function resolveTagTemplate(config: ReleaseTagConfig | undefined, member: string | null): ReleaseTagTemplate {
  if (config === undefined) return { name: legacyTagTemplate(member), floating: null, legacy: true };
  const name = typeof config === "string" ? config : config.name;
  const floating = typeof config === "string" ? null : (config.floating ?? null);
  checkTemplate("release.tag", name, NAME_PLACEHOLDERS, ["version", "label"]);
  if (floating !== null) checkTemplate("release.tag.floating", floating, FLOATING_PLACEHOLDERS, ["major"]);
  return { name, floating, legacy: false };
}

/** The label as `{version}` gives it: one leading `v` dropped when a digit follows. */
export function versionOfLabel(label: string): string {
  return /^v\d/.test(label) ? label.slice(1) : label;
}

function fill(template: string, place: TagPlace, values: Record<string, string>): string {
  return template.replace(/\{([^{}]*)\}/g, (_, p: string) => {
    if (p === "member") {
      if (!place.member) throw new ReleaseTagError("release-tag-template-invalid", `release.tag "${template}" names {member}, and this project is not a workspace member`, "Use a literal prefix, or {path}.");
      return place.member;
    }
    if (p === "path") {
      if (!place.path) throw new ReleaseTagError("release-tag-template-invalid", `release.tag "${template}" names {path}, and this project is at the repository root`, "Use a literal prefix, or drop {path}.");
      return place.path;
    }
    const v = values[p];
    if (v === undefined) throw new ReleaseTagError("release-tag-template-invalid", `release.tag "${template}" names {${p}}, which has no value here`);
    return v;
  });
}

/** The tag a release labelled `label` gets. */
export function renderReleaseTag(t: ReleaseTagTemplate, place: TagPlace, label: string): string {
  return fill(t.name, place, { version: versionOfLabel(label), label });
}

/** The stable MAJOR.MINOR.PATCH a label names, or null for a prerelease or anything else. */
export function stableVersionOf(label: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(versionOfLabel(label));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * The floating tag of the major line a label belongs to, prerelease or not,
 * or null: no `floating`, or a label that names no MAJOR.MINOR.PATCH.
 */
export function floatingTagOfLine(t: ReleaseTagTemplate, place: TagPlace, label: string): string | null {
  if (t.floating === null) return null;
  const m = /^(\d+)\.\d+\.\d+(?:[-+].*)?$/.exec(versionOfLabel(label));
  return m ? fill(t.floating, place, { major: String(Number(m[1])) }) : null;
}

/**
 * The floating tag a release labelled `label` moves, or null: no `floating`,
 * a prerelease label (#5166, the same check every publish target makes), or
 * a label that is not a stable version.
 */
export function renderFloatingTag(t: ReleaseTagTemplate, place: TagPlace, label: string): string | null {
  if (prereleaseOf(label) !== null || stableVersionOf(label) === null) return null;
  return floatingTagOfLine(t, place, label);
}

/**
 * Which of `labels` has the tag `tag` (or, for `floating`, moves it), read
 * through the template: the ledger names the release, and the tag is only
 * its rendering. Null when none does.
 */
export function labelOfTag(t: ReleaseTagTemplate, place: TagPlace, tag: string, labels: Iterable<string>): string | null {
  for (const label of labels) {
    try {
      if (renderReleaseTag(t, place, label) === tag) return label;
    } catch {
      return null;
    }
  }
  return null;
}

/** A template with its placeholders other than the variable filled in: the literal before and after the variable. */
export interface TagShape {
  prefix: string;
  suffix: string;
}

/** The literal around a template's one variable (`{version}`, `{label}` or `{major}`), with `{member}` and `{path}` filled in. */
export function tagShape(template: string, place: TagPlace): TagShape {
  const m = /\{(version|label|major)\}/.exec(template);
  if (!m) throw new ReleaseTagError("release-tag-template-invalid", `release.tag "${template}" has no {version}, {label} or {major}`);
  const fillFixed = (s: string) => fill(s, place, {});
  return { prefix: fillFixed(template.slice(0, m.index)), suffix: fillFixed(template.slice(m.index + m[0].length)) };
}

/**
 * Whether two shapes can render the same tag: whether some tag is
 * `prefix + x + suffix` for both, with each `x` a non-empty run of label
 * characters (which never hold `/`). Worked as the intersection of two
 * small automata, so `release/{label}` and `release/core/{label}` are
 * apart (the label would need a `/`) and `v{version}` and `v{version}-cli`
 * are not (the label `1.0.0-cli`).
 */
export function shapesOverlap(a: TagShape, b: TagShape): boolean {
  // States of one shape: 0..p reading the prefix, p+1 "in the variable, at least one char read", then the suffix.
  type State = number;
  const nfa = (s: TagShape) => {
    const p = s.prefix.length;
    const varState = p + 1;
    const accept = varState + s.suffix.length;
    const step = (state: State, c: string): State[] => {
      const out: State[] = [];
      if (state < p) {
        if (s.prefix[state] === c) out.push(state + 1);
      } else if (state === p) {
        if (LABEL_CHAR.test(c)) out.push(varState);
      } else {
        // In the variable (state === varState) or in the suffix (state > varState).
        if (state === varState && LABEL_CHAR.test(c)) out.push(varState);
        const k = state - varState;
        if (k < s.suffix.length && s.suffix[k] === c) out.push(state + 1);
      }
      return out;
    };
    return { step, accept };
  };
  const na = nfa(a);
  const nb = nfa(b);
  const literals = new Set([...a.prefix, ...a.suffix, ...b.prefix, ...b.suffix]);
  const other = [..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._+-"].find((c) => !literals.has(c));
  const alphabet = [...literals, ...(other ? [other] : [])];
  const seen = new Set<string>(["0,0"]);
  const queue: Array<[State, State]> = [[0, 0]];
  while (queue.length > 0) {
    const [x, y] = queue.shift()!;
    if (x === na.accept && y === nb.accept) return true;
    for (const c of alphabet) {
      for (const x2 of na.step(x, c)) {
        for (const y2 of nb.step(y, c)) {
          const key = `${x2},${y2}`;
          if (!seen.has(key)) {
            seen.add(key);
            queue.push([x2, y2]);
          }
        }
      }
    }
  }
  return false;
}

/** One member's templates, where they render. */
export interface MemberTags {
  place: TagPlace;
  template: ReleaseTagTemplate;
}

/**
 * The first pair of tag templates, across members, that can render the same
 * tag, or null. Each member's release tag and floating tag are checked
 * against every other member's; a member's own two are not, since only a
 * stable version moves the floating tag.
 */
export function findTagCollision(members: readonly MemberTags[]): { a: { member: string | null; template: string }; b: { member: string | null; template: string } } | null {
  const shapes = members.flatMap((m) =>
    [m.template.name, ...(m.template.floating ? [m.template.floating] : [])].map((template) => ({ member: m.place.member, template, shape: tagShape(template, m.place) })),
  );
  for (let i = 0; i < shapes.length; i++) {
    for (let j = i + 1; j < shapes.length; j++) {
      const a = shapes[i]!;
      const b = shapes[j]!;
      if (a.member === b.member) continue;
      if (shapesOverlap(a.shape, b.shape)) return { a: { member: a.member, template: a.template }, b: { member: b.member, template: b.template } };
    }
  }
  return null;
}

function gitTopOf(cwd: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/** A directory's path from the repository root, or null at the root or outside a repository. */
export function pathFromTop(cwd: string, top: string | null = gitTopOf(cwd)): string | null {
  if (!top) return null;
  const rel = relative(resolve(top), resolve(cwd)).split(sep).join("/");
  return rel === "" || rel.startsWith("..") ? null : rel;
}

/** The member's place and checked templates, from its `chant.config.ts` at `cwd` and its ledger. */
export async function memberTags(cwd: string, opts: { config?: ReleaseTagConfig | undefined; top?: string | null } = {}): Promise<MemberTags> {
  const { resolveMemberLedger } = await import("./member-ledger");
  const ledger = await resolveMemberLedger(cwd);
  const member = ledger.members.length > 0 ? ledger.members.join("/") : null;
  let config = opts.config;
  if (!("config" in opts)) {
    const { loadChantConfig } = await import("../config");
    config = (await loadChantConfig(cwd)).config.release?.tag;
  }
  return { place: { member, path: pathFromTop(cwd, opts.top === undefined ? gitTopOf(cwd) : opts.top) }, template: resolveTagTemplate(config, member) };
}

/**
 * Refuse a member's templates that can render a tag another member's can
 * (`release-tag-collision`). The other members are the `chant` members of
 * the workspace the member sits in, each read from its own `chant.config.ts`;
 * one whose config can't be read is left out. A member that sets no
 * `release.tag` is not checked, since the legacy tags hold the member's name
 * and never collide; the member that sets one checks itself against them.
 */
export async function checkTagCollisions(cwd: string, own: MemberTags): Promise<void> {
  if (own.template.legacy) return;
  const { findWorkspaceRoot } = await import("../project-root");
  const found = findWorkspaceRoot(cwd);
  if (!found) return;
  const { readDeclaration } = await import("../workspace/declaration");
  const { workingTree } = await import("../workspace/tree");
  let dirs: string[];
  try {
    dirs = readDeclaration(workingTree(found.dir))
      .members.filter((m) => m.kind === "chant")
      .map((m) => resolve(found.dir, m.dir));
  } catch {
    return;
  }
  const self = resolve(cwd);
  const top = gitTopOf(cwd);
  const others: MemberTags[] = [];
  for (const dir of dirs) {
    if (dir === self || !existsSync(join(dir, "chant.config.ts"))) continue;
    try {
      const m = await memberTags(dir, { top });
      if (m.place.member !== own.place.member) others.push(m);
    } catch {
      // A member whose config can't be read, or whose own template is refused, is checked when it cuts.
    }
  }
  const hit = findTagCollision([own, ...others]);
  if (hit) {
    const who = (m: string | null) => (m ? `member ${m}` : "the workspace root");
    throw new ReleaseTagError(
      "release-tag-collision",
      `release.tag "${hit.a.template}" of ${who(hit.a.member)} and "${hit.b.template}" of ${who(hit.b.member)} can make the same tag, so one member's release could take the other's tag`,
      "Give each member a template the others can't render: put {member} or {path} in it, or a literal prefix of its own, such as cli-v{version}.",
    );
  }
}
