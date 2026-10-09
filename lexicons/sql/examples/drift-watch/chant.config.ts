import type { ChantConfig } from "@intentius/chant";
import "@intentius/chant-lexicon-sql";

// The watch reads the server as a user that can only read: the scheduled job
// holds that user's password and nothing that can write (#3642).
export default {
  lexicons: ["sql"],
  ownership: { stack: "shop", env: "prod" },
  sql: {
    dialect: "clickhouse",
    profiles: {
      prod: {
        url: "https://clickhouse.example.com:8443",
        user: { env: "CLICKHOUSE_READER_USER" },
        password: { env: "CLICKHOUSE_READER_PASSWORD" },
        databases: ["shop"],
      },
    },
  },
} satisfies ChantConfig;
