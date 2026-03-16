import {
  Expression,
  github,
  runner,
  secrets,
  steps,
  always,
  failure,
  contains,
  startsWith,
  branch,
  tag,
} from "@intentius/chant-lexicon-github";

// Combine expressions with logical operators
const isMainBranch = github.ref.eq("refs/heads/main");
const isPR = github.eventName.eq("pull_request");
const mainOrPR = isMainBranch.or(isPR);

// Condition helpers for job/step `if:` fields
const alwaysRun = always(); // ${{ always() }}
const onFailure = failure(); // ${{ failure() }}

// Function helpers
const hasLabel = contains(github.event, "bug");
const isRelease = startsWith(github.ref, "refs/tags/v");

// Convenience helpers
const onMain = branch("main"); // github.ref == 'refs/heads/main'
const onV1Tag = tag("v1"); // startsWith(github.ref, 'refs/tags/v1')

// Access secrets, step outputs, and runner context
const token = secrets("NPM_TOKEN");
const buildOutput = steps("build").outputs("artifact-path");
const osType = runner.os; // ${{ runner.os }}
