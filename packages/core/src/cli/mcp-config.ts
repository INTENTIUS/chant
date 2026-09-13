import { existsSync, writeFileSync } from "fs";
import { join } from "path";

/**
 * The one place chant decides where a project's MCP server registration
 * lives, what goes in it, and which command writes it (chant #2383).
 *
 * Before this module the three sites disagreed: `chant init` wrote
 * `mcp.json` into the user's home directory (picking a harness directory
 * that happened to exist), `chant doctor` looked for `<project>/.mcp.json`,
 * and the doctor's remediation named `chant agent setup`, which was never
 * registered in `./main.ts`. A project chant had just scaffolded therefore
 * failed chant's own doctor, and the fix the warning named could not be run.
 *
 * Project scope wins. The file versions with the project it describes, it
 * keeps `chant init <dir>` from writing outside `<dir>`, and it is already
 * what `../agents/discover.ts` treats as the project-scope location when
 * chant audits an agent installation it did not create. Every consumer must
 * go through the constants here rather than rebuilding the path, so the
 * three sites cannot drift apart again without the shared test in
 * ./mcp-config.test.ts noticing.
 */

/** Filename of the project-scoped MCP server registration. */
export const MCP_CONFIG_FILENAME = ".mcp.json";

/**
 * The command a user runs to (re)write a missing {@link MCP_CONFIG_FILENAME}
 * in an existing project. `chant init` also writes it, but init refuses a
 * non-empty directory without `--force`, so the remediation an already
 * scaffolded project needs is `chant update` — which is also what the
 * doctor's neighbouring skills check tells you to run for the same reason.
 * Kept as a constant so ./mcp-config.test.ts can assert it is a command
 * `commandRegistry` actually registers.
 */
export const MCP_SETUP_COMMAND = "chant update";

/** Absolute (or caller-relative) path to a project's MCP config. */
export function mcpConfigPath(projectDir: string): string {
  return join(projectDir, MCP_CONFIG_FILENAME);
}

/**
 * Detect whether a project uses bun or npm, from its lock file. Lives here
 * because the package manager is the only variable in the generated config.
 */
export function detectPackageManager(dir?: string): "bun" | "npm" {
  if (dir && (existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock")))) return "bun";
  return "npm";
}

/** The MCP registration chant writes: one stdio server named `chant`. */
export function generateMcpConfig(pm: "bun" | "npm"): string {
  const config = {
    mcpServers: {
      chant: {
        command: pm === "bun" ? "bunx" : "npx",
        args: ["chant", "serve", "mcp"],
      },
    },
  };

  return JSON.stringify(config, null, 2);
}

/**
 * Write `<projectDir>/.mcp.json` unless one is already there. Returns the
 * relative path when a file was created, `undefined` when an existing config
 * was left alone — callers report that difference to the user.
 */
export function writeProjectMcpConfig(projectDir: string): string | undefined {
  const path = mcpConfigPath(projectDir);
  if (existsSync(path)) return undefined;
  writeFileSync(path, generateMcpConfig(detectPackageManager(projectDir)));
  return MCP_CONFIG_FILENAME;
}
