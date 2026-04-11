import { describe, test, expect } from "vitest";
import { Checkout } from "./checkout";
import { SetupNode } from "./setup-node";
import { SetupGo } from "./setup-go";
import { SetupPython } from "./setup-python";
import { CacheAction } from "./cache";
import { UploadArtifact } from "./upload-artifact";
import { DownloadArtifact } from "./download-artifact";
import { NodeCI } from "./node-ci";
import { NodePipeline, BunPipeline, PnpmPipeline, YarnPipeline } from "./node-pipeline";
import { PythonCI } from "./python-ci";
import { DockerBuild } from "./docker-build";
import { DeployEnvironment } from "./deploy-environment";
import { GoCI } from "./go-ci";

// ── Checkout ────────────────────────────────────────────────────────

describe("Checkout", () => {
  test("returns step with checkout action", () => {
    const result = Checkout({});
    expect(result.step).toBeDefined();
    expect(result.step.props.uses).toBe("actions/checkout@v4");
    expect(result.step.props.name).toBe("Checkout");
  });

  test("passes ref as with input", () => {
    const result = Checkout({ ref: "develop" });
    expect(result.step.props.with).toBeDefined();
    expect((result.step.props.with as Record<string, string>).ref).toBe("develop");
  });

  test("passes fetchDepth as with input", () => {
    const result = Checkout({ fetchDepth: 0 });
    expect((result.step.props.with as Record<string, string>)["fetch-depth"]).toBe("0");
  });

  test("omits with when no optional props", () => {
    const result = Checkout({});
    expect(result.step.props.with).toBeUndefined();
  });
});

// ── SetupNode ───────────────────────────────────────────────────────

describe("SetupNode", () => {
  test("returns step with setup-node action", () => {
    const result = SetupNode({});
    expect(result.step.props.uses).toBe("actions/setup-node@v4");
    expect(result.step.props.name).toBe("Setup Node.js");
  });

  test("passes nodeVersion", () => {
    const result = SetupNode({ nodeVersion: "22" });
    expect((result.step.props.with as Record<string, string>)["node-version"]).toBe("22");
  });

  test("passes cache option", () => {
    const result = SetupNode({ cache: "npm" });
    expect((result.step.props.with as Record<string, string>).cache).toBe("npm");
  });
});

// ── SetupGo ─────────────────────────────────────────────────────────

describe("SetupGo", () => {
  test("returns step with setup-go action", () => {
    const result = SetupGo({});
    expect(result.step.props.uses).toBe("actions/setup-go@v5");
  });

  test("passes goVersion", () => {
    const result = SetupGo({ goVersion: "1.22" });
    expect((result.step.props.with as Record<string, string>)["go-version"]).toBe("1.22");
  });
});

// ── SetupPython ─────────────────────────────────────────────────────

describe("SetupPython", () => {
  test("returns step with setup-python action", () => {
    const result = SetupPython({});
    expect(result.step.props.uses).toBe("actions/setup-python@v5");
  });

  test("passes pythonVersion", () => {
    const result = SetupPython({ pythonVersion: "3.12" });
    expect((result.step.props.with as Record<string, string>)["python-version"]).toBe("3.12");
  });
});

// ── CacheAction ─────────────────────────────────────────────────────

describe("CacheAction", () => {
  test("returns step with cache action", () => {
    const result = CacheAction({ path: "node_modules", key: "npm-${{ hashFiles('package-lock.json') }}" });
    expect(result.step.props.uses).toBe("actions/cache@v4");
    expect((result.step.props.with as Record<string, string>).path).toBe("node_modules");
    expect((result.step.props.with as Record<string, string>).key).toBe("npm-${{ hashFiles('package-lock.json') }}");
  });
});

// ── UploadArtifact ──────────────────────────────────────────────────

describe("UploadArtifact", () => {
  test("returns step with upload action", () => {
    const result = UploadArtifact({ name: "build", path: "dist/" });
    expect(result.step.props.uses).toBe("actions/upload-artifact@v4");
    expect((result.step.props.with as Record<string, string>).name).toBe("build");
    expect((result.step.props.with as Record<string, string>).path).toBe("dist/");
  });

  test("passes retentionDays", () => {
    const result = UploadArtifact({ name: "build", path: "dist/", retentionDays: 7 });
    expect((result.step.props.with as Record<string, string>)["retention-days"]).toBe("7");
  });
});

