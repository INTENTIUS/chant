/**
 * #2700 — the lexicons `chant serve mcp` loads at the root of a declared
 * workspace that has no lexicon of its own.
 *
 * Such a root (a generated chud repo, say, whose lexicons are all in
 * `delivery/`) used to refuse with "No lexicon detected", so an agent started
 * there got none of chant's tools. The server now starts with core's tools and
 * resources, and with the lexicons of the workspace's members of kind chant,
 * each read from that member's own config the way `chant build` in the
 * member's directory reads it.
 *
 * Loading is best effort, one member and one lexicon at a time: a member whose
 * config does not load, or a lexicon this chant cannot import, is left out and
 * named in the server's `instructions`, and the rest are served. Nothing here
 * fails the server; with nothing loaded it serves core alone and says so.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { LexiconPlugin } from "../../lexicon";

/** One member of kind chant, and what came of reading its lexicons. */
export interface MemberLexicons {
  member: string;
  dir: string;
  /** The lexicon names its config declares or its source imports, or null when they could not be read. */
  lexicons: string[] | null;
  /** Why they could not be read. */
  error?: string;
}

export interface WorkspacePlugins {
  plugins: LexiconPlugin[];
  members: MemberLexicons[];
  /** Lexicons named by a member that did not load, with the reason. */
  failed: { lexicon: string; error: string }[];
  /** The text the MCP server gives as its `instructions`. */
  instructions: string;
}

function message(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split("\n")[0];
}

/** Load the lexicons of the chant members of the workspace declared at `root`. */
export async function loadWorkspacePlugins(root: string): Promise<WorkspacePlugins> {
  const [{ readDeclaration }, { workingTree }, { resolveProjectLexicons, loadPlugins }] = await Promise.all([
    import("../../workspace/declaration"),
    import("../../workspace/tree"),
    import("../plugins"),
  ]);

  const members: MemberLexicons[] = [];
  let workspaceName: string | undefined;
  let declarationError: string | undefined;
  try {
    const declaration = readDeclaration(workingTree(root));
    workspaceName = declaration.name;
    for (const m of declaration.members) {
      // The root member is the directory this server already found no lexicon in.
      if (m.kind !== "chant" || m.dir === ".") continue;
      const abs = join(root, m.dir);
      if (!existsSync(abs)) {
        members.push({ member: m.name, dir: m.dir, lexicons: null, error: "its directory does not exist" });
        continue;
      }
      try {
        members.push({ member: m.name, dir: m.dir, lexicons: await resolveProjectLexicons(abs) });
      } catch (error) {
        members.push({ member: m.name, dir: m.dir, lexicons: null, error: message(error) });
      }
    }
  } catch (error) {
    declarationError = message(error);
  }

  const plugins: LexiconPlugin[] = [];
  const failed: { lexicon: string; error: string }[] = [];
  const seen = new Set<string>();
  for (const m of members) {
    for (const name of m.lexicons ?? []) {
      if (seen.has(name)) continue;
      seen.add(name);
      try {
        plugins.push(...(await loadPlugins([name])));
      } catch (error) {
        failed.push({ lexicon: name, error: message(error) });
      }
    }
  }

  return { plugins, members, failed, instructions: describe(workspaceName, members, plugins, failed, declarationError) };
}

function describe(
  name: string | undefined,
  members: MemberLexicons[],
  plugins: LexiconPlugin[],
  failed: { lexicon: string; error: string }[],
  declarationError: string | undefined,
): string {
  const lines: string[] = [];
  lines.push(
    `This chant MCP server runs at the root of the workspace ${name ? `"${name}" ` : ""}(chant.workspace.json), which has no lexicon of its own. ` +
      "Core tools and resources are served as in any project. The tools that take a path (build, lint, explain) work on a project directory, so pass a member's directory.",
  );
  if (declarationError) lines.push(`The workspace declaration could not be read: ${declarationError}.`);
  for (const m of members) {
    lines.push(
      m.lexicons
        ? `Member ${m.member} (${m.dir}/) declares ${m.lexicons.length ? m.lexicons.join(", ") : "no lexicon"}.`
        : `Member ${m.member} (${m.dir}/) was not read: ${m.error}.`,
    );
  }
  for (const f of failed) lines.push(`Lexicon ${f.lexicon} did not load: ${f.error}.`);
  lines.push(
    plugins.length > 0
      ? `Lexicon tools and resources served: ${plugins.map((p) => p.name).join(", ")}.`
      : "No member lexicon loaded, so only chant's core tools and resources are served.",
  );
  return lines.join("\n");
}
