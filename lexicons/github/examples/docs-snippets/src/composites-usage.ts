import {
  Job,
  Step,
  Checkout,
  SetupNode,
  SetupGo,
  CacheAction,
  UploadArtifact,
  DownloadArtifact,
  NodePipeline,
  PythonCI,
  DockerBuild,
  DeployEnvironment,
  GoCI,
  BunPipeline,
} from "@intentius/chant-lexicon-github";

// Checkout — wraps actions/checkout
const checkout = Checkout({ fetchDepth: 0 });

// SetupNode — wraps actions/setup-node with optional caching
const setupNode = SetupNode({ nodeVersion: "22", cache: "npm" });

// SetupGo — wraps actions/setup-go
const setupGo = SetupGo({ goVersion: "1.22" });

// CacheAction — wraps actions/cache for custom cache keys
const cache = CacheAction({
  path: "~/.cache/my-tool",
  key: "my-tool-cache-${{ runner.os }}",
});

// UploadArtifact — wraps actions/upload-artifact
const upload = UploadArtifact({
  name: "build-output",
  path: "dist/",
});

// DownloadArtifact — wraps actions/download-artifact
const download = DownloadArtifact({
  name: "build-output",
  path: "dist/",
});

// Combine composites in a job
export const build = new Job({
  "runs-on": "ubuntu-latest",
  steps: [
    checkout.step,
    setupNode.step,
    new Step({ name: "Build", run: "npm ci && npm run build" }),
    upload.step,
  ],
});

// ── Multi-job pipelines ──────────────────────────────────────────────

// NodePipeline — build + test with artifact passing
const node = NodePipeline({ nodeVersion: "22", packageManager: "pnpm" });
export const nodeWorkflow = node.workflow;
export const nodeBuild = node.buildJob;
export const nodeTest = node.testJob;

// BunPipeline preset — NodePipeline with bun defaults
const bun = BunPipeline({});
export const bunWorkflow = bun.workflow;

// PythonCI — test + optional lint
const python = PythonCI({ pythonVersion: "3.12" });
export const pythonWorkflow = python.workflow;

// DockerBuild — build + push with official Docker actions
const docker = DockerBuild({ imageName: "ghcr.io/my-org/my-app" });
export const dockerWorkflow = docker.workflow;

// DeployEnvironment — deploy + cleanup job pair
const deploy = DeployEnvironment({
  name: "staging",
  deployScript: "npm run deploy",
});
export const deployJob = deploy.deployJob;

// GoCI — build + test + optional lint
const go = GoCI({ goVersion: "1.22" });
export const goWorkflow = go.workflow;