// ── DownloadArtifact ────────────────────────────────────────────────

describe("DownloadArtifact", () => {
  test("returns step with download action", () => {
    const result = DownloadArtifact({ name: "build" });
    expect(result.step.props.uses).toBe("actions/download-artifact@v4");
    expect((result.step.props.with as Record<string, string>).name).toBe("build");
  });
});

// ── NodeCI ──────────────────────────────────────────────────────────

describe("NodeCI", () => {
  test("returns workflow and job", () => {
    const result = NodeCI({ nodeVersion: "22" });
    expect(result.workflow).toBeDefined();
    expect(result.job).toBeDefined();
  });

  test("workflow has CI name", () => {
    const result = NodeCI({});
    expect(result.workflow.props.name).toBe("CI");
  });

  test("job has ubuntu-latest runner", () => {
    const result = NodeCI({});
    expect(result.job.props["runs-on"]).toBe("ubuntu-latest");
  });

  test("job has steps array", () => {
    const result = NodeCI({});
    expect(Array.isArray(result.job.props.steps)).toBe(true);
    expect((result.job.props.steps as unknown[]).length).toBe(5);
  });

  test("uses default npm commands", () => {
    const result = NodeCI({});
    const steps = result.job.props.steps as Array<{ props: Record<string, unknown> }>;
    const installStep = steps[2];
    expect(installStep.props.run).toBe("npm ci");
  });

  test("uses pnpm when specified", () => {
    const result = NodeCI({ packageManager: "pnpm" });
    const steps = result.job.props.steps as Array<{ props: Record<string, unknown> }>;
    const installStep = steps[2];
    expect(installStep.props.run).toBe("pnpm install");
  });

  test("uses custom installCommand", () => {
    const result = NodeCI({ installCommand: "yarn install --frozen-lockfile" });
    const steps = result.job.props.steps as Array<{ props: Record<string, unknown> }>;
    const installStep = steps[2];
    expect(installStep.props.run).toBe("yarn install --frozen-lockfile");
  });
});

// ── NodePipeline ────────────────────────────────────────────────────

