import { listCommand, printListResult } from "../commands/list";
import { describeCommand, printDescribeResult } from "../commands/describe";
import { importCommand, importFromContent, importFromLive, importFromLiveStacks, printImportResult } from "../commands/import";
import { loadChantConfig } from "../../config";
import { resolve } from "path";
import { auditCommand, printAuditResult, type AuditFormat, type AuditTier, type AuditFailOn } from "../commands/audit";
import type { ReportTheme } from "../../audit/report-html";
import { AGENT_RUNTIMES, AGENT_SCOPES, type AgentRuntime, type AgentScope } from "../../agents/types";
import { registeredProjectRoots } from "../../agents/discover";
import { homedir } from "os";
import type { ResourceSelector } from "../../lexicon";
import { formatError, formatSuccess, formatWarning, formatBold } from "../format";
import type { CommandContext } from "../registry";
import { createRequire } from "module";
import { listComponents, describeComponent } from "../../components/cli-support";

const CHANT_VERSION: string = (() => {
  try {
    return createRequire(import.meta.url)("../../../package.json").version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

const AUDIT_FORMATS: AuditFormat[] = ["stylish", "json", "sarif", "markdown", "html"];
const AUDIT_TIERS: AuditTier[] = ["merge-worthy", "all"];
const AUDIT_FAIL_ON: AuditFailOn[] = ["merge-worthy", "warning", "none"];

/**
 * Parse `--scope system,user,project`. Returns `undefined` (meaning "all") when
 * the flag is absent, or an Error the caller reports — an unrecognized scope is
 * rejected rather than ignored, since silently scanning more than the user
 * asked for is exactly the surprise this command exists to prevent.
 */
function parseScopes(raw: string | undefined): readonly AgentScope[] | undefined | Error {
  if (!raw) return undefined;
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const bad = parts.filter((p) => !AGENT_SCOPES.includes(p as AgentScope));
  if (bad.length > 0) return new Error(`Invalid --scope: ${bad.join(", ")}. Expected one or more of ${AGENT_SCOPES.join(", ")}.`);
  return parts.length > 0 ? (parts as AgentScope[]) : undefined;
}

/** Parse `--runtime claude,codex,...`. Same contract as {@link parseScopes}. */
function parseRuntimes(raw: string | undefined): readonly AgentRuntime[] | undefined | Error {
  if (!raw) return undefined;
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const bad = parts.filter((p) => !AGENT_RUNTIMES.includes(p as AgentRuntime));
  if (bad.length > 0) return new Error(`Invalid --runtime: ${bad.join(", ")}. Expected one or more of ${AGENT_RUNTIMES.join(", ")}.`);
  return parts.length > 0 ? (parts as AgentRuntime[]) : undefined;
}

/**
 * Project roots for an `--agents` run.
 *
 * Default: the path argument alone. With `--all-projects`, every project root
 * the harness has registered, *unioned* with the path argument rather than
 * replacing it — a flag that silently discarded an argument the user typed
 * would be the wrong kind of surprise, and a cwd that isn't registered yet is
 * still a project the user is plainly interested in.
 */
function resolveProjectRoots(args: { path: string; allProjects?: boolean }): string[] {
  const named = resolve(args.path);
  if (!args.allProjects) return [named];
  return [...new Set([...registeredProjectRoots(homedir()), named])].sort();
}

export async function runAudit(ctx: CommandContext): Promise<number> {
  const { args } = ctx;

  const format: AuditFormat = args.json ? "json" : ((args.format || "stylish") as AuditFormat);
  if (!AUDIT_FORMATS.includes(format)) {
    console.error(formatError({ message: `Invalid --format: ${format}. Expected one of ${AUDIT_FORMATS.join(", ")}.` }));
    return 1;
  }
  const tier = (args.tier ?? "all") as AuditTier;
  if (!AUDIT_TIERS.includes(tier)) {
    console.error(formatError({ message: `Invalid --tier: ${tier}. Expected one of ${AUDIT_TIERS.join(", ")}.` }));
    return 1;
  }
  const failOn = (args.failOn ?? "none") as AuditFailOn;
  if (!AUDIT_FAIL_ON.includes(failOn)) {
    console.error(formatError({ message: `Invalid --fail-on: ${failOn}. Expected one of ${AUDIT_FAIL_ON.join(", ")}.` }));
    return 1;
  }

  // `--agents` switches the subject from a repo to this machine's agent
  // configuration. Same formats, tiers, and fail-on policy — a different thing
  // being audited, not a different report.
  if (args.agents) {
    const scopes = parseScopes(args.scope);
    if (scopes instanceof Error) {
      console.error(formatError({ message: scopes.message }));
      return 1;
    }
    const runtimes = parseRuntimes(args.runtime);
    if (runtimes instanceof Error) {
      console.error(formatError({ message: runtimes.message }));
      return 1;
    }
    const { auditAgentsCommand } = await import("../commands/audit-agents");
    const result = auditAgentsCommand({
      format,
      tier,
      failOn,
      scopes,
      runtimes,
      projectRoots: resolveProjectRoots(args),
      output: args.output,
      toolVersion: CHANT_VERSION,
    });
    if (result.error) console.error(formatError({ message: result.error }));
    else if (result.wroteTo) console.log(formatSuccess(`Report written to ${result.wroteTo}`));
    else console.log(result.output);
    return result.exitCode;
  }

  // HTML report customization: --template <file> (full override) + --theme <file> (JSON knobs).
  let template: string | undefined;
  let theme: ReportTheme | undefined;
  if (format === "html") {
    const { readFileSync } = await import("fs");
    if (args.template) {
      try {
        template = readFileSync(args.template, "utf-8");
      } catch (err) {
        console.error(formatError({ message: `Failed to read --template ${args.template}: ${err instanceof Error ? err.message : String(err)}` }));
        return 1;
      }
    }
    if (args.theme) {
      try {
        theme = JSON.parse(readFileSync(args.theme, "utf-8")) as ReportTheme;
      } catch (err) {
        console.error(formatError({ message: `Failed to read --theme ${args.theme}: ${err instanceof Error ? err.message : String(err)}` }));
        return 1;
      }
    }
  }

  const result = await auditCommand({
    path: args.path,
    format,
    tier,
    failOn,
    output: args.output,
    template,
    theme,
    toolVersion: CHANT_VERSION,
  });
  printAuditResult(result);
  return result.exitCode;
}

export async function runList(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const listFormat = (args.format || "text") as "text" | "json";
  if (listFormat !== "text" && listFormat !== "json") {
    console.error(`Invalid format for list: ${listFormat}. Expected 'text' or 'json'.`);
    return 1;
  }

  // `chant list --components` (#560) surfaces discovered `Component`
  // declarations instead of lexicon resources — a distinct entity kind (no
  // `lexicon`/`entityType`), so it is a separate branch rather than folded
  // into `listCommand`'s Declarable-shaped `ListEntity` rows.
  if (args.components) {
    const result = await listComponents(args.path, args.sandbox);
    if (!result.success) {
      for (const e of result.errors) console.error(formatError({ message: e }));
      return 1;
    }
    if (listFormat === "json") {
      console.log(JSON.stringify(result.components, null, 2));
    } else if (result.components.length === 0) {
      console.log("No components found.");
    } else {
      console.log(formatBold("NAME") + "  " + formatBold("ARCHETYPE") + "  " + formatBold("DEPENDS ON") + "  " + formatBold("PHASES"));
      for (const c of result.components) {
        console.log(`${c.name}  ${c.archetype}  ${c.dependsOn.join(", ") || "-"}  ${c.phases.join(", ")}`);
      }
    }
    console.error(formatSuccess(`Found ${formatBold(String(result.components.length))} component(s)`));
    return 0;
  }

  const result = await listCommand({
    path: args.path,
    format: listFormat,
  });

  printListResult(result);
  return result.success ? 0 : 1;
}

export async function runDescribe(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  // `chant describe <component> [path]` — component is the first positional
  // (args.path), the optional project dir is the second (args.extraPositional).
  const component = args.path;
  if (!component || component === ".") {
    console.error(formatError({
      message: "Component is required: chant describe <component> [path]",
      hint: "Run `chant list` to see component names.",
    }));
    return 1;
  }

  const describeFormat = (args.format || "text") as "text" | "json";
  if (describeFormat !== "text" && describeFormat !== "json") {
    console.error(formatError({ message: `Invalid format for describe: ${describeFormat}. Expected 'text' or 'json'.` }));
    return 1;
  }

  // `chant describe <name> --components` (#560): describe a discovered
  // `Component` (its full JSON contract projection) rather than a lexicon
  // resource's resolved props bag.
  if (args.components) {
    const result = await describeComponent(args.extraPositional ?? ".", component, args.sandbox);
    if (!result.success || !result.described) {
      console.log(result.output);
      return 1;
    }
    if (describeFormat === "json") {
      console.log(JSON.stringify(result.described.json, null, 2));
    } else {
      console.log(`${formatBold(result.described.name)}  (${result.described.filePath})`);
      console.log(JSON.stringify(result.described.json, null, 2));
    }
    console.error(formatSuccess(`Described ${formatBold(component)}`));
    return 0;
  }

  const result = await describeCommand({
    component,
    path: args.extraPositional ?? ".",
    format: describeFormat,
  });

  printDescribeResult(result);
  return result.success ? 0 : 1;
}

export async function runImport(ctx: CommandContext): Promise<number> {
  const { args } = ctx;

  // `--agents` (#chant audit --agents' other half): the source is this
  // machine's agent configuration rather than a template file, so there is
  // nothing to detect — the flag names the subject, like `--kustomize` below
  // names the lexicon.
  if (args.agents) {
    const scopes = parseScopes(args.scope);
    if (scopes instanceof Error) {
      console.error(formatError({ message: scopes.message }));
      return 1;
    }
    const runtimes = parseRuntimes(args.runtime);
    if (runtimes instanceof Error) {
      console.error(formatError({ message: runtimes.message }));
      return 1;
    }
    const { importAgentsCommand } = await import("../commands/import-agents");
    const result = await importAgentsCommand({
      lexicon: args.lexicon,
      output: args.output,
      force: args.force,
      scopes,
      runtimes,
      projectRoots: resolveProjectRoots(args),
    });
    for (const warning of result.warnings) console.warn(formatWarning({ message: warning }));
    if (!result.success) {
      console.error(formatError({ message: result.error ?? "Import failed." }));
      return 1;
    }
    console.log(
      formatSuccess(
        `Re-expressed ${result.summary.mapped} resource${result.summary.mapped === 1 ? "" : "s"} ` +
          `from ${result.summary.discovered} agent config${result.summary.discovered === 1 ? "" : "s"}:`,
      ),
    );
    for (const file of result.generatedFiles) console.log(`  ${file}`);
    return 0;
  }

  // `--kustomize <dir>` (#1548): render the overlay and import the output
  // through the k8s template parser — the flag NAMES the lexicon, so no JSON
  // detection. `kustomize build`, falling back to kubectl's vendored
  // kustomize when the standalone binary is absent; a big overlay renders
  // megabytes, hence the buffer bound.
  if (args.kustomize) {
    const { exec } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execAsync = promisify(exec);
    const run = (cmd: string) => execAsync(cmd, { maxBuffer: 64 * 1024 * 1024 });
    const quoted = `'${args.kustomize.replace(/'/g, "'\\''")}'`;
    let rendered: string;
    try {
      ({ stdout: rendered } = await run(`kustomize build ${quoted}`));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/ENOENT|not found|command not found|127/.test(message)) {
        console.error(formatError({ message: `kustomize build failed: ${message.split("\n")[0]}` }));
        return 1;
      }
      try {
        ({ stdout: rendered } = await run(`kubectl kustomize ${quoted}`));
      } catch (err2) {
        console.error(formatError({
          message: `neither kustomize nor kubectl could render ${args.kustomize}: ${err2 instanceof Error ? err2.message.split("\n")[0] : String(err2)}`,
        }));
        return 1;
      }
    }
    const result = await importFromContent({
      content: rendered,
      lexicon: "k8s",
      output: args.output,
      force: args.force,
    });
    printImportResult(result);
    return result.success ? 0 : 1;
  }

  // `--from <env>` switches import from a template file to a live source.
  if (args.migrateFrom) {
    const selector: ResourceSelector | undefined =
      args.selectType || args.selectName
        ? { type: args.selectType, name: args.selectName }
        : undefined;

    // Live config may carry secrets into generated source — warn before writing.
    console.error(formatWarning({
      message: "Live import may emit sensitive values (keys, tokens, passwords) into generated source. Review before committing.",
    }));

    // Multi-stack project (#932): import each declared stack from its own live
    // CloudFormation stack into its own source directory, rather than one flat
    // import against a single env-named stack. `--output` is per-stack here (the
    // stack's `src`), so it is ignored when `stacks` is configured.
    const { config } = await loadChantConfig(resolve("."));
    if (config.stacks && config.stacks.length > 0) {
      const perStack = await importFromLiveStacks(
        { environment: args.migrateFrom, lexicon: args.lexicon, force: args.force, selector, owned: args.owned, verbatim: args.verbatim },
        config.stacks,
      );
      let anyFailure = false;
      for (const { stack, result } of perStack) {
        console.error(formatBold(`■ stack ${stack} → ${config.stacks.find((s) => s.name === stack)?.src ?? ""}`));
        printImportResult(result);
        if (!result.success) anyFailure = true;
      }
      return anyFailure ? 1 : 0;
    }

    const result = await importFromLive({
      environment: args.migrateFrom,
      lexicon: args.lexicon,
      output: args.output,
      force: args.force,
      selector,
      owned: args.owned,
      verbatim: args.verbatim,
    });

    printImportResult(result);
    return result.success ? 0 : 1;
  }

  const result = await importCommand({
    templatePath: ctx.args.path,
    output: ctx.args.output,
    force: ctx.args.force,
  });

  printImportResult(result);
  return result.success ? 0 : 1;
}

export async function runUpdate(ctx: CommandContext): Promise<number> {
  const { updateCommand, printUpdateResult } = await import("../commands/update");
  const result = await updateCommand({ path: ctx.args.path });
  printUpdateResult(result);
  return result.success ? 0 : 1;
}

export async function runDoctor(ctx: CommandContext): Promise<number> {
  const { doctorCommand } = await import("../commands/doctor");
  const report = await doctorCommand(ctx.args.path);

  for (const check of report.checks) {
    const icon = check.status === "pass" ? "OK" : check.status === "warn" ? "WARN" : "FAIL";
    const msg = check.message ? ` — ${check.message}` : "";
    console.error(`  [${icon}] ${check.name}${msg}`);
  }

  if (!report.success) {
    console.error(formatError({ message: "Doctor found issues" }));
  } else {
    console.error(formatSuccess("All checks passed"));
  }
  return report.success ? 0 : 1;
}
