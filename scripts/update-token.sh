#!/usr/bin/env bash
# Update the FRAMEIO_TOKEN secret on the deployed Worker.
#
# Usage:
#   scripts/update-token.sh <token>       # token as arg (leaks into shell history)
#   pbpaste | scripts/update-token.sh     # paste from clipboard (macOS)
#   scripts/update-token.sh < token.txt   # from file
#   scripts/update-token.sh               # interactive — paste then Ctrl-D
#
# Recommended: `pbpaste | npm run token` (or `xclip -o | npm run token` on Linux).
#
# Validates the input looks like a JWT (three dot-separated segments), decodes
# the middle segment to show user_id and expiry, then pipes to wrangler.

set -euo pipefail

cd "$(dirname "$0")/.."

if [[ $# -ge 1 ]]; then
  TOKEN="$1"
else
  if [[ -t 0 ]]; then
    echo "Paste the Frame.io token, then Ctrl-D:" >&2
  fi
  TOKEN="$(cat)"
fi

# Strip any whitespace/newlines that might have come with a paste.
TOKEN="$(printf '%s' "$TOKEN" | tr -d '[:space:]')"

if [[ -z "$TOKEN" ]]; then
  echo "error: no token provided" >&2
  exit 1
fi

# Sanity check: JWT shape is header.payload.signature.
if [[ "$(awk -F. '{print NF}' <<<"$TOKEN")" -ne 3 ]]; then
  echo "error: token doesn't look like a JWT (expected 3 dot-separated segments)" >&2
  exit 1
fi

# Decode payload (segment 2). base64 lacks padding in JWTs — pad it.
PAYLOAD_B64="$(cut -d. -f2 <<<"$TOKEN")"
# Add up to 3 '=' to make length a multiple of 4.
while (( ${#PAYLOAD_B64} % 4 != 0 )); do PAYLOAD_B64+="="; done
PAYLOAD_JSON="$(printf '%s' "$PAYLOAD_B64" | tr '_-' '/+' | base64 -d 2>/dev/null || true)"

if [[ -n "$PAYLOAD_JSON" ]]; then
  USER_ID="$(printf '%s' "$PAYLOAD_JSON" | sed -n 's/.*"user_id":"\([^"]*\)".*/\1/p')"
  CREATED_AT="$(printf '%s' "$PAYLOAD_JSON" | sed -n 's/.*"created_at":"\([^"]*\)".*/\1/p')"
  EXPIRES_IN="$(printf '%s' "$PAYLOAD_JSON" | sed -n 's/.*"expires_in":"\([^"]*\)".*/\1/p')"
  if [[ -n "$USER_ID" ]]; then echo "  user_id:    $USER_ID" >&2; fi
  if [[ -n "$CREATED_AT" && -n "$EXPIRES_IN" ]]; then
    # created_at is ms epoch; expires_in is ms.
    EXP_EPOCH_MS=$(( CREATED_AT + EXPIRES_IN ))
    EXP_EPOCH_S=$(( EXP_EPOCH_MS / 1000 ))
    if EXP_HUMAN="$(date -r "$EXP_EPOCH_S" -u '+%Y-%m-%d %H:%M:%S UTC' 2>/dev/null)"; then
      echo "  expires:    $EXP_HUMAN" >&2
    fi
  fi
fi

echo "Uploading FRAMEIO_TOKEN to Cloudflare…" >&2
printf '%s' "$TOKEN" | npx wrangler secret put FRAMEIO_TOKEN