describe("NodePipeline", () => {
  test("returns workflow, buildJob, testJob", () => {
    const result = NodePipeline({});
    expect(result.workflow).toBeDefined();
    expect(result.buildJob).toBeDefined();
    expect(result.testJob).toBeDefined();
  });

  test("workflow has Node Pipeline name", () => {
    const result = NodePipeline({});
    expect(result.workflow.props.name).toBe("Node Pipeline");
  });

  test("buildJob has 5 steps (checkout, setup, install, build, upload)", () => {
    const result = NodePipeline({});
    const steps = result.buildJob.props.steps as unknown[];
    expect(steps.length).toBe(5);
  });

  test("testJob has 5 steps (checkout, setup, install, download, test)", () => {
    const result = NodePipeline({});
    const steps = result.testJob.props.steps as unknown[];
    expect(steps.length).toBe(5);
  });

  test("testJob depends on build", () => {
    const result = NodePipeline({});
    expect(result.testJob.props.needs).toEqual(["build"]);
  });

  test("uses npm ci by default", () => {
    const result = NodePipeline({});
    const steps = result.buildJob.props.steps as Array<{ props: Record<string, unknown> }>;
    expect(steps[2].props.run).toBe("npm ci");
  });

  test("uses pnpm install with frozen lockfile", () => {
    const result = NodePipeline({ packageManager: "pnpm" });
    const steps = result.buildJob.props.steps as Array<{ props: Record<string, unknown> }>;
    expect(steps[2].props.run).toBe("pnpm install --frozen-lockfile");
  });

  test("uses yarn install with frozen lockfile", () => {
    const result = NodePipeline({ packageManager: "yarn" });
    const steps = result.buildJob.props.steps as Array<{ props: Record<string, unknown> }>;
    expect(steps[2].props.run).toBe("yarn install --frozen-lockfile");
  });

  test("bun uses oven-sh/setup-bun instead of setup-node", () => {
    const result = NodePipeline({ packageManager: "bun" });
    const steps = result.buildJob.props.steps as Array<{ props: Record<string, unknown> }>;
    expect(steps[1].props.uses).toBe("oven-sh/setup-bun@v2");
    expect(steps[1].props.name).toBe("Setup Bun");
  });

  test("bun uses bun install with frozen lockfile", () => {
    const result = NodePipeline({ packageManager: "bun" });
    const steps = result.buildJob.props.steps as Array<{ props: Record<string, unknown> }>;
    expect(steps[2].props.run).toBe("bun install --frozen-lockfile");
  });

  test("npm setup step has cache: npm", () => {
    const result = NodePipeline({ packageManager: "npm" });
    const steps = result.buildJob.props.steps as Array<{ props: Record<string, unknown> }>;
    expect((steps[1].props.with as Record<string, string>).cache).toBe("npm");
  });

  test("upload step uses upload-artifact with configured name", () => {
    const result = NodePipeline({ artifactName: "my-build" });
    const steps = result.buildJob.props.steps as Array<{ props: Record<string, unknown> }>;
    expect(steps[4].props.uses).toBe("actions/upload-artifact@v4");
    expect((steps[4].props.with as Record<string, string>).name).toBe("my-build");
  });

  test("download step in testJob uses configured artifact name", () => {
    const result = NodePipeline({ artifactName: "my-build" });
    const steps = result.testJob.props.steps as Array<{ props: Record<string, unknown> }>;
    expect(steps[3].props.uses).toBe("actions/download-artifact@v4");
    expect((steps[3].props.with as Record<string, string>).name).toBe("my-build");
  });

  test("uses custom runsOn", () => {
    const result = NodePipeline({ runsOn: "self-hosted" });
    expect(result.buildJob.props["runs-on"]).toBe("self-hosted");
    expect(result.testJob.props["runs-on"]).toBe("self-hosted");
  });

  test("uses custom installCommand", () => {
    const result = NodePipeline({ installCommand: "npm install --legacy-peer-deps" });
    const steps = result.buildJob.props.steps as Array<{ props: Record<string, unknown> }>;
    expect(steps[2].props.run).toBe("npm install --legacy-peer-deps");
  });

  test("build step uses configured script", () => {
    const result = NodePipeline({ buildScript: "compile" });
    const steps = result.buildJob.props.steps as Array<{ props: Record<string, unknown> }>;
    expect(steps[3].props.run).toBe("npm run compile");
  });

  test("test step uses configured script", () => {
    const result = NodePipeline({ testScript: "test:ci" });
    const steps = result.testJob.props.steps as Array<{ props: Record<string, unknown> }>;
    expect(steps[4].props.run).toBe("npm run test:ci");
  });
});

// ── NodePipeline Presets ────────────────────────────────────────────

describe("BunPipeline", () => {
  test("defaults to bun package manager", () => {
    const result = BunPipeline({});
    const steps = result.buildJob.props.steps as Array<{ props: Record<string, unknown> }>;
    expect(steps[1].props.uses).toBe("oven-sh/setup-bun@v2");
    expect(steps[2].props.run).toBe("bun install --frozen-lockfile");
  });
});

describe("PnpmPipeline", () => {
  test("defaults to pnpm package manager", () => {
    const result = PnpmPipeline({});
    const steps = result.buildJob.props.steps as Array<{ props: Record<string, unknown> }>;
    expect((steps[1].props.with as Record<string, string>).cache).toBe("pnpm");
    expect(steps[2].props.run).toBe("pnpm install --frozen-lockfile");
  });
});

describe("YarnPipeline", () => {
  test("defaults to yarn package manager", () => {
    const result = YarnPipeline({});
    const steps = result.buildJob.props.steps as Array<{ props: Record<string, unknown> }>;
    expect((steps[1].props.with as Record<string, string>).cache).toBe("yarn");
    expect(steps[2].props.run).toBe("yarn install --frozen-lockfile");
  });
});

// ── PythonCI ────────────────────────────────────────────────────────

