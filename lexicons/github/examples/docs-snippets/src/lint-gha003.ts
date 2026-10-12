import { Job, Step, secrets } from "@intentius/chant-lexicon-github";

// BAD — hardcoded token triggers GHA003
export const badDeploy = new Job({
  "runs-on": "ubuntu-latest",
  steps: [
    new Step({
      name: "Deploy",
      // chant-disable-next-line GHA003
      run: "curl -H 'Authorization: token ghp_abc123def456' https://api.github.com/repos",
    }),
  ],
});

// GOOD — use secrets() expression
export const goodDeploy = new Job({
  "runs-on": "ubuntu-latest",
  steps: [
    new Step({
      name: "Deploy",
      env: { GH_TOKEN: secrets("GITHUB_TOKEN") },
      run: "curl -H \"Authorization: token $GH_TOKEN\" https://api.github.com/repos",
    }),
  ],
});
