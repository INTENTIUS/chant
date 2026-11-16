/**
 * `chant release init [--yes] [--force] [--one-release] [--forge github|gitlab|forgejo] [--json]`
 * (#5160): set up `chant release` in a project that has never used chant. A
 * dry run unless `--yes`. An npm, pnpm or yarn workspace with several
 * publishable packages gets a release train (#5154): a member per package
 * and `release.train` at the root, unless `--one-release`. See
 * ../../lifecycle/release-init.ts.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { formatBold, formatError, formatSuccess, formatWarning } from "../format";
import type { CommandContext } from "../registry";

const USAGE = "chant release init [--yes] [--force] [--one-release] [--forge github|gitlab|forgejo] [--json]";

export async function runReleaseInit(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const root = resolve(".");
  const json = args.json === true;
  const write = args.yes === true && args.dryRun !== true;
  const force = args.force === true;
  const {
    detectProject,
    planRelease,
    planTrain,
    trainFit,
    releaseBlockSource,
  } = await import("../../lifecycle/release-init");

  const fail = (code: string, message: string, fix?: string, block?: string): number => {
    if (json) console.log(JSON.stringify({ error: { code, message, ...(fix ? { fix } : {}) } }, null, 2));
    else {
      console.error(formatError({ message: `${message} [${code}]`, ...(fix ? { hint: fix } : {}) }));
      if (block) console.error(`\n  ${block}\n`);
    }
    return 1;
  };

  if (!["package.json", "go.mod", "Cargo.toml", "pyproject.toml", "setup.py", "Dockerfile", "chant.config.ts", "chant.config.json"].some((f) => existsSync(join(root, f))) && !existsSync(join(root, ".git"))) {
    return fail("release-init-not-a-project", "this directory holds no package.json, go.mod, Cargo.toml, pyproject.toml, Dockerfile or git repository", "Run chant release init in the project's root.");
  }

  const facts = detectProject(root);
  if (args.forge !== undefined) {
    if (!["github", "gitlab", "forgejo"].includes(args.forge)) return fail("release-init-forge-invalid", `--forge ${JSON.stringify(args.forge)} is not one of github, gitlab, forgejo`, USAGE);
    facts.workflowForge = args.forge as typeof facts.workflowForge;
  }
  const { readerVersion } = await import("../../workspace/declaration");
  const plan = planRelease(facts, { chantVersion: readerVersion() });
  const block = releaseBlockSource(plan.release, "  ");

  const fit = trainFit(facts);
  if (fit.train && args.oneRelease !== true) return runTrainInit(ctx, root, planTrain(facts, { chantVersion: readerVersion() }), facts.workflowForge, fail);
  if (!fit.train && fit.why) plan.notes.push(`One release for every package, not a release train: ${fit.why}.`);
  if (fit.train) plan.reasons.unshift("--one-release: every package is released together, at one label under one tag");

  const { typeScriptLoaderAvailable } = await import("../../ts-loader");
  const canLoadTs = typeScriptLoaderAvailable();
  const prepared = await prepareConfig(root, plan.release, force, canLoadTs);
  if ("error" in prepared) return fail(prepared.error.code, prepared.error.message, prepared.error.fix, block);
  const { configPath, configText, configName, created } = prepared;
  if (created && configName === "chant.config.json") plan.reasons.unshift(TSX_REASON);

  // The workflow file: one chant generated is regenerated; any other is left alone without --force,
  // unless it is the npm publish workflow the plan adopts, which the release workflow replaces.
  const { gitTop } = await import("../../workspace/tree");
  const top = gitTop(root) ?? root;
  const adopted = adoptedWorkflow(plan.release);
  const handWritten = !(await workflowIsOurs(join(top, plan.workflowFile)));
  if (handWritten && !force && !adopted) {
    return fail("release-init-workflow-exists", `${plan.workflowFile} exists and chant did not write it`, "Run again with --force to replace it.");
  }

  const gr = plan.goreleaserPatch;
  // The first label: `auto` when release next reads the previous release
  // from the tag history (#5200), else a patch after the newest tag, else 0.1.0.
  const newest = facts.tags.newest ? /(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(facts.tags.newest) : null;
  const label = plan.readsHistory ? "auto" : newest ? `${newest[1]}.${newest[2]}.${Number(newest[3]) + 1}` : "0.1.0";
  const wf = plan.workflowFile.split("/").pop();
  const next = [
    ...(write ? [] : ["chant release init --yes"]),
    `git add ${configName} ${plan.workflowFile}${gr?.append ? ` ${gr.file}` : ""} && git commit -m "ci: release with chant" && git push`,
    // #5161: what the registries say of the targets, once their setup is done.
    "chant release doctor",
    facts.workflowForge === "github"
      ? `gh workflow run ${wf} -f label=${label}${plan.readsHistory ? `  # the label from the commits since ${facts.tags.newest}` : ""}`
      : `start ${plan.workflowFile} by hand with the label ${label}${plan.readsHistory ? ` (the label from the commits since ${facts.tags.newest})` : ""}`,
    facts.workflowForge === "github"
      ? `# each later release: gh workflow run ${wf} -f label=auto (the label from the commits since the previous release)`
      : `# each later release: start ${plan.workflowFile} with the label auto (the label from the commits since the previous release)`,
  ];

  if (json) {
    const out = { dryRun: !write, layout: "one-release", config: configName, created, release: plan.release, reasons: plan.reasons, notes: plan.notes, registry: plan.registry, workflow: plan.workflowFile, goreleaser: gr, next };
    if (!write) {
      console.log(JSON.stringify(out, null, 2));
      return 0;
    }
  } else {
    console.log(formatBold(`${write ? "" : "Dry run: "}release block for ${configName}${created ? " (a new file)" : ""}`));
    console.log(`\n  ${block}\n`);
    console.log(formatBold("Why"));
    for (const r of plan.reasons) console.log(`  - ${r}`);
    if (plan.notes.length > 0) {
      console.log(formatBold("\nNot covered"));
      for (const n of plan.notes) console.log(`  - ${n}`);
    }
  }

  if (write) {
    writeFileSync(configPath, configText);
    if (!json) console.log(formatSuccess(`${created ? "Wrote" : "Updated"} ${configName}.`));
    if (gr?.append) {
      const grPath = join(root, gr.file);
      const text = readFileSync(grPath, "utf-8");
      appendFileSync(grPath, `${text.endsWith("\n") ? "" : "\n"}${gr.append}`);
      if (!json) console.log(formatSuccess(`Added snapshot.version_template to ${gr.file}, so the snapshot build carries the release's label.`));
    }
    const { runReleaseWorkflow } = await import("../../workspace/release-workflow");
    const log = console.log;
    if (json) console.log = console.error;
    let code: number;
    try {
      code = await runReleaseWorkflow({ ...ctx, args: { ...ctx.args, forge: facts.workflowForge, ...(adopted ? { force: true } : {}) } });
    } finally {
      console.log = log;
    }
    if (code !== 0) return code;
  } else if (!json) {
    console.log(`\nWould write ${configName} and ${plan.workflowFile} (with chant release workflow${handWritten ? `, replacing the ${plan.workflowFile} there` : ""})${gr?.append ? `, and add snapshot.version_template to ${gr.file}` : ""}.`);
  }
  if (gr?.manual && !json) console.log(formatWarning({ message: gr.manual }));

  if (json) {
    console.log(JSON.stringify({ dryRun: false, layout: "one-release", config: configName, created, release: plan.release, reasons: plan.reasons, notes: plan.notes, registry: plan.registry, workflow: plan.workflowFile, goreleaser: gr, next }, null, 2));
    return 0;
  }
  if (plan.registry.length > 0) {
    console.log(formatBold("\nOn the registries, by hand"));
    for (const r of plan.registry) console.log(`  - ${r}`);
  }
  console.log(formatBold("\nNext"));
  for (const n of next) console.log(`  ${n}`);
  return 0;
}

type Lifecycle = typeof import("../../lifecycle/release-init");
type Fail = (code: string, message: string, fix?: string, block?: string) => number;

/** Why init writes chant.config.json: the reason line a plan carries for it. */
const TSX_REASON = "chant.config.json, not chant.config.ts: tsx, which chant needs to read a TypeScript config, is not installed here, so the release block is written as JSON that this run and the workflow's jobs read without it";

