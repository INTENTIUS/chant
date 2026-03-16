import { ConfigConnectorContext } from "@intentius/chant-lexicon-k8s";
import { shared } from "../config";

export const { context } = ConfigConnectorContext({
  googleServiceAccountEmail: `config-connector@${shared.projectId}.iam.gserviceaccount.com`,
  namespace: "default",
  defaults: {
    context: {
      metadata: {
        labels: { "app.kubernetes.io/part-of": "bootstrap" },
      },
    },
  },
});
