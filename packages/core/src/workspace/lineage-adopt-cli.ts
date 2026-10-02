/**
 * `chant workspace adopt-lineage [<scope>] --from <repo>[@<ref>][#<member>]
 * [--tags <glob>] [--index <file>] [--param k=v] [--dry-run] [--json]` and
 * `chant workspace hash-index --from <repo>[#<member>] [--tags <glob>]
 * [--output <file>]` (#2551).
 *
 * The first gives a scope a git lineage (see ./lineage-adopt.ts). The second
 * computes the hash index a template's tags give, for the template's CI to
 * publish as a cache that adopters pass with `--index`. Neither needs a
 * `chant.workspace.json`.
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatError, formatInfo, formatSuccess, formatWarning } from "../cli/format";
import type { CommandContext } from "../cli/registry";
import { adoptLineage, describeAdoption } from "./lineage-adopt";
import { computeHashIndex, readHashIndex, renderHashIndex, TemplateTags } from "./lineage-hash-index";
import { parseTemplateSource } from "./lineage-init";
import { LOCK_FILE, LockError } from "./lineage-lock";
import { parseParamArgs } from "./template-manifest";

const ADOPT_USAGE =
  "chant workspace adopt-lineage [<scope>] --from <repo>[@<ref>][#<member>] [--tags <glob>] [--index <file>] [--param name=value] [--dry-run] [--json]";
const INDEX_USAGE = "chant workspace hash-index --from <repo>[#<member>] [--tags <glob>] [--output <file>]";

export async function runWorkspaceAdoptLineage(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  if (args.extraPositional2) {
    console.error(formatError({ message: `unexpected argument: ${args.extraPositional2}`, hint: ADOPT_USAGE }));
    return 1;
  }
  if (!args.migrateFrom) {
    console.error(formatError({ message: "adopt-lineage needs the template: --from <repo>[@<ref>][#<member>]", hint: ADOPT_USAGE }));
    return 1;
  }
  try {
    const result = adoptLineage({
      root: process.cwd(),
      scope: args.extraPositional,
      from: args.migrateFrom,
      tags: args.tags,
      cache: args.index ? readHashIndex(resolve(args.index)) : undefined,
      params: args.param?.length ? parseParamArgs(args.param) : undefined,
      dryRun: args.dryRun,
    });
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }
    console.log(describeAdoption(result).join("\n"));
    if (result.lockIgnored) {
      console.error(formatWarning({ message: `${LOCK_FILE} is covered by a .gitignore. Commit it with \`git add -f\` so the lineage travels with the project.` }));
    }
    if (!result.written) {
      console.error(formatInfo("--dry-run: nothing written"));
    } else if (result.by === "lineage") {
      console.error(formatSuccess(`moved the lineage of "${result.scope}" onto ${result.template}@${result.chosen.tag} in ${LOCK_FILE}. Review and commit it; chant workspace upgrade --to <ref> now reads that repository.`));
    } else {
      console.error(
        formatSuccess(
          `recorded the lineage of "${result.scope}" in ${LOCK_FILE}${result.trust ? ` and the adopted range in ${result.trust.path}` : ""}. Review and commit both; the range counts once an admin merges it.`,
        ),
      );
    }
    return 0;
  } catch (err) {
    if (!(err instanceof LockError)) throw err;
    console.error(formatError({ message: err.message, hint: ADOPT_USAGE }));
    return 1;
  }
}

export async function runWorkspaceHashIndex(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const from = args.migrateFrom ?? args.extraPositional;
  if (!from || (args.migrateFrom && args.extraPositional)) {
    console.error(formatError({ message: "hash-index needs one template: --from <repo>[#<member>]", hint: INDEX_USAGE }));
    return 1;
  }
  try {
    const spec = parseTemplateSource(from, process.cwd(), "--from");
    if (spec.ref !== undefined) throw new LockError(`--from ${from}: the index covers every version tag; leave out "@${spec.ref}" and narrow with --tags`);
    const tags = new TemplateTags(spec.url, spec.member, spec.member ? `${spec.repo}#${spec.member}` : spec.repo);
    try {
      const { index } = computeHashIndex(tags, spec.id, { pattern: args.tags });
      const text = renderHashIndex(index);
      if (args.output) {
        writeFileSync(resolve(args.output), text);
        console.error(formatSuccess(`wrote the hash index of ${spec.id} (${index.tags.length} version(s)) to ${args.output}`));
      } else {
        process.stdout.write(text);
      }
      return 0;
    } finally {
      tags.dispose();
    }
  } catch (err) {
    if (!(err instanceof LockError)) throw err;
    console.error(formatError({ message: err.message, hint: INDEX_USAGE }));
    return 1;
  }
}