/** The `release.workflow.file` init set to adopt the project's npm publish workflow, or null. */
function adoptedWorkflow(release: Record<string, unknown>): string | null {
  const file = (release.workflow as { file?: unknown } | undefined)?.file;
  return typeof file === "string" ? file : null;
}

/** Whether the workflow file is absent or one chant generated, so writing it replaces nothing a person wrote. */
async function workflowIsOurs(path: string): Promise<boolean> {
  if (!existsSync(path)) return true;
  const { GENERATED_MARKER } = await import("../../discovery/files");
  return readFileSync(path, "utf-8").includes(GENERATED_MARKER);
}

/**
 * The config of the project at `dir` with `release` written in: its
 * chant.config.ts edited in place, its chant.config.json rewritten, or a new
 * chant.config.ts. Without tsx (`canLoadTs` false) the new config is
 * chant.config.json, and an existing chant.config.ts is refused, since
 * nothing could read it back.
 */
async function prepareConfig(
  dir: string,
  release: Parameters<Lifecycle["insertReleaseBlock"]>[1],
  force: boolean,
  canLoadTs: boolean,
): Promise<{ configPath: string; configText: string; configName: string; created: boolean } | { error: { code: string; message: string; fix?: string } }> {
  const { insertReleaseBlock, newConfigSource, ReleaseInitError } = await import("../../lifecycle/release-init");
  const tsPath = join(dir, "chant.config.ts");
  const jsonPath = join(dir, "chant.config.json");
  let configPath: string;
  let configText: string;
  try {
    if (existsSync(tsPath)) {
      if (!canLoadTs) throw new ReleaseInitError("release-init-tsx-missing", "chant.config.ts is TypeScript, and chant needs tsx to read it, which is not installed here", "Add tsx as a dev dependency (npm i -D tsx) and run again, so this run and the release workflow's jobs can read the config.");
      configPath = tsPath;
      const before = readFileSync(tsPath, "utf-8");
      configText = insertReleaseBlock(before, release, force);
      // A release the text scan can't see, such as one spread in from elsewhere, is still a release block.
      if (!force && !/\brelease\s*:/.test(before)) {
        try {
          const { loadChantConfig } = await import("../../config");
          const loaded = (await loadChantConfig(dir)).config.release;
          if (loaded && Object.keys(loaded).length > 0) throw new ReleaseInitError("release-init-release-exists", "chant.config.ts already declares release", "Add the fields shown here to it by hand.");
        } catch (err) {
          if (err instanceof ReleaseInitError) throw err;
          // A config that can't be loaded here is edited by its text alone.
        }
      }
    } else if (existsSync(jsonPath)) {
      configPath = jsonPath;
      const parsed = JSON.parse(readFileSync(jsonPath, "utf-8")) as Record<string, unknown>;
      if (parsed.release !== undefined && !force) throw new ReleaseInitError("release-init-release-exists", "chant.config.json already has a release block", "Run again with --force to replace it, or add the fields shown here to it by hand.");
      configText = `${JSON.stringify({ ...parsed, release }, null, 2)}\n`;
    } else if (canLoadTs) {
      configPath = tsPath;
      configText = newConfigSource(release);
    } else {
      configPath = jsonPath;
      configText = `${JSON.stringify({ release }, null, 2)}\n`;
    }
  } catch (err) {
    if (err instanceof ReleaseInitError) return { error: { code: err.code, message: err.message, ...(err.fix ? { fix: err.fix } : {}) } };
    return { error: { code: "release-init-config-unreadable", message: `the config could not be read: ${err instanceof Error ? err.message : String(err)}` } };
  }
  return { configPath, configText, configName: configPath === tsPath ? "chant.config.ts" : "chant.config.json", created: !existsSync(configPath) };
}

