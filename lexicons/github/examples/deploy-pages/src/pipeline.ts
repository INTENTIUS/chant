import {
  Workflow, Job, Step,
  Checkout, SetupNode,
} from "@intentius/chant-lexicon-github";

export const workflow = new Workflow({
  name: "Deploy to GitHub Pages",
  on: {
    push: { branches: ["main"] },
  },
  permissions: {
    contents: "read",
    pages: "write",
    "id-token": "write",
  },
  concurrency: {
    group: "pages",
    "cancel-in-progress": true,
  },
});

export const build = new Job({
  "runs-on": "ubuntu-latest",
  timeoutMinutes: 10,
  steps: [
    Checkout({}).step,
    SetupNode({ nodeVersion: "22", cache: "npm" }).step,
    new Step({ name: "Install", run: "npm ci" }),
    new Step({ name: "Build", run: "npm run build" }),
    new Step({
      name: "Configure Pages",
      uses: "actions/configure-pages@v5",
    }),
    new Step({
      name: "Upload artifact",
      uses: "actions/upload-pages-artifact@v3",
      with: { path: "./dist" },
    }),
  ],
});

export const deploy = new Job({
  "runs-on": "ubuntu-latest",
  needs: ["build"],
  environment: {
    name: "github-pages",
    url: "${{ steps.deployment.outputs.page_url }}",
  },
  steps: [
    new Step({
      name: "Deploy to GitHub Pages",
      id: "deployment",
      uses: "actions/deploy-pages@v4",
    }),
  ],
});
