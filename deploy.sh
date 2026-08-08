#!/bin/bash
# Deploy English Trivia to Cloudflare Workers
# Secrets are NOT stored in this repo. Pass them via environment:
#   CF_API_TOKEN          (Cloudflare API token, Workers Scripts edit)
#   DISCORD_CLIENT_ID     (Discord application client ID — public, but keep env-driven)
#   DISCORD_CLIENT_SECRET (Discord app secret)
#   OPENCODE_API_KEY      (opencode.ai API key — optional; question pipeline uses the GH Actions secret)
set -euo pipefail

ACC=d21711ae11a362bc4d57d4fd48deae61
NAME=english-trivia

: "${CF_API_TOKEN:?CF_API_TOKEN required (Cloudflare API token)}"
: "${DISCORD_CLIENT_ID:?DISCORD_CLIENT_ID required (Discord application client ID)}"
: "${DISCORD_CLIENT_SECRET:?DISCORD_CLIENT_SECRET required (Discord app secret)}"
OPENCODE_API_KEY="${OPENCODE_API_KEY:-}"

cd "$(dirname "$0")"
node build.js

BOUNDARY="----bt-deploy-$(date +%s)"
METADATA=$(cat <<JSON
{"main_module":"worker.js","bindings":[{"type":"plain_text","name":"REDIRECT_URI","text":"https://${NAME}.walusimbileon1.workers.dev"},{"type":"plain_text","name":"FB_HOST","text":"pop-party-1-default-rtdb.firebaseio.com"},{"type":"plain_text","name":"MODEL","text":"big-pickle"},{"type":"plain_text","name":"DISCORD_CLIENT_ID","text":"${DISCORD_CLIENT_ID}"}]}
JSON
)

{
  printf -- "--%s\r\n" "$BOUNDARY"
  printf 'Content-Disposition: form-data; name="metadata"\r\n'
  printf 'Content-Type: application/json\r\n\r\n'
  printf '%s' "$METADATA"
  printf "\r\n--%s\r\n" "$BOUNDARY"
  printf 'Content-Disposition: form-data; name="worker.js"; filename="worker.js"\r\n'
  printf 'Content-Type: application/javascript+module\r\n\r\n'
  cat dist/worker.js
  printf "\r\n--%s--\r\n" "$BOUNDARY"
} > /tmp/bt-upload.bin

echo "Uploading $(wc -c < /tmp/bt-upload.bin) bytes..."
RESP=$(curl -s -X PUT \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: multipart/form-data; boundary=$BOUNDARY" \
  --data-binary @/tmp/bt-upload.bin \
  "https://api.cloudflare.com/client/v4/accounts/$ACC/workers/scripts/$NAME")
echo "$RESP" | jq -c '{success, errors: [.errors[].message], id: .result.id, modified: .result.modified_on}'

# Secrets are stored encrypted on the script and persist across deploys.
# (Re)set them so a fresh clone can deploy with just env vars:
curl -s -X PUT -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  "https://api.cloudflare.com/client/v4/accounts/$ACC/workers/scripts/$NAME/secrets" \
  --data "{\"name\":\"DISCORD_CLIENT_SECRET\",\"text\":\"$DISCORD_CLIENT_SECRET\",\"type\":\"secret_text\"}" >/dev/null
if [ -n "$OPENCODE_API_KEY" ]; then
  curl -s -X PUT -H "Authorization: Bearer $CF_API_TOKEN" \
    -H "Content-Type: application/json" \
    "https://api.cloudflare.com/client/v4/accounts/$ACC/workers/scripts/$NAME/secrets" \
    --data "{\"name\":\"OPENCODE_API_KEY\",\"text\":\"$OPENCODE_API_KEY\",\"type\":\"secret_text\"}" >/dev/null
fi
echo "Script secrets set: DISCORD_CLIENT_SECRET${OPENCODE_API_KEY:+, OPENCODE_API_KEY}"
