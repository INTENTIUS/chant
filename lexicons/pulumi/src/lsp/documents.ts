/**
 * Which pulumi surface an editor document is (#4468).
 *
 * The lexicon declares no resource types, so there is no typed source to
 * complete. Its real surface is four files, told apart by name alone:
 *
 * - `Pulumi.yaml` (or `.yml`): the project file, which the `pulumi` member
 *   kind probes for and which carries the backend URL chant reads to pick
 *   the engine (`../run.ts`, `pulumiMemberEngine`);
 * - `Pulumi.<stack>.yaml`: a stack's config;
 * - `chant.workspace.json` / `.jsonc`: the workspace declaration, where a
 *   member says `"kind": "pulumi"`;
 * - `chant.config.ts`: the project config, where `pulumi.member` names a
 *   member to read into the build.
 *
 * Every other document is someone else's, and the providers return nothing
 * for it.
 */

export type PulumiDocument =
  | { kind: "project" }
  | { kind: "stack"; stack: string }
  | { kind: "workspace" }
  | { kind: "config" };

function fileName(uri: string): string {
  const path = uri.replace(/[?#].*$/, "");
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return decodeURIComponent(slash === -1 ? path : path.slice(slash + 1));
}

export function pulumiDocument(uri: string): PulumiDocument | undefined {
  const name = fileName(uri);
  if (name === "Pulumi.yaml" || name === "Pulumi.yml") return { kind: "project" };
  const stack = /^Pulumi\.(.+)\.ya?ml$/.exec(name);
  if (stack) return { kind: "stack", stack: stack[1] };
  if (name === "chant.workspace.json" || name === "chant.workspace.jsonc") return { kind: "workspace" };
  if (/^chant\.config\.(ts|mts|js|mjs)$/.test(name)) return { kind: "config" };
  return undefined;
}

/** The directory part of a `file://` URI, as a filesystem path; undefined for any other scheme. */
export function uriDir(uri: string): string | undefined {
  if (!uri.startsWith("file://")) return undefined;
  const path = decodeURIComponent(uri.slice("file://".length).replace(/[?#].*$/, ""));
  const slash = path.lastIndexOf("/");
  return slash <= 0 ? "/" : path.slice(0, slash);
}
