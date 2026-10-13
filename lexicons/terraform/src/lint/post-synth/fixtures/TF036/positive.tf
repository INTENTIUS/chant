# Vendored for TF036 (chant #2288) from https://github.com/stelligent/config-lint
# Path: example-files/config/volumes.tf
# Commit: 8e87d18df9df2413a3bf3f57a3ceaf17a2140da9
# Licence: MIT, https://github.com/stelligent/config-lint/blob/8e87d18df9df2413a3bf3f57a3ceaf17a2140da9/LICENSE.md
# Excerpt: lines 9-16, unmodified.
#
# config-lint's own example files.
#
# TF036: one warning. encrypted = false.
#
# Copyright (c) 2018-2020 Stelligent
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

resource "aws_ebs_volume" "vol2" {
    availability_zone = "us-west-2a"
    size = 40
    tags {
        Name = "HelloWorld"
    }
    encrypted = false
}
