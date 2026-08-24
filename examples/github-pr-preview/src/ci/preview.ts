// The preview workflow, declared in chant and emitted by `chant build`
// (`npm run build:ci` writes .github/workflows/preview.yml). One workflow,
// two jobs, gated on the PR action:
//
//   - `deploy` (below) runs on open/synchronize/reopen: build with the PR's
//     env name, apply through the local Op executor, post one sticky comment.
//   - `teardown` (teardown.ts) runs on close.
//
// CHANT_ENV is exported once at workflow level, so the same `pr-<n>` value
// feeds the env build parameter in every chant invocation of both jobs (see
// chant.config.ts).
//
// The sticky comment is a scripted `gh api` step keyed on a hidden marker
// string — find the marker, PATCH that comment if it exists, POST otherwise.
// No marketplace action, nothing extra to pin or audit; `gh` ships on
// GitHub's hosted runners. Untrusted PR fields (title, branch name, body)
// never appear here — the only event fields used are the PR number and head
// SHA, both shell-safe by construction and passed through env vars anyway.

import { Workflow, Job, Step, Concurrency, Environment, Permissions } from "@intentius/chant-lexicon-github";
import { checkout, setupNode, install, clusterAccess } from "./setup";

/** The hidden marker that makes the PR comment findable across pushes. */
const COMMENT_MARKER = "<!-- chant-pr-preview -->";

const onPullRequest = {
  pull_request: { types: ["opened", "synchronize", "reopened", "closed"] },
};

export const preview = new Workflow({
  name: "pr-preview",
  on: onPullRequest,
  permissions: new Permissions({ contents: "read" }),
  // One run at a time per PR; never cancel in-flight runs — a close event
  // racing a deploy could otherwise leave a half-applied environment behind.
  concurrency: new Concurrency({
    group: "pr-preview-${{ github.event.number }}",
    "cancel-in-progress": false,
  }),
  env: { CHANT_ENV: "pr-${{ github.event.number }}" },
});

const stickyCommentScript =
  'body="$MARKER\n' +
  "**Preview environment \\`$CHANT_ENV\\` is live.**\n" +
  "\n" +
  "| | |\n" +
  "|---|---|\n" +
  "| Namespace | \\`preview-$CHANT_ENV\\` |\n" +
  "| Service | \\`web-$CHANT_ENV\\` |\n" +
  "| Peek | \\`kubectl -n preview-$CHANT_ENV port-forward svc/web-$CHANT_ENV 8080:8080\\` |\n" +
  "\n" +
  '_Updated for $HEAD_SHA. Torn down when the PR closes._"\n' +
  'comment_id=$(gh api "repos/$REPO/issues/$PR_NUMBER/comments" --paginate ' +
  '--jq "map(select(.body | startswith(\\"$MARKER\\"))) | .[0].id // empty")\n' +
  'if [ -n "$comment_id" ]; then\n' +
  '  gh api -X PATCH "repos/$REPO/issues/comments/$comment_id" -f body="$body" > /dev/null\n' +
  "else\n" +
  '  gh api -X POST "repos/$REPO/issues/$PR_NUMBER/comments" -f body="$body" > /dev/null\n' +
  "fi";

export const deploy = new Job({
  "runs-on": "ubuntu-latest",
  if: "github.event.action != 'closed'",
  "timeout-minutes": 15,
  permissions: new Permissions({ contents: "read", "pull-requests": "write" }),
  // A named environment puts PREVIEW_KUBECONFIG behind GitHub's environment
  // protection rules (reviewers, wait timers) instead of repo-wide secrets.
  environment: new Environment({ name: "preview" }),
  steps: [
    checkout,
    setupNode,
    install,
    clusterAccess,
    // ApplyOp on the local executor: build → plan (live diff) → apply.
    // CHANT_ENV supplies params.env, so the build names everything pr-<n>
    // and stamps the matching ownership marker (ownership.env follows the
    // parameter).
    new Step({ name: "Deploy preview environment", run: "npx chant run preview-apply" }),
    new Step({
      name: "Sticky PR comment",
      env: {
        GH_TOKEN: "${{ secrets.GITHUB_TOKEN }}",
        PR_NUMBER: "${{ github.event.number }}",
        HEAD_SHA: "${{ github.event.pull_request.head.sha }}",
        REPO: "${{ github.repository }}",
        MARKER: COMMENT_MARKER,
      },
      run: stickyCommentScript,
    }),
  ],
});
