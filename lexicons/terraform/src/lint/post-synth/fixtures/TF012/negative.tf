output "bucket_name" {
  description = "Name of the bucket the site is served from"
  value       = aws_s3_bucket.assets.bucket
}
