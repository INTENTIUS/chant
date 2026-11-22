/**
 * The Wiz image scanner for the release scan gate (#5451).
 *
 * `release.scan: { imageScanner: "wiz" }` scans each image a publish would
 * push with `wizcli docker scan` in place of grype, and the findings go
 * through the same gate as any scanner's: the project's `vulnPolicy`, the VEX
 * files, `publish-scan-failed` before anything stages, and the `scanned`
 * line and `scan.json` referrer of #5446. The SBOM syft makes of an image's
 * layers is still made and attached (`./publish-oci.ts` asks the scanner for
 * it), and the SBOMs forge assets and npm packages carry are still scanned by
 * the wrapped scanner (grype or trivy), since Wiz scans images, not SBOMs.
 *
 * Wiz is a service. The job needs `WIZ_CLIENT_ID` and `WIZ_CLIENT_SECRET`,
 * and without them the publish refuses with `publish-scan-tool-missing`
 * rather than scanning with the other scanner and calling it Wiz. The binary
 * is `wizcli` on `PATH`, or the file `CHANT_WIZCLI` names. chant does not pin
 * or download it. A scan reads the results Wiz writes as SARIF
 * (`../components/sarif.ts`), so what a finding's severity and package are is
 * what the SARIF says.
 */

import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { sarifVulnFindings } from "../components/sarif";
import type { SbomDocument } from "../components/verbs/sbom-generator";
import type { VulnFinding } from "../components/verbs/vuln-scan";
import type { Redactor } from "./publish-credentials";
import type { ReleaseScanner } from "./publish-scan";
import { PublishTargetError } from "./release-publish";

const run = promisify(execFile);

/** The variables a Wiz scan needs, which the job sets from its secrets. */
export const WIZ_CREDENTIALS = ["WIZ_CLIENT_ID", "WIZ_CLIENT_SECRET"] as const;

/** The binary: `CHANT_WIZCLI` when set, else `wizcli` on `PATH`. */
export function wizcliPath(env: NodeJS.ProcessEnv): string {
  const v = env.CHANT_WIZCLI;
  return v && v !== "" ? v : "wizcli";
}

/** The arguments `wizcli` runs with on an image archive, writing SARIF to `out`. */
export function wizImageArgs(archive: string, out: string): string[] {
  return ["docker", "scan", "--image-tarball", archive, "-o", `${out},sarif`];
}

/**
 * A {@link ReleaseScanner} that scans images with Wiz and everything else
 * with `base`. `base` makes an image's SBOM, scans SBOMs, and says whether
 * its own tools are there.
 */
export function wizReleaseScanner(env: NodeJS.ProcessEnv, base: ReleaseScanner, opts: { redactor?: Redactor } = {}): ReleaseScanner {
  const bin = wizcliPath(env);
  // The archive each image SBOM was made from, so scan() of that SBOM is Wiz's scan of the image.
  const archives = new WeakMap<SbomDocument, string>();
  let version: { value: string | null; reason: string | null } | null = null;
  const probe = () => {
    if (version) return version;
    try {
      const out = execFileSync(bin, ["version"], { encoding: "utf-8", env, stdio: ["ignore", "pipe", "pipe"] });
      version = { value: /(\d+\.\d+\.\d+)/.exec(out)?.[1] ? `v${/(\d+\.\d+\.\d+)/.exec(out)![1]}` : null, reason: null };
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      version = { value: null, reason: e.code === "ENOENT" ? `${bin} is not there: install the Wiz CLI on PATH, or set CHANT_WIZCLI to it` : `${bin} version failed: ${e.message}` };
    }
    return version;
  };
  const tail = (err: unknown) => {
    const e = err as Error & { stderr?: string };
    const t = String(e.stderr ?? e.message).trim().split("\n").filter(Boolean).slice(-3).join("; ");
    return opts.redactor ? opts.redactor.redact(t) : t;
  };
  return {
    get name() {
      return `wizcli${probe().value ? ` ${probe().value}` : ""} for images, ${base.name} for SBOMs`;
    },
    unavailable({ images }) {
      const unset = WIZ_CREDENTIALS.filter((v) => !env[v]);
      if (unset.length > 0) return `release.scan.imageScanner is wiz, and ${unset.join(" and ")} ${unset.length === 1 ? "is" : "are"} not set: pass the Wiz service account's credentials to the publish step`;
      return probe().reason ?? base.unavailable({ images });
    },
    async imageSbom(archive) {
      const sbom = await base.imageSbom(archive);
      archives.set(sbom, archive);
      return sbom;
    },
    async scan(sbom): Promise<VulnFinding[]> {
      const archive = archives.get(sbom);
      if (archive === undefined) return base.scan(sbom);
      const dir = mkdtempSync(join(tmpdir(), "chant-wiz-"));
      try {
        let image = archive;
        if (existsSync(archive) && statSync(archive).isDirectory()) {
          image = join(dir, "image.tar");
          try {
            await run("tar", ["-cf", image, "-C", archive, "."]);
          } catch (err) {
            throw new PublishTargetError("publish-scan-tool-failed", `the image layout in ${archive} could not be packed for wizcli: ${tail(err)}`);
          }
        }
        const out = join(dir, "wiz.sarif");
        let exit = 0;
        let message = "";
        try {
          await run(bin, wizImageArgs(image, out), { env, maxBuffer: 64 * 1024 * 1024 });
        } catch (err) {
          // wizcli exits non-zero when Wiz's own policy fails the image. The findings are what chant's gate reads, so a SARIF file settles it.
          exit = (err as { code?: number }).code ?? 1;
          message = tail(err);
        }
        if (!existsSync(out)) {
          throw new PublishTargetError("publish-scan-tool-failed", `wizcli did not write results for ${archive} (exit ${exit}${message ? `: ${message}` : ""})`, "Check that WIZ_CLIENT_ID and WIZ_CLIENT_SECRET belong to a service account that may scan images, and that the job reaches Wiz.");
        }
        try {
          return sarifVulnFindings(readFileSync(out, "utf-8"));
        } catch {
          throw new PublishTargetError("publish-scan-tool-failed", `wizcli wrote results for ${archive} that are not SARIF`);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    ...(base.database ? { database: base.database.bind(base) } : {}),
  };
}

/** `base`, or Wiz over it when the scan setting names `imageScanner: "wiz"`. */
export function withImageScanner(setting: { imageScanner?: "wiz" }, env: NodeJS.ProcessEnv, base: ReleaseScanner, opts: { redactor?: Redactor } = {}): ReleaseScanner {
  return setting.imageScanner === "wiz" ? wizReleaseScanner(env, base, opts) : base;
}
