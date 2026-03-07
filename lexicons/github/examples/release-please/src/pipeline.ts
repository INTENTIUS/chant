import {
  Workflow, Job, Step,
  Checkout, SetupNode,
} from "@intentius/chant-lexicon-github";

export const workflow = new Workflow({
  name: "Release Please",
  on: {
    push: { branches: ["main"] },
  },
  permissions: {
    contents: "write",
    "pull-requests": "write",
  },
});

export const release = new Job({
  "runs-on": "ubuntu-latest",
  timeoutMinutes: 10,
  outputs: {
    "releases_created": "${{ steps.release.outputs.releases_created }}",
    "tag_name": "${{ steps.release.outputs.tag_name }}",
  },
  steps: [
    new Step({
      name: "Create release",
      id: "release",
      uses: "googleapis/release-please-action@v4",
      with: {
        "release-type": "node",
      },
    }),
  ],
});

export const publish = new Job({
  "runs-on": "ubuntu-latest",
  needs: ["release"],
  if: "${{ needs.release.outputs.releases_created == 'true' }}",
  timeoutMinutes: 10,
  steps: [
    Checkout({}).step,
    SetupNode({
      nodeVersion: "22",
      cache: "npm",
    }).step,
    new Step({ name: "Install", run: "npm ci" }),
    new Step({ name: "Build", run: "npm run build" }),
    new Step({
      name: "Publish to npm",
      run: "npm publish --access public",
      env: {
        NODE_AUTH_TOKEN: "${{ secrets.NPM_TOKEN }}",
      },
    }),
  ],
});
