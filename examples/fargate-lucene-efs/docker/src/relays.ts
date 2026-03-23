import { Service, Dockerfile } from "@intentius/chant-lexicon-docker";
import { RELAY_BASE, COLLECTION } from "./config";

export const dynamoRelayDockerfile = new Dockerfile({
  stages: [
    {
      from: RELAY_BASE,
      workdir: "/app",
      run: ["bun add @aws-sdk/client-dynamodb@^3 @aws-sdk/client-dynamodb-streams@^3"],
      copy: ["relay-dynamo.ts ."],
      cmd: `["bun", "relay-dynamo.ts"]`,
    },
  ],
});

export const dynamoRelay = new Service({
  image: "dynamo-relay:local",
  build: { context: "..", dockerfile: "dist/Dockerfile.dynamoRelayDockerfile" },
  networks: ["solrNet"],
  depends_on: ["dynamo", "solr"],
  environment: {
    DYNAMO_ENDPOINT: "http://dynamo:8000",
    DYNAMO_TABLE:    "products",
    SOLR_URL:        "http://solr:8983/solr",
    COLLECTION,
  },
  restart: "unless-stopped",
});

export const minioRelayDockerfile = new Dockerfile({
  stages: [
    {
      from: RELAY_BASE,
      workdir: "/app",
      run: ["bun add @aws-sdk/client-s3@^3"],
      copy: ["relay-minio.ts ."],
      cmd: `["bun", "relay-minio.ts"]`,
    },
  ],
});

export const minioRelay = new Service({
  image: "minio-relay:local",
  build: { context: "..", dockerfile: "dist/Dockerfile.minioRelayDockerfile" },
  networks: ["solrNet"],
  depends_on: ["minio", "solr"],
  environment: {
    MINIO_ENDPOINT:   "http://minio:9000",
    MINIO_ACCESS_KEY: "minioadmin",
    MINIO_SECRET_KEY: "minioadmin",
    MINIO_BUCKET:     "documents",
    MINIO_PREFIX:     "data/",
    SOLR_URL:         "http://solr:8983/solr",
    COLLECTION,
  },
  restart: "unless-stopped",
});
