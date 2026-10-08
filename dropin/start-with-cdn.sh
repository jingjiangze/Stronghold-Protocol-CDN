#!/bin/sh
# One-click: serve this deployment with the art coming from the CDN.
# Put this folder next to the deployment folder (the one with package.json), then run this script.
set -e
cd "$(dirname "$0")/.."
: "${SP_CDN_BASE:=__SP_CDN_BASE__}"
: "${SP_CDN_TOKEN:=__SP_CDN_TOKEN__}"
: "${PORT:=3000}"
export SP_CDN_BASE SP_CDN_TOKEN PORT
echo "[cdn] deployment: $(pwd)"
echo "[cdn] art source: $SP_CDN_BASE"
exec node "$(dirname "$0")/cdn-serve.mjs"
