/**
 * Presets for `ci.hooks.check` (#5451): the Sonar, Mend and Wiz scanners a
 * team already runs, as ordinary check hooks. {@link checkHookPreset} returns
 * the declaration entry, which a product's `init` hands to `writeCiHook` and
 * a person can paste into `ci.hooks.check`; nothing here runs a tool.
 *
 * Each entry is `sh -c <script> <name> <args...>` and the script:
 *
 * - names the credentials it needs and exits 78 before it runs the tool when
 *   one is unset, so a check without them fails, it is never skipped;
 * - runs the vendor's CLI, which a job installs itself (the presets pin and
 *   download nothing);
 * - writes what the tool found under `$CHANT_FINDINGS` (SARIF where the tool
 *   emits it, else a `<name>.status.json` file) for the check report to
 *   summarize (`./sarif.ts`), and exits with the tool's own status.
 *
 * The credentials reach the hook because {@link checkHookEnv} drops only the
 * forge's token, the OIDC request variables and cloud credentials; the
 * vendors' variables below are not among them.
 */

import type { OpWaveHook } from "../op/op-waves";

/** The presets' names. */
export const CHECK_HOOK_PRESET_NAMES = ["sonar", "mend", "wiz"] as const;
export type CheckHookPresetName = (typeof CHECK_HOOK_PRESET_NAMES)[number];

/** What a preset needs from the job's environment. */
export interface CheckHookPreset {
  name: CheckHookPresetName;
  /** The tool's name as the report shows it. */
  tool: string;
  /** The executable the job must have on `PATH`. */
  binary: string;
  /** Variables that must be set and non-empty, or the hook fails before it runs the tool. */
  credentials: readonly string[];
  /** Variables the tool also reads, which a job may set. */
  optional: readonly string[];
  /** What the hook writes under `$CHANT_FINDINGS`. */
  findings: string;
  /** The tool's arguments before the caller's own. */
  defaultArgs: readonly string[];
  script: string;
}

/** The shell prologue: the findings directory, and the refusal for an unset credential. */
function prologue(label: string, credentials: readonly string[]): string {
  const checks = credentials.map((c) => `[ -n "\${${c}:-}" ] || missing="$missing ${c}"`).join("; ");
  return [
    `F="\${CHANT_FINDINGS:-.chant/check/findings}"; mkdir -p "$F"; missing=""`,
    `${checks}`,
    `if [ -n "$missing" ]; then echo "chant ${label} preset: not set:$missing, so ${label} was not run and the check fails" >&2; exit 78; fi`,
  ].join("\n");
}

/** A status file for a tool with no SARIF: its exit code as passed or failed, and the link `urlExpr` expands to. */
function statusWriter(tool: string, file: string, urlExpr: string): string {
  return [
    `url=${urlExpr}`,
    `if [ "$rc" -eq 0 ]; then s=passed; else s=failed; fi`,
    `printf '{"tool":"${tool}","status":"%s","url":"%s"}\\n' "$s" "$url" > "$F/${file}"`,
  ].join("\n");
}

const SONAR_SCRIPT = [
  prologue("sonar", ["SONAR_TOKEN"]),
  // The scanner waits for the quality gate and exits non-zero when it fails.
  `sonar-scanner -Dsonar.qualitygate.wait=true "$@"; rc=$?`,
  statusWriter("sonar", "sonar.status.json", `$(sed -n 's/^dashboardUrl=//p' .scannerwork/report-task.txt 2>/dev/null | head -n 1)`),
  `exit $rc`,
].join("\n");

const MEND_SCRIPT = [
  prologue("mend", ["MEND_EMAIL", "MEND_USER_KEY"]),
  `mend "$@"; rc=$?`,
  statusWriter("mend", "mend.status.json", `""`),
  `exit $rc`,
].join("\n");

const WIZ_SCRIPT = [
  prologue("wiz", ["WIZ_CLIENT_ID", "WIZ_CLIENT_SECRET"]),
  `wizcli auth || exit $?`,
  `wizcli iac scan --path . -o "$F/wiz-iac.sarif,sarif" "$@"; rc=$?`,
  `exit $rc`,
].join("\n");

/** The presets, by name. */
export const CHECK_HOOK_PRESETS: Readonly<Record<CheckHookPresetName, CheckHookPreset>> = {
  sonar: {
    name: "sonar",
    tool: "SonarQube scanner",
    binary: "sonar-scanner",
    credentials: ["SONAR_TOKEN"],
    optional: ["SONAR_HOST_URL"],
    findings: "sonar.status.json: the quality gate's result and the dashboard link from .scannerwork/report-task.txt",
    defaultArgs: [],
    script: SONAR_SCRIPT,
  },
  mend: {
    name: "mend",
    tool: "Mend CLI",
    binary: "mend",
    credentials: ["MEND_EMAIL", "MEND_USER_KEY"],
    optional: ["MEND_URL"],
    findings: "mend.status.json: whether the CLI passed",
    defaultArgs: ["dep"],
    script: MEND_SCRIPT,
  },
  wiz: {
    name: "wiz",
    tool: "Wiz CLI",
    binary: "wizcli",
    credentials: ["WIZ_CLIENT_ID", "WIZ_CLIENT_SECRET"],
    optional: [],
    findings: "wiz-iac.sarif: the IaC scan's findings",
    defaultArgs: [],
    script: WIZ_SCRIPT,
  },
};

/** Options of {@link checkHookPreset}. */
export interface CheckHookPresetOptions {
  /** The tool's arguments, in place of the preset's default ones. */
  args?: readonly string[];
  /** The hook's name in the report. Default the preset's name. */
  name?: string;
  /** Run once per target, with `{target}` available to `args`. */
  perRun?: boolean;
  targets?: string[];
}

/** The `ci.hooks.check` entry for preset `name`. Throws for a name that is none. */
export function checkHookPreset(name: string, options: CheckHookPresetOptions = {}): OpWaveHook {
  const preset = (CHECK_HOOK_PRESETS as Record<string, CheckHookPreset | undefined>)[name];
  if (!preset) throw new Error(`no check hook preset ${JSON.stringify(name)}; the presets are ${CHECK_HOOK_PRESET_NAMES.join(", ")}`);
  const args = options.args ?? preset.defaultArgs;
  return {
    name: options.name ?? preset.name,
    command: ["sh", "-c", preset.script, `chant-preset-${preset.name}`, ...args],
    onFailure: "fail",
    ...(options.perRun ? { perRun: true } : {}),
    ...(options.targets ? { targets: options.targets } : {}),
  };
}
