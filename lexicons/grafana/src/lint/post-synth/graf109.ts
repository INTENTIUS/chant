/**
 * GRAF109: Dashboard provisioning puts a dashboard somewhere other than its declared folder, or loads it twice
 *
 * Read from the dashboard provisioning file and where each dashboard file sits under dashboards/. Two providers in one org whose paths are the same or nested load every dashboard twice, and Grafana then takes database writes away from both: an error. A provider that sets folder and folderUid with foldersFromFilesStructure is refused by Grafana: an error; with one of them, that folder is ignored: a warning. Dashboards that declare a folder when no provider sets foldersFromFilesStructure all land in the provider's folder: a warning. A nested folder ("Platform/Kubernetes") is a warning: Grafana 13.1 and later nest the folders, 12.4 and 13.0 use only the last level; past Grafana's default depth of 4 it says so, and past its hard limit of 7 it is an error.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { grafanaDiagnostics } from "./grafana-helpers";

export const graf109: PostSynthCheck = {
  id: "GRAF109",
  description: "Dashboard provisioning puts a dashboard somewhere other than its declared folder, or loads it twice",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return grafanaDiagnostics(ctx, "GRAF109");
  },
};
