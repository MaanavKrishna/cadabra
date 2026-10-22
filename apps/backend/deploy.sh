#!/usr/bin/env bash
# Bootstraps (if needed) and deploys the Cadabra backend. Safe to rerun.
set -euo pipefail
cd "$(dirname "$0")"
ACCOUNT=380794909728
REGION=ap-south-1
aws sts get-caller-identity >/dev/null || { echo "AWS session invalid: run 'aws login'" >&2; exit 1; }
if ! aws cloudformation describe-stacks --stack-name CDKToolkit --region "$REGION" >/dev/null 2>&1; then
  npx cdk bootstrap "aws://$ACCOUNT/$REGION"
fi
# Reserved concurrency (20) can fail on low-quota accounts; retry without it.
npx cdk deploy --require-approval never --outputs-file outputs.json || {
  echo "deploy failed; retrying without Lambda reserved concurrency" >&2
  npx cdk deploy --require-approval never --outputs-file outputs.json -c reservedConcurrency=0
}
cat outputs.json
