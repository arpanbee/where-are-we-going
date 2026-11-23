#!/usr/bin/env bash
# Upload web/ to the site bucket and invalidate CloudFront.
# Reads bucket and distribution from Terraform outputs in infra/.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
bucket="$(terraform -chdir="$root/infra" output -raw site_bucket)"
dist="$(terraform -chdir="$root/infra" output -raw distribution_id)"

# Filenames aren't content-hashed yet, so keep caches short:
# HTML is revalidated every time; CSS/JS for 5 minutes.
aws s3 sync "$root/web" "s3://$bucket" --delete --exclude "*" --include "*.html" \
  --cache-control "no-cache" --content-type "text/html; charset=utf-8"
aws s3 sync "$root/web" "s3://$bucket" --delete --exclude "*.html" \
  --cache-control "public, max-age=300"

aws cloudfront create-invalidation --distribution-id "$dist" --paths "/*" \
  --query 'Invalidation.Id' --output text
echo "Deployed: $(terraform -chdir="$root/infra" output -raw site_url)"
