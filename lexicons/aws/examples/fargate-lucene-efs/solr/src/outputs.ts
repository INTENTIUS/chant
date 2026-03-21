import { output, Sub, Ref } from "@intentius/chant-lexicon-aws";
import { solr } from "./solr";
import { albDnsName } from "./params";

export const serviceName = output(solr.service.Name, "ServiceName");
export const serviceArn = output(solr.service.ServiceArn, "ServiceArn");
export const solrUrl = output(Sub`http://${Ref(albDnsName)}/solr`, "solrUrl");
