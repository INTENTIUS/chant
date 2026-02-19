import { listCommand, printListResult } from "../commands/list";
import { importCommand, printImportResult } from "../commands/import";
import { formatError, formatSuccess } from "../format";
import type { CommandContext } from "../registry";

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

export async function runImport(ctx: CommandContext): Promise<number> {
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
