import { output } from "@intentius/chant-lexicon-aws";
import { solr } from "./solr";

// SolrUrl = http://{AlbDnsName}/solr — construct from the AlbDnsName infra output at deploy time
export const serviceName = output(solr.service.Name, "ServiceName");
export const serviceArn = output(solr.service.ServiceArn, "ServiceArn");