describe("PythonCI", () => {
  test("returns workflow and testJob", () => {
    const result = PythonCI({});
    expect(result.workflow).toBeDefined();
    expect(result.testJob).toBeDefined();
  });

  test("workflow has Python CI name", () => {
    const result = PythonCI({});
    expect(result.workflow.props.name).toBe("Python CI");
  });

  test("includes lintJob by default", () => {
    const result = PythonCI({});
    expect(result.lintJob).toBeDefined();
  });

  test("omits lintJob when lintCommand is null", () => {
    const result = PythonCI({ lintCommand: null });
    expect(result.lintJob).toBeUndefined();
  });

  test("testJob uses setup-python with default version", () => {
    const result = PythonCI({});
    const steps = result.testJob.props.steps as Array<{ props: Record<string, unknown> }>;
    const setupStep = steps[1];
    expect(setupStep.props.uses).toBe("actions/setup-python@v5");
    expect((setupStep.props.with as Record<string, string>)["python-version"]).toBe("3.12");
  });

  test("testJob uses pip cache by default", () => {
    const result = PythonCI({});
    const steps = result.testJob.props.steps as Array<{ props: Record<string, unknown> }>;
    expect((steps[1].props.with as Record<string, string>).cache).toBe("pip");
  });

  test("poetry mode uses poetry cache", () => {
    const result = PythonCI({ usePoetry: true });
    const steps = result.testJob.props.steps as Array<{ props: Record<string, unknown> }>;
    expect((steps[1].props.with as Record<string, string>).cache).toBe("poetry");
  });

  test("poetry mode installs poetry first", () => {
    const result = PythonCI({ usePoetry: true });
    const steps = result.testJob.props.steps as Array<{ props: Record<string, unknown> }>;
    expect(steps[2].props.run).toBe("pip install poetry");
    expect(steps[3].props.run).toBe("poetry install");
  });

  test("pip mode installs from requirements.txt", () => {
    const result = PythonCI({});
    const steps = result.testJob.props.steps as Array<{ props: Record<string, unknown> }>;
    expect(steps[2].props.run).toBe("pip install -r requirements.txt");
  });

  test("uses custom requirements file", () => {
    const result = PythonCI({ requirementsFile: "requirements-dev.txt" });
    const steps = result.testJob.props.steps as Array<{ props: Record<string, unknown> }>;
    expect(steps[2].props.run).toBe("pip install -r requirements-dev.txt");
  });

  test("test step uses configured command", () => {
    const result = PythonCI({ testCommand: "python -m pytest" });
    const steps = result.testJob.props.steps as Array<{ props: Record<string, unknown> }>;
    const lastStep = steps[steps.length - 1];
    expect(lastStep.props.run).toBe("python -m pytest");
  });

  test("lint step uses configured command", () => {
    const result = PythonCI({ lintCommand: "flake8 ." });
    const steps = result.lintJob!.props.steps as Array<{ props: Record<string, unknown> }>;
    const lastStep = steps[steps.length - 1];
    expect(lastStep.props.run).toBe("flake8 .");
  });

  test("uses custom python version", () => {
    const result = PythonCI({ pythonVersion: "3.11" });
    const steps = result.testJob.props.steps as Array<{ props: Record<string, unknown> }>;
    expect((steps[1].props.with as Record<string, string>)["python-version"]).toBe("3.11");
  });

  test("uses custom runsOn", () => {
    const result = PythonCI({ runsOn: "macos-latest" });
    expect(result.testJob.props["runs-on"]).toBe("macos-latest");
  });
});

// ── DockerBuild ─────────────────────────────────────────────────────

