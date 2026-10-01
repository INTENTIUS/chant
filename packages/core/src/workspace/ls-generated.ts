/**
 * The generated files a member owns, and the CI job names inside them, for
 * `chant workspace ls --json` (#3050; read by INTENTIUS/github-warden#62).
 *
 * Two sources feed the list. The member's declared `generated` entries (#2541)
 * are relative to the member's directory. The interim record
 * `.chant/generated.json` that `chant build --components --generate` and
 * `chant run --generate` write (#2542) holds repository-relative paths, which is
 * how a forge CI file outside the member's directory is named. A path in both
 * lists once, with the declared entry's command.
 *
 * The job names are what a forge shows as the check name, so a reader can
 * require them: for GitHub, Forgejo and Gitea the job's `name`, else its id;
 * for GitLab the job's key. chant parses the file and runs nothing.
 */

import yaml from "js-yaml";
import type { Member } from "./declaration";
import { isForgePath } from "./checks/pipelines";
import { GENERATED_RECORD_FILE } from "./member-pipeline";
import { joinPath, type WorkspaceTree } from "./tree";

/** A generated file of a member, as `ls --json` lists it. */
export interface LsGenerated {
  /** From the repository root, with / separators, as a forge reads CI files. */
  path: string;
  /** The command that regenerates it, run in the member's directory. */
  command: string;
  /** The environment a component pipeline deploys, or null. */
  env: string | null;
  /** The check names of a forge CI file, or null for any other file and for one that can't be read or parsed. */
  jobs: string[] | null;
}

/** Top-level GitLab keys that are not jobs. */
const GITLAB_KEYWORDS = new Set(["stages", "variables", "default", "include", "workflow", "image", "services", "cache", "before_script", "after_script", "pages"]);

/** The check names in a forge CI file, or null when the file is no workflow or can't be parsed. */
export function jobNames(path: string, text: string): string[] | null {
  let doc: unknown;
  try {
    doc = yaml.load(text);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
  const top = doc as Record<string, unknown>;
  if (path.startsWith(".gitlab/ci/") || path === ".gitlab-ci.yml") {
    return Object.entries(top)
      .filter(([k, v]) => !k.startsWith(".") && !GITLAB_KEYWORDS.has(k) && v && typeof v === "object" && !Array.isArray(v))
      .map(([k]) => k);
  }
  const jobs = top["jobs"];
  if (!jobs || typeof jobs !== "object" || Array.isArray(jobs)) return null;
  return Object.entries(jobs as Record<string, unknown>).map(([id, job]) => {
    const name = job && typeof job === "object" ? (job as Record<string, unknown>)["name"] : undefined;
    return typeof name === "string" && name !== "" ? name : id;
  });
}

interface RecordFile {
  path?: unknown;
  command?: unknown;
  env?: unknown;
}

/**
 * The member's generated files. `prefix` is the workspace root relative to the
 * repository root, `"."` when they are the same. Never throws for a record that
 * is missing or malformed: that member lists what the declaration gives.
 */
export function memberGenerated(member: Member, tree: WorkspaceTree, prefix: string): LsGenerated[] {
  const repoPath = (workspacePath: string) => joinPath(prefix, workspacePath);
  const byPath = new Map<string, LsGenerated>();

  const recordFile = joinPath(member.dir, GENERATED_RECORD_FILE);
  if (tree.stat(recordFile) === "file") {
    try {
      const parsed = JSON.parse(tree.read(recordFile)) as { files?: RecordFile[] };
      for (const f of Array.isArray(parsed.files) ? parsed.files : []) {
        if (typeof f.path !== "string") continue;
        byPath.set(f.path, {
          path: f.path,
          command: typeof f.command === "string" ? f.command : "",
          env: typeof f.env === "string" ? f.env : null,
          jobs: null,
        });
      }
    } catch {
      // an unreadable record lists nothing from itself
    }
  }
  for (const g of member.generated) {
    if (g.handWritten) continue;
    const path = repoPath(joinPath(member.dir, g.path));
    byPath.set(path, { path, command: g.generator, env: byPath.get(path)?.env ?? null, jobs: null });
  }

  const own = prefix === "." ? "" : `${prefix}/`;
  for (const entry of byPath.values()) {
    if (!isForgePath(entry.path) || !entry.path.startsWith(own)) continue;
    const inTree = entry.path.slice(own.length);
    if (tree.stat(inTree) !== "file") continue;
    try {
      entry.jobs = jobNames(entry.path, tree.read(inTree));
    } catch {
      entry.jobs = null;
    }
  }
  return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
