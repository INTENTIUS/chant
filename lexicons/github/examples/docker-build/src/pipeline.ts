import {
  Workflow, Job, Step,
  Checkout,
  github,
} from "@intentius/chant-lexicon-github";

export const workflow = new Workflow({
  name: "Docker Build and Push",
  on: {
    push: { branches: ["main"], tags: ["v*"] },
  },
  permissions: {
    contents: "read",
    packages: "write",
  },
});

export const build = new Job({
  "runs-on": "ubuntu-latest",
  timeoutMinutes: 30,
  steps: [
    Checkout({}).step,

    new Step({
      name: "Set up QEMU",
      uses: "docker/setup-qemu-action@v3",
    }),

    new Step({
      name: "Set up Docker Buildx",
      uses: "docker/setup-buildx-action@v3",
    }),

    new Step({
      name: "Log in to GitHub Container Registry",
      uses: "docker/login-action@v3",
      with: {
        registry: "ghcr.io",
        username: github.actor.toString(),
        password: "${{ secrets.GITHUB_TOKEN }}",
      },
    }),

    new Step({
      name: "Extract metadata",
      id: "meta",
      uses: "docker/metadata-action@v5",
      with: {
        images: `ghcr.io/${github.repository}`,
        tags: [
          "type=sha",
          "type=ref,event=branch",
          "type=semver,pattern={{version}}",
          "type=semver,pattern={{major}}.{{minor}}",
        ].join("\n"),
      },
    }),

    new Step({
      name: "Build and push",
      uses: "docker/build-push-action@v6",
      with: {
        context: ".",
        file: "Dockerfile",
        push: "true",
        platforms: "linux/amd64,linux/arm64",
        tags: "${{ steps.meta.outputs.tags }}",
        labels: "${{ steps.meta.outputs.labels }}",
        "cache-from": "type=gha",
        "cache-to": "type=gha,mode=max",
      },
    }),
  ],
});
