/**
 * `chant release init [--yes] [--force] [--forge github|gitlab|forgejo] [--json]` (#5160):
 * set up `chant release` in a project that has never used chant. A dry run
 * unless `--yes`. See ../../lifecycle/release-init.ts.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { formatBold, formatError, formatSuccess, formatWarning } from "../format";
import type { CommandContext } from "../registry";

const USAGE = "chant release init [--yes] [--force] [--forge github|gitlab|forgejo] [--json]";

export async function runReleaseInit(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const root = resolve(".");
  const json = args.json === true;
  const write = args.yes === true;
  const force = args.force === true;
  const {
    detectProject,
    planRelease,
    insertReleaseBlock,
    newConfigSource,
    releaseBlockSource,
    ReleaseInitError,
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

  // The config: chant.config.ts edited in place, chant.config.json rewritten, or a new chant.config.ts.
  const tsPath = join(root, "chant.config.ts");
  const jsonPath = join(root, "chant.config.json");
  let configPath: string;
  let configText: string;
  try {
    if (existsSync(tsPath)) {
      configPath = tsPath;
      const before = readFileSync(tsPath, "utf-8");
      configText = insertReleaseBlock(before, plan.release, force);
      // A release the text scan can't see, such as one spread in from elsewhere, is still a release block.
      if (!force && !/\brelease\s*:/.test(before)) {
        try {
          const { loadChantConfig } = await import("../../config");
          const loaded = (await loadChantConfig(root)).config.release;
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
      configText = `${JSON.stringify({ ...parsed, release: plan.release }, null, 2)}\n`;
    } else {
      configPath = tsPath;
      configText = newConfigSource(plan.release);
    }
  } catch (err) {
    if (err instanceof ReleaseInitError) return fail(err.code, err.message, err.fix, block);
    return fail("release-init-config-unreadable", `the config could not be read: ${err instanceof Error ? err.message : String(err)}`, undefined, block);
  }

  // The workflow file: one chant generated is regenerated; any other is left alone without --force.
  const { gitTop } = await import("../../workspace/tree");
  const top = gitTop(root) ?? root;
  const workflowPath = join(top, plan.workflowFile);
  if (existsSync(workflowPath) && !force) {
    const { GENERATED_MARKER } = await import("../../discovery/files");
    if (!readFileSync(workflowPath, "utf-8").includes(GENERATED_MARKER)) {
      return fail("release-init-workflow-exists", `${plan.workflowFile} exists and chant did not write it`, "Run again with --force to replace it.");
    }
  }

  const configName = configPath === tsPath ? "chant.config.ts" : "chant.config.json";
  const created = !existsSync(configPath);
  const gr = plan.goreleaserPatch;
  // The first label: a patch after the newest tag, else 0.1.0. `auto` reads
  // the bump from the previous chant release (#5159), and the first has none.
  const newest = facts.tags.newest ? /(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(facts.tags.newest) : null;
  const label = newest ? `${newest[1]}.${newest[2]}.${Number(newest[3]) + 1}` : "0.1.0";
  const next = [
    ...(write ? [] : ["chant release init --yes"]),
    `git add ${configName} ${plan.workflowFile}${gr?.append ? ` ${gr.file}` : ""} && git commit -m "ci: release with chant" && git push`,
    // #5161: what the registries say of the targets, once their setup is done.
    "chant release doctor",
    facts.workflowForge === "github" ? `gh workflow run ${plan.workflowFile.split("/").pop()} -f label=${label}` : `start ${plan.workflowFile} by hand with the label ${label}`,
    facts.workflowForge === "github"
      ? `# each later release: gh workflow run ${plan.workflowFile.split("/").pop()} -f label=auto (the label from the commits since the previous release)`
      : `# each later release: start ${plan.workflowFile} with the label auto (the label from the commits since the previous release)`,
  ];

  if (json) {
    const out = { dryRun: !write, config: configName, created, release: plan.release, reasons: plan.reasons, notes: plan.notes, registry: plan.registry, workflow: plan.workflowFile, goreleaser: gr, next };
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
      code = await runReleaseWorkflow({ ...ctx, args: { ...ctx.args, forge: facts.workflowForge } });
    } finally {
      console.log = log;
    }
    if (code !== 0) return code;
  } else if (!json) {
    console.log(`\nWould write ${configName} and ${plan.workflowFile} (with chant release workflow)${gr?.append ? `, and add snapshot.version_template to ${gr.file}` : ""}.`);
  }
  if (gr?.manual && !json) console.log(formatWarning({ message: gr.manual }));

  if (json) {
    console.log(JSON.stringify({ dryRun: false, config: configName, created, release: plan.release, reasons: plan.reasons, notes: plan.notes, registry: plan.registry, workflow: plan.workflowFile, goreleaser: gr, next }, null, 2));
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
