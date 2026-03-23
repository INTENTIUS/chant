import { Service } from "@intentius/chant-lexicon-docker";
import { SOLR_IMAGE, COLLECTION } from "./config";

export const solr = new Service({
  image: SOLR_IMAGE,
  ports: ["8983:8983"],
  networks: ["solrNet"],
  volumes: ["solrData:/var/solr"],
  environment: { SOLR_HEAP: "512m" },
  // solr-precreate creates the "lucene" core at startup (standalone mode)
  command: ["solr-precreate", COLLECTION],
  restart: "unless-stopped",
  healthcheck: {
    test: ["CMD", "curl", "-sf", `http://localhost:8983/solr/${COLLECTION}/select?q=*:*`],
    interval: "10s",
    timeout: "5s",
    retries: 10,
  },
});
