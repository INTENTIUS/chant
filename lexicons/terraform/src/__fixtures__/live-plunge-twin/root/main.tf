# The estate lexicons/pulumi/src/testdata/plunge-graph/ holds as a plunge
# stack, declared as a choudoufu live root (chant #5333): two buckets this
# estate's markers bind, and a bucket policy not created yet. The
# live-plan.json and live-graph.json beside this directory are hand-written
# to what choudoufu prints for it; nothing ran.
#
# The policy names its bucket by a literal, so no block reads another and
# live-graph prints no edges.

resource "aws_s3_bucket" "assets" {
  bucket = "assets-4f1c2e9"
}

resource "aws_s3_bucket" "media" {
  bucket = "media-9a0b"
}

resource "aws_s3_bucket_policy" "assets_policy" {
  bucket = "assets-4f1c2e9"
  policy = "{}"
}
