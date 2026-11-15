output "project_id" {
  description = "The project_id of the project that was created"
  value       = google_project.project.project_id
}

output "project_number" {
  description = "Numeric identifier for the project"
  value       = google_project.project.number
}