describe("DockerBuild", () => {
  test("returns workflow and job", () => {
    const result = DockerBuild({});
    expect(result.workflow).toBeDefined();
    expect(result.job).toBeDefined();
  });

  test("workflow has Docker Build name", () => {
    const result = DockerBuild({});
    expect(result.workflow.props.name).toBe("Docker Build");
  });

  test("workflow has packages write permission", () => {
    const result = DockerBuild({});
    expect((result.workflow.props.permissions as Record<string, string>).packages).toBe("write");
    expect((result.workflow.props.permissions as Record<string, string>).contents).toBe("read");
  });

  test("job has 5 steps", () => {
    const result = DockerBuild({});
    const steps = result.job.props.steps as unknown[];
    expect(steps.length).toBe(5);
  });

  test("uses docker/login-action", () => {
    const result = DockerBuild({});
    const steps = result.job.props.steps as Array<{ props: Record<string, unknown> }>;
    expect(steps[1].props.uses).toBe("docker/login-action@v3");
  });

  test("uses docker/setup-buildx-action", () => {
    const result = DockerBuild({});
    const steps = result.job.props.steps as Array<{ props: Record<string, unknown> }>;
    expect(steps[2].props.uses).toBe("docker/setup-buildx-action@v3");
  });

  test("uses docker/metadata-action", () => {
    const result = DockerBuild({});
    const steps = result.job.props.steps as Array<{ props: Record<string, unknown> }>;
    expect(steps[3].props.uses).toBe("docker/metadata-action@v5");
  });

  test("uses docker/build-push-action", () => {
    const result = DockerBuild({});
    const steps = result.job.props.steps as Array<{ props: Record<string, unknown> }>;
    expect(steps[4].props.uses).toBe("docker/build-push-action@v6");
  });

  test("login step uses ghcr.io by default", () => {
    const result = DockerBuild({});
    const steps = result.job.props.steps as Array<{ props: Record<string, unknown> }>;
    expect((steps[1].props.with as Record<string, string>).registry).toBe("ghcr.io");
  });

  test("uses custom registry", () => {
    const result = DockerBuild({ registry: "docker.io" });
    const steps = result.job.props.steps as Array<{ props: Record<string, unknown> }>;
    expect((steps[1].props.with as Record<string, string>).registry).toBe("docker.io");
  });

  test("build-push step has push: true by default", () => {
    const result = DockerBuild({});
    const steps = result.job.props.steps as Array<{ props: Record<string, unknown> }>;
    expect((steps[4].props.with as Record<string, string>).push).toBe("true");
  });

  test("build-push step uses configured dockerfile", () => {
    const result = DockerBuild({ dockerfile: "Dockerfile.prod" });
    const steps = result.job.props.steps as Array<{ props: Record<string, unknown> }>;
    expect((steps[4].props.with as Record<string, string>).file).toBe("Dockerfile.prod");
  });

  test("build-push step includes platforms when specified", () => {
    const result = DockerBuild({ platforms: ["linux/amd64", "linux/arm64"] });
    const steps = result.job.props.steps as Array<{ props: Record<string, unknown> }>;
    expect((steps[4].props.with as Record<string, string>).platforms).toBe("linux/amd64,linux/arm64");
  });

  test("build-push step omits platforms when not specified", () => {
    const result = DockerBuild({});
    const steps = result.job.props.steps as Array<{ props: Record<string, unknown> }>;
    expect((steps[4].props.with as Record<string, string>).platforms).toBeUndefined();
  });

  test("build-push step includes build-args when specified", () => {
    const result = DockerBuild({ buildArgs: { NODE_ENV: "production", VERSION: "1.0" } });
    const steps = result.job.props.steps as Array<{ props: Record<string, unknown> }>;
    expect((steps[4].props.with as Record<string, string>)["build-args"]).toBe("NODE_ENV=production\nVERSION=1.0");
  });

  test("uses custom runsOn", () => {
    const result = DockerBuild({ runsOn: "self-hosted" });
    expect(result.job.props["runs-on"]).toBe("self-hosted");
  });
});

// ── DeployEnvironment ───────────────────────────────────────────────

