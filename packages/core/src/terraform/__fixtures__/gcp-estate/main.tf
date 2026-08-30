# A small google-provider estate for the carve-out advisor (#2017), mixed the
# same way the AWS sample estate is: clean leaves, a hub with boundary work, a
# tier-3 map, and one resource with no native mapping at all.

# Clean leaf: a bucket nothing else reads.
resource "google_storage_bucket" "assets" {
  name     = "myapp-assets-prod"
  location = "US"
}

# Clean leaf with one inbound edge: the subscription reads the topic.
resource "google_pubsub_topic" "events" {
  name = "myapp-events"
}

resource "google_pubsub_subscription" "worker" {
  name  = "myapp-worker"
  topic = google_pubsub_topic.events.name
}

# The hub: two subnets, a router and the cluster all reference the network, so
# carving it costs four data-source patches to the surviving Terraform.
resource "google_compute_network" "main" {
  name                    = "myapp-vpc"
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "a" {
  name          = "myapp-subnet-a"
  ip_cidr_range = "10.0.1.0/24"
  network       = google_compute_network.main.id
}

resource "google_compute_subnetwork" "b" {
  name          = "myapp-subnet-b"
  ip_cidr_range = "10.0.2.0/24"
  network       = google_compute_network.main.id
}

resource "google_compute_router" "nat" {
  name    = "myapp-router"
  network = google_compute_network.main.id
}

# Tier 3: Config Connector inlines node pools the cluster also declares apart.
resource "google_container_cluster" "primary" {
  name       = "myapp-gke"
  network    = google_compute_network.main.id
  subnetwork = google_compute_subnetwork.a.id
}

# Identity lives in account_id here, not name.
resource "google_service_account" "runner" {
  account_id = "myapp-runner"
}

# Leave in Terraform: no native mapping, scored 0.
resource "random_pet" "suffix" {
  length = 2
}
