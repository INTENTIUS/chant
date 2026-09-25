import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-systemone";

/**
 * One backend, named the way the workspace's points name it in their model
 * deciders (`"backend": "systemone"`). The key is the name of an environment
 * variable; SYS001 fails a key written here as a string.
 */
export default {
  lexicons: ["systemone"],
  systemone: {
    backends: {
      systemone: { url: "https://api.typesafe.ai", key: { env: "TYPESAFE_API_KEY" } },
    },
  },
} satisfies ChantConfig;