describe("DeployEnvironment", () => {
  test("returns deployJob and cleanupJob", () => {
    const result = DeployEnvironment({ name: "staging", deployScript: "npm run deploy" });
    expect(result.deployJob).toBeDefined();
    expect(result.cleanupJob).toBeDefined();
  });

  test("deployJob has environment with name", () => {
    const result = DeployEnvironment({ name: "staging", deployScript: "npm run deploy" });
    expect((result.deployJob.props.environment as Record<string, string>).name).toBe("staging");
  });

  test("deployJob has environment url when specified", () => {
    const result = DeployEnvironment({
      name: "staging",
      deployScript: "npm run deploy",
      url: "https://staging.example.com",
    });
    expect((result.deployJob.props.environment as Record<string, string>).url).toBe("https://staging.example.com");
  });

  test("deployJob has concurrency group", () => {
    const result = DeployEnvironment({ name: "staging", deployScript: "npm run deploy" });
    const concurrency = result.deployJob.props.concurrency as Record<string, unknown>;
    expect(concurrency.group).toBe("deploy-staging");
    expect(concurrency["cancel-in-progress"]).toBe(true);
  });

  test("uses custom concurrency group", () => {
    const result = DeployEnvironment({
      name: "staging",
      deployScript: "npm run deploy",
      concurrencyGroup: "custom-group",
    });
    const concurrency = result.deployJob.props.concurrency as Record<string, unknown>;
    expect(concurrency.group).toBe("custom-group");
  });

  test("deployJob has checkout + deploy steps", () => {
    const result = DeployEnvironment({ name: "staging", deployScript: "npm run deploy" });
    const steps = result.deployJob.props.steps as Array<{ props: Record<string, unknown> }>;
    expect(steps.length).toBe(2);
    expect(steps[0].props.uses).toBe("actions/checkout@v4");
    expect(steps[1].props.run).toBe("npm run deploy");
  });

  test("deployScript accepts array", () => {
    const result = DeployEnvironment({
      name: "staging",
      deployScript: ["npm run build", "npm run deploy"],
    });
    const steps = result.deployJob.props.steps as Array<{ props: Record<string, unknown> }>;
    expect(steps.length).toBe(3);
    expect(steps[1].props.run).toBe("npm run build");
    expect(steps[2].props.run).toBe("npm run deploy");
  });

  test("cleanupJob has default cleanup script", () => {
    const result = DeployEnvironment({ name: "staging", deployScript: "npm run deploy" });
    const steps = result.cleanupJob.props.steps as Array<{ props: Record<string, unknown> }>;
    expect(steps[1].props.run).toBe('echo "Cleaning up..."');
  });

  test("cleanupJob uses custom cleanup script", () => {
    const result = DeployEnvironment({
      name: "staging",
      deployScript: "npm run deploy",
      cleanupScript: "npm run teardown",
    });
    const steps = result.cleanupJob.props.steps as Array<{ props: Record<string, unknown> }>;
    expect(steps[1].props.run).toBe("npm run teardown");
  });

  test("cleanupJob has environment with name", () => {
    const result = DeployEnvironment({ name: "production", deployScript: "npm run deploy" });
    expect((result.cleanupJob.props.environment as Record<string, string>).name).toBe("production");
  });

  test("uses custom runsOn", () => {
    const result = DeployEnvironment({
      name: "staging",
      deployScript: "npm run deploy",
      runsOn: "self-hosted",
    });
    expect(result.deployJob.props["runs-on"]).toBe("self-hosted");
    expect(result.cleanupJob.props["runs-on"]).toBe("self-hosted");
  });
});

// ── GoCI ────────────────────────────────────────────────────────────

describe("GoCI", () => {
  test("returns workflow, buildJob, testJob", () => {
    const result = GoCI({});
    expect(result.workflow).toBeDefined();
    expect(result.buildJob).toBeDefined();
    expect(result.testJob).toBeDefined();
  });

  test("workflow has Go CI name", () => {
    const result = GoCI({});
    expect(result.workflow.props.name).toBe("Go CI");
  });

  test("includes lintJob by default", () => {
    const result = GoCI({});
    expect(result.lintJob).toBeDefined();
  });

  test("omits lintJob when lintCommand is null", () => {
    const result = GoCI({ lintCommand: null });
    expect(result.lintJob).toBeUndefined();
  });

  test("buildJob has 3 steps (checkout, setup-go, build)", () => {
    const result = GoCI({});
    const steps = result.buildJob.props.steps as unknown[];
    expect(steps.length).toBe(3);
  });

  test("testJob has 3 steps (checkout, setup-go, test)", () => {
    const result = GoCI({});
    const steps = result.testJob.props.steps as unknown[];
    expect(steps.length).toBe(3);
  });

  test("buildJob uses setup-go with default version", () => {
    const result = GoCI({});
    const steps = result.buildJob.props.steps as Array<{ props: Record<string, unknown> }>;
    expect(steps[1].props.uses).toBe("actions/setup-go@v5");
    expect((steps[1].props.with as Record<string, string>)["go-version"]).toBe("1.22");
  });

  test("uses custom go version", () => {
    const result = GoCI({ goVersion: "1.21" });
    const steps = result.buildJob.props.steps as Array<{ props: Record<string, unknown> }>;
    expect((steps[1].props.with as Record<string, string>)["go-version"]).toBe("1.21");
  });

  test("buildJob runs go build by default", () => {
    const result = GoCI({});
    const steps = result.buildJob.props.steps as Array<{ props: Record<string, unknown> }>;
    expect(steps[2].props.run).toBe("go build ./...");
  });

  test("testJob runs go test with race detector by default", () => {
    const result = GoCI({});
    const steps = result.testJob.props.steps as Array<{ props: Record<string, unknown> }>;
    expect(steps[2].props.run).toBe("go test ./... -v -race");
  });

  test("uses custom build command", () => {
    const result = GoCI({ buildCommand: "go build -o bin/app ./cmd/app" });
    const steps = result.buildJob.props.steps as Array<{ props: Record<string, unknown> }>;
    expect(steps[2].props.run).toBe("go build -o bin/app ./cmd/app");
  });

  test("uses custom test command", () => {
    const result = GoCI({ testCommand: "go test -short ./..." });
    const steps = result.testJob.props.steps as Array<{ props: Record<string, unknown> }>;
    expect(steps[2].props.run).toBe("go test -short ./...");
  });

  test("lintJob uses golangci-lint-action", () => {
    const result = GoCI({});
    const steps = result.lintJob!.props.steps as Array<{ props: Record<string, unknown> }>;
    expect(steps[2].props.uses).toBe("golangci/golangci-lint-action@v6");
  });

  test("uses custom runsOn", () => {
    const result = GoCI({ runsOn: "macos-latest" });
    expect(result.buildJob.props["runs-on"]).toBe("macos-latest");
    expect(result.testJob.props["runs-on"]).toBe("macos-latest");
  });
});

