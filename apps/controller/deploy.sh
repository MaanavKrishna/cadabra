#!/usr/bin/env bash
# Build the phone controller and publish it to the CloudFront-fronted S3 bucket.
# Override with CONTROLLER_BUCKET / CONTROLLER_DISTRIBUTION_ID / AWS_PROFILE if the stack changes.
set -euo pipefail
cd "$(dirname "$0")"

BUCKET="${CONTROLLER_BUCKET:-cadabrabackend-controllersitef1af73ca-wnesr2lnfrin}"
DIST_ID="${CONTROLLER_DISTRIBUTION_ID:-EXI4XM3KB8DEJ}"
REGION="${AWS_REGION:-ap-south-1}"

npx vite build

# Hashed assets: cache for a year. index.html: always revalidate so new deploys show up at once.
aws s3 sync dist "s3://$BUCKET" --delete --region "$REGION" \
  --exclude index.html --cache-control "public,max-age=31536000,immutable"
aws s3 cp dist/index.html "s3://$BUCKET/index.html" --region "$REGION" \
  --cache-control "no-cache" --content-type "text/html; charset=utf-8"

aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths '/*' \
  --query 'Invalidation.{Id:Id,Status:Status}' --output text
echo "Deployed: https://d3g2ct6wjlkyzv.cloudfront.net"
