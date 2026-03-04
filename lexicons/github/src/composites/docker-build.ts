import { Composite } from "@intentius/chant";

export interface DockerBuildProps {
  /** Image tag. Default: "${{ github.sha }}" */
  tag?: string;
  /** Dockerfile path. Default: "Dockerfile" */
  dockerfile?: string;
  /** Build context. Default: "." */
  context?: string;
  /** Container registry. Default: "ghcr.io" */
  registry?: string;
  /** Full image name. Default: "ghcr.io/${{ github.repository }}" */
  imageName?: string;
  /** Also tag as :latest. Default: true */
  tagLatest?: boolean;
  /** Extra docker build-args */
  buildArgs?: Record<string, string>;
  /** Push image after build. Default: true */
  push?: boolean;
  /** Multi-platform targets. e.g. ["linux/amd64", "linux/arm64"] */
  platforms?: string[];
  /** Runner label. Default: "ubuntu-latest" */
  runsOn?: string;
}

export const DockerBuild = Composite<DockerBuildProps>((props) => {
  const {
    tag = "${{ github.sha }}",
    dockerfile = "Dockerfile",
    context = ".",
    registry = "ghcr.io",
    imageName = "ghcr.io/${{ github.repository }}",
    tagLatest = true,
    buildArgs,
    push = true,
    platforms,
    runsOn = "ubuntu-latest",
  } = props;

  const { createProperty, createResource } = require("@intentius/chant/runtime");
  const StepClass = createProperty("GitHub::Actions::Step", "github");
  const JobClass = createResource("GitHub::Actions::Job", "github", {});
  const WorkflowClass = createResource("GitHub::Actions::Workflow", "github", {});

  // ── Steps ──────────────────────────────────────────────────────────
  const checkout = new StepClass({ name: "Checkout", uses: "actions/checkout@v4" });

  const login = new StepClass({
    name: "Log in to container registry",
    uses: "docker/login-action@v3",
    with: {
      registry,
      username: "${{ github.actor }}",
      password: "${{ secrets.GITHUB_TOKEN }}",
    },
  });

  const setupBuildx = new StepClass({
    name: "Set up Docker Buildx",
    uses: "docker/setup-buildx-action@v3",
  });

  // Build tags for metadata action
  const tags = [`${imageName}:${tag}`];
  if (tagLatest) {
    tags.push(`${imageName}:latest`);
  }

  const metadata = new StepClass({
    name: "Extract metadata",
    id: "meta",
    uses: "docker/metadata-action@v5",
    with: {
      images: imageName,
      tags: tags.join("\n"),
    },
  });

  const buildPushWith: Record<string, string> = {
    context,
    file: dockerfile,
    push: String(push),
    tags: "${{ steps.meta.outputs.tags }}",
    labels: "${{ steps.meta.outputs.labels }}",
  };

  if (platforms && platforms.length > 0) {
    buildPushWith.platforms = platforms.join(",");
  }

  if (buildArgs) {
    buildPushWith["build-args"] = Object.entries(buildArgs)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
  }

  const buildPush = new StepClass({
    name: "Build and push",
    uses: "docker/build-push-action@v6",
    with: buildPushWith,
  });

  const job = new JobClass({
    "runs-on": runsOn,
    steps: [checkout, login, setupBuildx, metadata, buildPush],
  });

  const workflow = new WorkflowClass({
    name: "Docker Build",
    on: {
      push: { branches: ["main"] },
    },
    permissions: {
      contents: "read",
      packages: "write",
    },
  });

  return { workflow, job };
}, "DockerBuild");
