/**
 * `chant workspace adopt-lineage [<scope>] --from <repo>[@<tag>][#<member>]
 * [--tags <glob>] [--index <file>] [--dry-run] [--json]` and
 * `chant workspace hash-index --from <repo>[#<member>] [--tags <glob>]
 * [--output <file>]` (#2551).
 *
 * The first gives a scope with no lineage one, matched against the template's
 * tags (see ./lineage-adopt.ts). The second computes the hash index those tags
 * give, for a template's CI to publish as a cache adopters may pass with
 * `--index`. Neither needs a `chant.workspace.json`.
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatError, formatInfo, formatSuccess, formatWarning } from "../cli/format";
import type { CommandContext } from "../cli/registry";
import { adoptLineage, describeProposal } from "./lineage-adopt";
import { computeHashIndex, readHashIndex, renderHashIndex, TemplateTags } from "./lineage-hash-index";
import { parseTemplateSource } from "./lineage-init";
import { LOCK_FILE, LockError } from "./lineage-lock";

const ADOPT_USAGE = "chant workspace adopt-lineage [<scope>] --from <repo>[@<tag>][#<member>] [--tags <glob>] [--index <file>] [--dry-run] [--json]";
const INDEX_USAGE = "chant workspace hash-index --from <repo>[#<member>] [--tags <glob>] [--output <file>]";

export async function runWorkspaceAdoptLineage(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  if (args.extraPositional2) {
    console.error(formatError({ message: `unexpected argument: ${args.extraPositional2}`, hint: ADOPT_USAGE }));
    return 1;
  }
  if (!args.migrateFrom) {
    console.error(formatError({ message: "adopt-lineage needs the template the scope came from: --from <repo>[#<member>]", hint: ADOPT_USAGE }));
    return 1;
  }
  try {
    const proposal = adoptLineage({
      root: process.cwd(),
      scope: args.extraPositional,
      from: args.migrateFrom,
      tags: args.tags,
      cache: args.index ? readHashIndex(resolve(args.index)) : undefined,
      dryRun: args.dryRun,
    });
    if (args.json) {
      console.log(JSON.stringify(proposal, null, 2));
      return 0;
    }
    console.log(describeProposal(proposal).join("\n"));
    if (proposal.lockIgnored) {
      console.error(
        formatWarning({
          message: `${LOCK_FILE} is covered by a .gitignore. Commit it with \`git add -f\` so the lineage travels with the project.`,
        }),
      );
    }
    if (proposal.written) {
      console.error(formatSuccess(`recorded the lineage of "${proposal.scope}" in ${LOCK_FILE} as adopted. Review and commit it.`));
    } else {
      console.error(formatInfo("--dry-run: nothing written"));
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
