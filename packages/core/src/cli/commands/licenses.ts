import { resolve, join } from "node:path";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";

export interface LicenseEntry {
  name: string;
  version: string;
  license: string;
  licenseText?: string;
}

export interface LicensesResult {
  success: boolean;
  entries: LicenseEntry[];
  output: string;
}

/**
 * Read license info from a package's directory
 */
function readPackageLicense(pkgDir: string): LicenseEntry | null {
  const pkgJsonPath = join(pkgDir, "package.json");
  if (!existsSync(pkgJsonPath)) return null;

  try {
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
    if (!pkgJson.name) return null;

    const entry: LicenseEntry = {
      name: pkgJson.name,
      version: pkgJson.version || "unknown",
      license: pkgJson.license || "UNKNOWN",
    };

    // Try to read LICENSE file
    const licenseNames = ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "LICENCE.md"];
    for (const name of licenseNames) {
      const licensePath = join(pkgDir, name);
      if (existsSync(licensePath)) {
        entry.licenseText = readFileSync(licensePath, "utf-8");
        break;
      }
    }

    return entry;
  } catch {
    return null;
  }
}

/**
 * Scan node_modules for packages
 */
function scanNodeModules(nodeModulesDir: string): LicenseEntry[] {
  if (!existsSync(nodeModulesDir)) return [];

  const entries: LicenseEntry[] = [];
  const dirs = readdirSync(nodeModulesDir);

  for (const dir of dirs) {
    if (dir.startsWith(".")) continue;

    const fullPath = join(nodeModulesDir, dir);
    if (!statSync(fullPath).isDirectory()) continue;

    if (dir.startsWith("@")) {
      // Scoped packages
      const scopedDirs = readdirSync(fullPath);
      for (const scopedDir of scopedDirs) {
        const scopedPath = join(fullPath, scopedDir);
        if (statSync(scopedPath).isDirectory()) {
          const entry = readPackageLicense(scopedPath);
          if (entry) entries.push(entry);
        }
      }
    } else {
      const entry = readPackageLicense(fullPath);
      if (entry) entries.push(entry);
    }
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Format license entries as a text table
 */
function formatText(entries: LicenseEntry[]): string {
  if (entries.length === 0) return "No third-party packages found.";

  // Group by license type
  const groups = new Map<string, LicenseEntry[]>();
  for (const entry of entries) {
    const existing = groups.get(entry.license) ?? [];
    existing.push(entry);
    groups.set(entry.license, existing);
  }

  const lines: string[] = [];
  lines.push(`Third-party licenses (${entries.length} packages):`);
  lines.push("");

  // Find max widths for alignment
  const maxName = Math.max(...entries.map((e) => e.name.length), 7);
  const maxVersion = Math.max(...entries.map((e) => e.version.length), 7);

  lines.push(
    `${"Package".padEnd(maxName)}  ${"Version".padEnd(maxVersion)}  License`,
  );
  lines.push(`${"─".repeat(maxName)}  ${"─".repeat(maxVersion)}  ${"─".repeat(15)}`);

  for (const entry of entries) {
    lines.push(
      `${entry.name.padEnd(maxName)}  ${entry.version.padEnd(maxVersion)}  ${entry.license}`,
    );
  }

  lines.push("");
  lines.push("License summary:");
  const sortedGroups = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [license, pkgs] of sortedGroups) {
    lines.push(`  ${license}: ${pkgs.length}`);
  }

  return lines.join("\n");
}

/**
 * Format license entries as JSON
 */
function formatJson(entries: LicenseEntry[]): string {
  return JSON.stringify(
    entries.map(({ name, version, license }) => ({ name, version, license })),
    null,
    2,
  );
}

/**
 * Execute the licenses command
 */
export async function licensesCommand(options: {
  path: string;
  format: "text" | "json";
}): Promise<LicensesResult> {
  const projectPath = resolve(options.path);
  const nodeModulesDir = join(projectPath, "node_modules");

  const entries = scanNodeModules(nodeModulesDir);

  const output =
    options.format === "json" ? formatJson(entries) : formatText(entries);

  return {
    success: true,
    entries,
    output,
  };
}

/**
 * Print licenses result to console
 */
export function printLicensesResult(result: LicensesResult): void {
  console.log(result.output);
}
