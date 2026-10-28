/**
 * `chant ci forge-check [--env <env>] [--member <name>] [--forge <forge>]
 * [--repo <owner/name>] [--branch <default>] [--require-clouds] [--json]`
 * (#4608): read the live forge, the clouds and Pulumi Cloud against the
 * pull-request pipelines `ci.identity.cloud` gives the workspace, one row
 * per expected setting. Read-only. Exits chant's `failed` (1) on a
 * mismatch, or with --require-clouds on a cloud left unchecked; `done` (0)
 * otherwise. See ../../forge-check/index.ts.
 */
import { formatError } from "../format";
import type { CloudIdentityDeclaration } from "../../ci-identity";
import type { ForgeFetch } from "../../pr-forge";
import type { CommandContext } from "../registry";

const USAGE = "chant ci forge-check [--env <env>] [--member <name>] [--forge github|gitlab|forgejo] [--repo <owner/name>] [--branch <default>] [--require-clouds] [--json]";

/** The environment chant's generated pull-request pipelines default to. */
const DEFAULT_ENV = "production";

export async function runCiForgeCheck(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const [{ forgeCheck, forgeCheckExit, describeForgeCheck, forgeCheckTarget, pipelineContract }, { resolveCloudIdentity }, { CHANT_EXIT }, { activeProductWords }, { findWorkspaceRoot }] = await Promise.all([
    import("../../forge-check/index"),
    import("../../ci-identity"),
    import("../../exit-codes"),
    import("../../ci-product-words"),
    import("../../project-root"),
  ]);
  const fail = (message: string): number => {
    console.error(formatError({ message, hint: USAGE }));
    return CHANT_EXIT.failed;
  };
  if (args.forge !== undefined && !["github", "gitlab", "forgejo"].includes(args.forge)) return fail(`--forge is ${args.forge}; give github, gitlab or forgejo`);
  let target;
  try {
    target = forgeCheckTarget(process.env, { ...(args.forge ? { kind: args.forge as "github" | "gitlab" | "forgejo" } : {}), ...(args.ciRepo ? { repo: args.ciRepo } : {}) });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  const found = findWorkspaceRoot(process.cwd());
  let decl: CloudIdentityDeclaration | undefined;
  let memberNames: string[] = [];
  if (found) {
    const [{ readDeclaration, WorkspaceReadError }, { workingTree }] = await Promise.all([import("../../workspace/declaration"), import("../../workspace/tree")]);
    try {
      const declaration = readDeclaration(workingTree(found.dir));
      decl = declaration.ci?.identity?.cloud;
      memberNames = (declaration.members ?? []).map((m) => m.name);
    } catch (err) {
      if (err instanceof WorkspaceReadError) return fail(`${err.describe()} [${err.code}]`);
      throw err;
    }
  }
  const unknown = (args.members ?? []).filter((m) => !memberNames.includes(m));
  if (unknown.length) return fail(`--member names ${unknown.join(", ")}, which the workspace declaration does not list`);
  const env = args.env ?? DEFAULT_ENV;
  const members: (string | undefined)[] = args.members?.length ? args.members : memberNames.length ? memberNames : [undefined];
  const pipelines = members.flatMap((member) => {
    const identity = resolveCloudIdentity(decl, env, member);
    return identity ? [{ name: member ? `${member}/${env}` : env, identity, ...(member ? { member } : {}) }] : [];
  });
  const words = activeProductWords();
  const host = target.host;
  const result = await forgeCheck(
    {
      target,
      words,
      ...(args.requireClouds ? { requireClouds: true } : {}),
      contract: (live) =>
        pipelineContract({
          forge: target.kind,
          repository: {
            host,
            path: live.path ?? target.repo,
            defaultBranch: args.branch ?? live.defaultBranch ?? "main",
            ...(live.ownerId ? { ownerId: live.ownerId } : {}),
            ...(live.repoId ? { repoId: live.repoId } : {}),
          },
          pipelines,
          words,
        }),
    },
    { fetch: globalThis.fetch as unknown as ForgeFetch, env: process.env },
  );
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(describeForgeCheck(result));
  if (!decl) console.error("ci forge-check: no ci.identity.cloud in the workspace declaration, so no trust was checked");
  else if (pipelines.length === 0) console.error(`ci forge-check: no rule of ci.identity.cloud covers environment ${env}, so no trust was checked`);
  return forgeCheckExit(result);
}