// ── Defaults overrides ─────────────────────────────────────────────

describe("defaults overrides", () => {
  test("Checkout defaults override step props", () => {
    const result = Checkout({
      ref: "main",
      defaults: { step: { id: "my-checkout" } },
    });
    expect(result.step.props.id).toBe("my-checkout");
    expect(result.step.props.uses).toBe("actions/checkout@v4");
  });

  test("SetupNode defaults override step props", () => {
    const result = SetupNode({
      nodeVersion: "20",
      defaults: { step: { id: "setup" } },
    });
    expect(result.step.props.id).toBe("setup");
    expect(result.step.props.name).toBe("Setup Node.js");
  });

  test("NodeCI defaults override job and workflow props", () => {
    const result = NodeCI({
      defaults: {
        job: { "timeout-minutes": 30 } as any,
        workflow: { concurrency: "ci-${{ github.ref }}" } as any,
      },
    });
    expect(result.job.props["timeout-minutes"]).toBe(30);
    expect(result.workflow.props.concurrency).toBe("ci-${{ github.ref }}");
  });

  test("NodePipeline defaults override individual jobs", () => {
    const result = NodePipeline({
      defaults: {
        buildJob: { "timeout-minutes": 15 } as any,
        testJob: { "timeout-minutes": 20 } as any,
      },
    });
    expect(result.buildJob.props["timeout-minutes"]).toBe(15);
    expect(result.testJob.props["timeout-minutes"]).toBe(20);
  });

  test("DockerBuild defaults override job and workflow", () => {
    const result = DockerBuild({
      defaults: {
        job: { "timeout-minutes": 60 } as any,
        workflow: { concurrency: "docker" } as any,
      },
    });
    expect(result.job.props["timeout-minutes"]).toBe(60);
    expect(result.workflow.props.concurrency).toBe("docker");
  });

  test("DeployEnvironment defaults override deploy and cleanup jobs", () => {
    const result = DeployEnvironment({
      name: "staging",
      deployScript: "npm run deploy",
      defaults: {
        deployJob: { "timeout-minutes": 30 } as any,
        cleanupJob: { "timeout-minutes": 10 } as any,
      },
    });
    expect(result.deployJob.props["timeout-minutes"]).toBe(30);
    expect(result.cleanupJob.props["timeout-minutes"]).toBe(10);
  });

  test("GoCI defaults override workflow name", () => {
    const result = GoCI({
      defaults: {
        workflow: { name: "Custom Go CI" } as any,
      },
    });
    expect(result.workflow.props.name).toBe("Custom Go CI");
  });

  test("PythonCI defaults override testJob", () => {
    const result = PythonCI({
      defaults: {
        testJob: { "timeout-minutes": 45 } as any,
      },
    });
    expect(result.testJob.props["timeout-minutes"]).toBe(45);
  });

  test("UploadArtifact defaults override step props", () => {
    const result = UploadArtifact({
      name: "build",
      path: "dist/",
      defaults: { step: { id: "upload" } },
    });
    expect(result.step.props.id).toBe("upload");
    expect(result.step.props.uses).toBe("actions/upload-artifact@v4");
  });

  test("CacheAction defaults override step props", () => {
    const result = CacheAction({
      path: "node_modules",
      key: "cache-key",
      defaults: { step: { id: "cache-step" } },
    });
    expect(result.step.props.id).toBe("cache-step");
    expect(result.step.props.uses).toBe("actions/cache@v4");
  });
});
