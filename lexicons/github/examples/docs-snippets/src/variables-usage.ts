import { Job, Step, GitHub, Runner } from "@intentius/chant-lexicon-github";

// Use GitHub context variables in steps
export const deploy = new Job({
  "runs-on": "ubuntu-latest",
  steps: [
    new Step({
      name: "Print context",
      run: `echo "Branch: ${GitHub.RefName}"
echo "SHA: ${GitHub.Sha}"
echo "Actor: ${GitHub.Actor}"
echo "Repo: ${GitHub.Repository}"
echo "Runner OS: ${Runner.Os}"`,
    }),
  ],
});
