module "cdn" {
  source     = "./modules/cdn"
  bucket     = aws_s3_bucket.assets.bucket
  depends_on = [aws_s3_bucket.assets]
}
