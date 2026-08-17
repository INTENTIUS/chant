/**
 * The half of the deploy that waits on a person.
 * `chant run crdb-publish-ui --temporal`.
 *
 * Each region's UI hangs off a subdomain of your base domain, served by a GCE
 * Ingress with a Google-managed certificate. Google will not issue that
 * certificate until the subdomain resolves, and it cannot resolve until you
 * delegate it at your registrar — three NS records, copied from the three
 * public zones the deploy created. Nobody can automate that from inside GCP.
 *
 * The old deploy script printed a reminder in an ASCII box and carried on. The
 * consequence was silent: the deploy "succeeded", the managed certificates sat
 * in PROVISIONING, and the UIs returned 502 until somebody remembered.
 *
 * A gate is what that reminder wanted to be. It holds — durably, for up to
 * three days, surviving a worker restart — and when you send the signal it
 * verifies all three UIs actually answer.
 *
 *   chant run crdb-publish-ui --temporal
 *   # ... delegate the subdomains at your registrar ...
 *   chant run signal crdb-publish-ui gate-dns-delegation
 *
 * This Op needs Temporal. A gate anywhere in an Op makes the whole Op refuse
 * to run on the local executor, which is why it is not a phase of
 * `crdb-deploy`: the database does not depend on any of this, and requiring a
 * Temporal server to bring up a cluster would be the tail wagging the dog.
 */

import { Op, phase, gate, shell, httpCheck } from "@intentius/chant-lexicon-temporal";

const REGIONS = ["east", "central", "west"] as const;

/**
 * Read from the environment, not from a build parameter: an Op is operational
 * code, and nothing here is synthesized. `set -a && source .env && set +a`.
 *
 * The placeholder default is kept so the Op still COMPILES with nothing set —
 * `chant build` validates every Op's shape, and the repo's test suite reads
 * this file — but a run against `crdb.example.com` would verify somebody
 * else's domain and pass or fail for reasons that have nothing to do with
 * this estate. The Preflight phase below refuses that. Note this Op reads the
 * env var and not the `domain` build parameter, so a build parameterized with
 * `--param domain=…` alone is exactly the mismatch Preflight catches.
 */
const PLACEHOLDER_DOMAIN = "crdb.example.com";
const DOMAIN = process.env.CRDB_DOMAIN ?? PLACEHOLDER_DOMAIN;

export default Op({
  name: "crdb-publish-ui",
  overview: "Hold for DNS delegation, then verify the three regional UIs answer",
  taskQueue: "crdb",
  depends: ["crdb-deploy"],
  searchAttributes: { Estate: "crdb-multi-region" },

  phases: [
    phase("Preflight", [
      shell(
        '[ -n "${CRDB_DOMAIN:-}" ] || ' +
          '{ echo "CRDB_DOMAIN is not set. This Op verifies https://<region>.$CRDB_DOMAIN/health, ' +
          'and would otherwise check ' + PLACEHOLDER_DOMAIN + ' — somebody else\'s domain. ' +
          'set -a && source .env && set +a"; exit 1; }',
      ),
      shell(
        '[ "${CRDB_DOMAIN}" != "' + PLACEHOLDER_DOMAIN + '" ] || ' +
          '{ echo "CRDB_DOMAIN is still the placeholder (' + PLACEHOLDER_DOMAIN + ') — ' +
          'put your own domain in .env"; exit 1; }',
      ),
      shell('[ -n "${GCP_PROJECT_ID:-}" ] || { echo "GCP_PROJECT_ID is not set"; exit 1; }'),
    ]),

    // The nameservers to copy to your registrar.
    phase("Nameservers", [
      shell(
        "for z in gke-crdb-east-zone gke-crdb-central-zone gke-crdb-west-zone; do " +
          'echo "== $z"; gcloud dns managed-zones describe "$z" ' +
          "--project \"$GCP_PROJECT_ID\" --format='value(nameServers)'; done",
      ),
    ]),

    phase("Await delegation", [
      gate("gate-dns-delegation", {
        timeout: "72h",
        description:
          "Delegate east/central/west subdomains at the registrar using the nameservers above, " +
          "then signal. Google-managed certificates cannot be issued until the names resolve.",
      }),
    ]),

    // Certificate issuance is minutes-to-an-hour after delegation propagates.
    phase("Certificates", [
      shell(
        REGIONS.map(
          (r) =>
            `kubectl --context ${r} -n crdb-${r} wait managedcertificate/cockroachdb-ui-cert ` +
            `--for=jsonpath='{.status.certificateStatus}'=Active --timeout=45m`,
        ).join(" && "),
        { profile: "k8sWait" },
      ),
    ]),

    // The actual proof: each UI answers over HTTPS on its own subdomain.
    phase(
      "Verify",
      REGIONS.map((r) => httpCheck(`https://${r}.${DOMAIN}/health`, { status: 200, retries: 10 })),
      { parallel: true },
    ),
  ],
});
