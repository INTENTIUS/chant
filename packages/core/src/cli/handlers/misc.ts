import { listCommand, printListResult } from "../commands/list";
import { describeCommand, printDescribeResult } from "../commands/describe";
import { importCommand, importFromLive, printImportResult } from "../commands/import";
import { auditCommand, printAuditResult, type AuditFormat, type AuditTier, type AuditFailOn } from "../commands/audit";
import type { ReportTheme } from "../../audit/report-html";
import type { ResourceSelector } from "../../lexicon";
import { formatError, formatSuccess, formatWarning } from "../format";
import type { CommandContext } from "../registry";
import { createRequire } from "module";

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