/** A workspace member as `chant.workspace.json` lists it. */
interface DeclaredMember {
  name?: unknown;
  dir?: unknown;
  kind?: unknown;
}

/**
 * The release train (#5154): `chant.workspace.json` with a member per
 * package, each member's `chant.config.ts`, the root's `release.train`, and
 * the train workflow.
 */
async function runTrainInit(ctx: CommandContext, root: string, plan: import("../../lifecycle/release-init").ReleaseTrainPlan, fg: string, fail: Fail): Promise<number> {
  const { args } = ctx;
  const json = args.json === true;
  const write = args.yes === true && args.dryRun !== true;
  const force = args.force === true;
  const lib = await import("../../lifecycle/release-init");
  const rel = (p: string) => relative(root, p).split(sep).join("/");

  // Each member's config, then the root's.
  const { typeScriptLoaderAvailable } = await import("../../ts-loader");
  const canLoadTs = typeScriptLoaderAvailable();
  const members: Array<{ name: string; dir: string; package: string; release: (typeof plan.members)[number]["release"]; path: string; text: string; created: boolean }> = [];
  for (const m of plan.members) {
    const prepared = await prepareConfig(join(root, m.dir), m.release, force, canLoadTs);
    const block = lib.releaseBlockSource(m.release, "  ");
    if ("error" in prepared) return fail(prepared.error.code, `${m.dir}: ${prepared.error.message}`, prepared.error.fix, block);
    members.push({ name: m.name, dir: m.dir, package: m.package, release: m.release, path: prepared.configPath, text: prepared.configText, created: prepared.created });
  }
  const rootBlock = lib.releaseBlockSource(plan.release, "  ");
  const prepared = await prepareConfig(root, plan.release, force, canLoadTs);
  if ("error" in prepared) return fail(prepared.error.code, prepared.error.message, prepared.error.fix, rootBlock);
  if (!canLoadTs) {
    plan.reasons.unshift(TSX_REASON);
    for (const m of members) if (m.path.endsWith(".json")) plan.reasons = plan.reasons.map((r) => r.replace(`${m.dir}/chant.config.ts, member`, `${m.dir}/chant.config.json, member`));
  }

  // chant.workspace.json: a new one, or the members added to the one there.
  const wsPath = join(root, "chant.workspace.json");
  const wsCreated = !existsSync(wsPath);
  let ws: Record<string, unknown>;
  try {
    ws = wsCreated ? { name: plan.workspaceName, schema: 1, members: [] } : (JSON.parse(readFileSync(wsPath, "utf-8")) as Record<string, unknown>);
  } catch (err) {
    return fail("release-init-config-unreadable", `chant.workspace.json could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  const declared: DeclaredMember[] = Array.isArray(ws.members) ? [...(ws.members as DeclaredMember[])] : [];
  const added: string[] = [];
  for (const m of members) {
    const at = declared.findIndex((d) => d.dir === m.dir || d.name === m.name);
    const entry = { name: m.name, dir: m.dir, kind: "chant" };
    if (at < 0) {
      declared.push(entry);
      added.push(m.name);
      continue;
    }
    const d = declared[at]!;
    if (d.dir === m.dir && d.name === m.name && d.kind === "chant") continue;
    if (!force) return fail("release-init-member-exists", `chant.workspace.json already declares ${JSON.stringify(d.name)} at ${JSON.stringify(d.dir)}${d.kind === undefined ? "" : ` (kind ${String(d.kind)})`}, and the train needs ${m.name} at ${m.dir} as a chant member`, "Run again with --force to replace that entry, or declare the member by hand.");
    declared[at] = entry;
    added.push(m.name);
  }
  ws.members = declared;
  const wsText = `${JSON.stringify(ws, null, 2)}\n`;

  const { gitTop } = await import("../../workspace/tree");
  const top = gitTop(root) ?? root;
  const adopted = adoptedWorkflow(plan.release);
  const handWritten = !(await workflowIsOurs(join(top, plan.workflowFile)));
  if (handWritten && !force && !adopted) {
    return fail("release-init-workflow-exists", `${plan.workflowFile} exists and chant did not write it`, "Run again with --force to replace it.");
  }

  const wf = plan.workflowFile.split("/").pop();
  const files = ["chant.workspace.json", prepared.configName, ...members.map((m) => rel(m.path)), plan.workflowFile];
  const next = [
    ...(write ? [] : ["chant release init --yes"]),
    `git add ${files.join(" ")} && git commit -m "ci: release with chant" && git push`,
    `chant workspace train cut ${plan.env}  # the first train's plan; nothing is cut without --yes`,
    fg === "github"
      ? `gh workflow run ${wf} -f levels=auto  # each package's level from its commits since its last release`
      : `start ${plan.workflowFile} by hand with the levels auto (each package's level from its commits since its last release)`,
  ];

  const memberOut = members.map((m) => ({ name: m.name, dir: m.dir, package: m.package, config: rel(m.path), created: m.created, release: m.release }));
  const out = (dryRun: boolean) => ({
    dryRun,
    layout: "train",
    workspace: { file: "chant.workspace.json", created: wsCreated, added },
    config: prepared.configName,
    created: prepared.created,
    release: plan.release,
    members: memberOut,
    reasons: plan.reasons,
    notes: plan.notes,
    registry: plan.registry,
    workflow: plan.workflowFile,
    next,
  });

  if (json && !write) {
    console.log(JSON.stringify(out(true), null, 2));
    return 0;
  }
  if (!json) {
    console.log(formatBold(`${write ? "" : "Dry run: "}a release train of ${members.length} packages, each released at its own version`));
    console.log(formatBold(`\nchant.workspace.json${wsCreated ? " (a new file)" : added.length > 0 ? ` (adds ${added.join(", ")})` : ""}`));
    console.log(`\n${wsText.replace(/^/gm, "  ").trimEnd()}\n`);
    console.log(formatBold(`${prepared.configName}${prepared.created ? " (a new file)" : ""}`));
    console.log(`\n  ${rootBlock}\n`);
    for (const m of members) {
      console.log(formatBold(`${rel(m.path)}${m.created ? " (a new file)" : ""}`));
      console.log(`\n  ${lib.releaseBlockSource(m.release, "  ")}\n`);
    }
    console.log(formatBold("Why"));
    for (const r of plan.reasons) console.log(`  - ${r}`);
    if (plan.notes.length > 0) {
      console.log(formatBold("\nNot covered"));
      for (const n of plan.notes) console.log(`  - ${n}`);
    }
  }

  if (write) {
    writeFileSync(wsPath, wsText);
    for (const m of members) writeFileSync(m.path, m.text);
    writeFileSync(prepared.configPath, prepared.configText);
    if (!json) console.log(formatSuccess(`Wrote chant.workspace.json, ${prepared.configName} and ${members.length} member configs.`));
    const { runReleaseWorkflow } = await import("../../workspace/release-workflow");
    const log = console.log;
    if (json) console.log = console.error;
    let code: number;
    try {
      code = await runReleaseWorkflow({ ...ctx, args: { ...ctx.args, forge: fg, ...(adopted ? { force: true } : {}) } });
    } finally {
      console.log = log;
    }
    if (code !== 0) return code;
  } else {
    console.log(`\nWould write chant.workspace.json, ${prepared.configName}, ${members.map((m) => rel(m.path)).join(", ")} and ${plan.workflowFile} (with chant release workflow${handWritten ? `, replacing the ${plan.workflowFile} there` : ""}). Run with --one-release to release every package together under one label instead.`);
  }

  if (json) {
    console.log(JSON.stringify(out(false), null, 2));
    return 0;
  }
  if (plan.registry.length > 0) {
    console.log(formatBold("\nOn the registries, by hand"));
    for (const r of plan.registry) console.log(`  - ${r}`);
  }
  console.log(formatBold("\nNext"));
  for (const n of next) console.log(`  ${n}`);
  return 0;
}
