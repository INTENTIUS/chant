/**
 * #5196: every shape `chant release workflow` renders, byte for byte, one
 * snapshot file per forge and trigger. A feature that changes what a case
 * renders updates its file with `npx vitest run -u` and the diff shows the
 * change; the cases are named so a reviewer can find them.
 */
import { describe, expect, test } from "vitest";
import { join } from "node:path";
import { renderReleaseWorkflow, type ReleaseWorkflowInput } from "./release-workflow";
import type { SecurityGroup } from "./security";
import { resolveTagTemplate, type MemberTags } from "../lifecycle/release-tag";

const FORGES = ["github", "forgejo", "gitlab"] as const;
type Forge = (typeof FORGES)[number];
type Mode = "tag" | "templated" | "dispatch";

const tagsOf = (tag: Parameters<typeof resolveTagTemplate>[0]): MemberTags => ({ place: { member: null, path: null }, template: resolveTagTemplate(tag, null) });

/** Each case: a name, and what it adds to the mode's input. A case that throws on a forge records the message. */
function cases(forge: Forge, mode: Mode): Array<[string, Partial<ReleaseWorkflowInput>]> {
  const dispatch = mode === "dispatch";
  const gitlab = forge === "gitlab";
  const all: Array<[string, Partial<ReleaseWorkflowInput>]> = [
    ["minimal", {}],
    ["no install, no build", { install: null, build: null }],
    ["member root", { workspaceRoot: "packages/app" }],
    ["supply-chain", { groups: new Set<SecurityGroup>(["supply-chain"]) }],
    ["verified-releases", { groups: new Set<SecurityGroup>(["verified-releases"]) }],
    ["doctor on", { pipeline: { doctor: true } }],
    ["doctor off", { pipeline: { doctor: false } }],
    ["version", { version: true }],
    ["images", { images: true }],
    ["images with archives and platforms", { images: true, imageArchives: ["./dist/app.tar", "dist/web.tar"], imagePlatforms: ["linux/amd64", "linux/arm64"] }],
    ["artifacts", { artifacts: true }],
    ["artifacts with goreleaser", { artifacts: true, goreleaser: true }],
    ["signing", { signing: true }],
    ["signing with doctor off", { signing: true, pipeline: { doctor: false } }],
    // #5458: a KMS key's credentials in the publish step alone; keyless through a private Fulcio (Forgejo's OIDC token), or public Sigstore, which Forgejo refuses.
    ["signing with a KMS key", { groups: new Set<SecurityGroup>(["supply-chain"]), signing: true, signingEnv: ["VAULT_ADDR", "VAULT_TOKEN"] }],
    ["signing keyless through a private Fulcio", { signing: true, keyless: "private" }],
    ["signing keyless with public Sigstore", { signing: true, keyless: "public" }],
    // #5446: grype and syft for the scan before the stage.
    ["scan", { scan: true }],
    // #5457: docker login to a registry the images pull their bases from.
    ["pull login", { images: true, pullRegistries: [{ registry: "cgr.dev", usernameEnv: "CGR_USERNAME", passwordEnv: "CGR_PASSWORD" }] }],
    ["lane", { lane: "fast" }],
    ["gate head", { pipeline: { gate: "head" } }],
    ["green forge-checks", { green: "forge-checks" }],
    ["green none", { green: "none" }],
    ["after", { pipeline: { after: ["npm run announce", "echo done"] } }],
    ["env and setup", { pipeline: { env: { OCI_USERNAME: "bot" }, setup: [{ run: "echo setup" }, { name: "named", run: "echo named", env: { A: "1" } }] } }],
    ["permissions", gitlab ? {} : { pipeline: { permissions: { packages: "write" } } }],
    ["targets", { publish: [{ type: "oci", repository: "ghcr.io/acme/app" }, { type: "npm" }, { type: "forge", forge: "github" }] }],
    ["toolchains", gitlab ? { projectFiles: ["package.json", "go.mod"] } : { projectFiles: ["package.json", "go.mod"], pipeline: { toolchains: ["node", { name: "go", version: "1.23" }] } }],
    ["toolchains off", gitlab ? {} : { pipeline: { toolchains: false } }],
    [
      "builds",
      dispatch
        ? { pipeline: { builds: [{ name: "arm", runner: gitlab ? "arm64" : "ubuntu-24.04-arm", build: "make", outputs: ["dist/arm"], env: { GOARCH: "arm64" } }, { name: "mac", runner: ["macos-14"], build: "make mac", outputs: ["dist/mac"], install: false }] } }
        : {},
    ],
    [
      "everything",
      {
        workspaceRoot: "packages/app",
        groups: new Set<SecurityGroup>(["supply-chain", "verified-releases"]),
        version: true,
        images: true,
        imageArchives: ["dist/app.tar"],
        imagePlatforms: ["linux/arm64"],
        artifacts: true,
        goreleaser: true,
        signing: true,
        lane: "fast",
        green: "forge-checks",
        publish: [{ type: "forge", forge: "github" }, { type: "npm" }],
        pipeline: {
          doctor: true,
          after: ["echo after"],
          setup: [{ run: "echo setup" }],
          env: { EXTRA: "1" },
          ...(dispatch ? { builds: [{ name: "arm", runner: "arm64", build: "make", outputs: ["dist/arm"] }] } : {}),
        },
      },
    ],
  ];
  return all;
}

