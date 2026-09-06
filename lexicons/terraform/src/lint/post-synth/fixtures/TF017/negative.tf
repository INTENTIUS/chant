module "cdn" {
  source = "./modules/cdn"
  bucket = aws_s3_bucket.assets.bucket
}
