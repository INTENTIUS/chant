/**
 * #4788: chant's cloud login (@intentius/chant/ci-login) passed to the Op
 * waves generator as a wave's `before` lines and `idTokens`, and as the
 * plans job's, per cloud. The rendered script lines are then run with sh,
 * as a GitLab runner runs them, with the job's id_tokens variables.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { parseYAML } from "@intentius/chant/yaml";
import { gitlabCloudLogin, type CloudLoginSpec } from "@intentius/chant/ci-login";
import { generateGitlabOpWavesPipeline } from "./generate-op-waves-pipeline";

const run = promisify(execFile);

const PROVIDER = "projects/123/locations/global/workloadIdentityPools/ci/providers/forge";
const CLOUDS: Record<"aws" | "gcp" | "azure", { spec: CloudLoginSpec; reads: string }> = {
  aws: { spec: { aws: { role: "arn:aws:iam::111111111111:role/apply", region: "eu-west-1" } }, reads: "AWS_WEB_IDENTITY_TOKEN_FILE" },
  gcp: { spec: { gcp: { serviceAccount: "apply@proj.iam.gserviceaccount.com", provider: PROVIDER } }, reads: "GOOGLE_APPLICATION_CREDENTIALS" },
  azure: { spec: { azure: { clientId: "11111111-1111-1111-1111-111111111111", tenantId: "00000000-0000-0000-0000-000000000001" } }, reads: "ARM_OIDC_TOKEN_FILE_PATH" },
};

type Job = { script: string[]; id_tokens?: Record<string, { aud: string }> };

describe("generateGitlabOpWavesPipeline: chant's cloud login (#4788)", () => {
  test.each(Object.keys(CLOUDS) as Array<keyof typeof CLOUDS>)("%s: the wave job and the plans job log in before their command, with the cloud's id_tokens, and the lines run", async (cloud) => {
    const login = gitlabCloudLogin(CLOUDS[cloud].spec);
    const spec: OpWavesSpec = {
      name: "migrations",
      op: "migrate",
      plan: ["./bin/plan", "{target}", "{plan}"],
      waves: [
        { name: "dev", runs: [{ target: "dev" }], gate: "never", idTokens: login.idTokens },
        { name: "prod", runs: [{ target: "a" }], gate: "on-destructive", approval: "pr-review" },
      ],
    };
    const doc = parseYAML(generateGitlabOpWavesPipeline(spec, { specFile: "waves.json", waveJobs: { dev: { before: login.steps } }, recordPlans: { before: login.steps, idTokens: login.idTokens } }).files[0]!.yaml) as Record<string, Job>;
    const lines = login.steps[0]!.run;
    const audience = Object.values(login.idTokens)[0]!;
    const variable = `CHANT_ID_TOKEN_${cloud.toUpperCase()}`;
    for (const [job, next] of [[doc["wave-1-dev"]!, "chant run wave --spec waves.json --wave 1"], [doc["migrations-record-plans"]!, "chant run wave --spec waves.json --record-plans"]] as const) {
      const at = job.script.indexOf(lines[0]!);
      expect(job.script.slice(at, at + lines.length + 1)).toEqual([...lines, next]);
      expect(job.id_tokens).toEqual({ [variable]: { aud: audience } });
    }
    expect(doc["wave-2-prod"]!.script).not.toContain(lines[0]);

    const dir = mkdtempSync(join(tmpdir(), "chant-login-gitlab-"));
    const wave = doc["wave-1-dev"]!.script;
    const at = wave.indexOf(lines[0]!);
    const { stdout } = await run("sh", ["-e", "-c", [...wave.slice(at, at + lines.length), `printf '%s' "$${CLOUDS[cloud].reads}"`].join("\n")], { env: { PATH: process.env.PATH!, TMPDIR: dir, CI_JOB_ID: "9", [variable]: "eyJgitlab.token.9" } });
    expect(stdout.startsWith(dir)).toBe(true);
    const file = cloud === "gcp" ? JSON.parse(readFileSync(stdout, "utf-8")).credential_source.file : stdout;
    expect(readFileSync(file, "utf-8")).toBe("eyJgitlab.token.9");
  });
});