function render(forge: Forge, mode: Mode, over: Partial<ReleaseWorkflowInput>): string {
  const pipeline = { ...(over.pipeline ?? {}), ...(mode === "dispatch" ? { trigger: "dispatch" as const } : {}) };
  const input: ReleaseWorkflowInput = {
    forge,
    groups: new Set(),
    ...over,
    pipeline,
    ...(mode === "templated" ? { tags: tagsOf({ name: "v{version}", floating: "v{major}" }) } : {}),
  };
  try {
    return renderReleaseWorkflow(input);
  } catch (err) {
    return `throws: ${err instanceof Error ? err.message : String(err)}\n`;
  }
}

describe("release workflow snapshots (#5196)", () => {
  for (const forge of FORGES) {
    for (const mode of ["tag", "templated", "dispatch"] as const) {
      test(`${forge} ${mode}`, async () => {
        const text = cases(forge, mode)
          .map(([name, over]) => `# ==== ${name} ====\n${render(forge, mode, over)}`)
          .join("\n");
        await expect(text).toMatchFileSnapshot(join(__dirname, "__snapshots__", "release-workflow", `${forge}-${mode}.yml.snap`));
      });
    }
  }
});

/** #5154: a workspace root's members released as a train, dispatched or on its release-train tag. */
function trainCases(forge: Forge, trigger: "tag" | "dispatch"): Array<[string, Partial<ReleaseWorkflowInput>]> {
  const gitlab = forge === "gitlab";
  return [
    ["minimal", {}],
    ["no install, no build", { install: null, build: null }],
    ["member root", { workspaceRoot: "release" }],
    ["supply-chain", { groups: new Set<SecurityGroup>(["supply-chain"]) }],
    ["signing", { signing: true }],
    // #5458: the same signing modes in a train's jobs.
    ["signing with a KMS key", { groups: new Set<SecurityGroup>(["supply-chain"]), signing: true, signingEnv: ["VAULT_ADDR", "VAULT_TOKEN"] }],
    ["signing keyless through a private Fulcio", { signing: true, keyless: "private" }],
    ["signing keyless with public Sigstore", { signing: true, keyless: "public" }],
    ["scan", { scan: true }],
    // #5457: docker login to a registry the images pull their bases from.
    ["pull login", { pullRegistries: [{ registry: "cgr.dev", usernameEnv: "CGR_USERNAME", passwordEnv: "CGR_PASSWORD" }], train: { env: "npm", images: true } }],
    ["lane", { lane: "fast" }],
    ["gate head", { pipeline: { gate: "head" } }],
    ["green forge-checks", { green: "forge-checks" }],
    ["green none", { green: "none" }],
    ["after", { pipeline: { after: ["npm run announce"] } }],
    ["env and setup", { pipeline: { env: { CHANT_RELEASE_GATE: "1", NPM_TOKEN: "${{ secrets.NPM_TOKEN }}" }, setup: [{ run: "echo setup" }] } }],
    ["permissions", gitlab ? {} : { pipeline: { permissions: { packages: "write" } } }],
    ["targets", { publish: [{ type: "npm" }, { type: "forge", forge: "github" }] }],
    ["images", { images: true }],
    ["builds", trigger === "dispatch" ? { pipeline: { builds: [{ name: "arm", runner: "arm64", build: "make", outputs: ["dist/arm"] }] } } : {}],
    // #5216: what the members build at the cut, handed from the cut job to the publish job.
    ["member images", { train: { env: "npm", images: true, imagePlatforms: ["linux/amd64", "linux/arm64"] } }],
    ["member artifacts", { train: { env: "npm", artifacts: true } }],
    ["member goreleaser", { train: { env: "npm", artifacts: true, goreleaser: true, goreleaserDir: "cli" } }],
    ["verified-releases", { groups: new Set<SecurityGroup>(["verified-releases"]) }],
    ["doctor off", { pipeline: { doctor: false } }],
    // #5237: the members' per-platform builds, each run with the label the gate's plan gives its member.
    [
      "member builds",
      {
        workspaceRoot: "release",
        train: {
          env: "npm",
          artifacts: true,
          builds: [
            { member: "cli", dir: "packages/cli", files: ["go.mod"], build: { name: "cli-arm", runner: gitlab ? "arm64" : "ubuntu-24.04-arm", build: "make", outputs: ["dist/cli"], env: { GOARCH: "arm64" } } },
            { member: "web", dir: "packages/web", build: { name: "web-mac", runner: ["macos-14"], build: "make mac", outputs: ["dist/mac"], install: "make deps" } },
          ],
        },
      },
    ],
    ["member builds named twice", { train: { env: "npm", builds: ["a", "b"].map((member) => ({ member, dir: member, build: { name: "arm", runner: "arm64", build: "make", outputs: ["dist/arm"] } })) } }],
  ];
}

describe("release train workflow snapshots (#5154)", () => {
  for (const forge of FORGES) {
    for (const trigger of ["tag", "dispatch"] as const) {
      test(`${forge} train ${trigger}`, async () => {
        const text = trainCases(forge, trigger)
          .map(([name, over]) => {
            const input: ReleaseWorkflowInput = { forge, groups: new Set(), ...over, pipeline: { ...(over.pipeline ?? {}), ...(trigger === "dispatch" ? { trigger: "dispatch" as const } : {}) }, train: { env: "npm", ...(over.train ?? {}) } };
            let out: string;
            try {
              out = renderReleaseWorkflow(input);
            } catch (err) {
              out = `throws: ${err instanceof Error ? err.message : String(err)}\n`;
            }
            return `# ==== ${name} ====\n${out}`;
          })
          .join("\n");
        await expect(text).toMatchFileSnapshot(join(__dirname, "__snapshots__", "release-workflow", `${forge}-train-${trigger}.yml.snap`));
      });
    }
  }
});
