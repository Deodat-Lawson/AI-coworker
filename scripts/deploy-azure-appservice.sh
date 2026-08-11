#!/usr/bin/env bash
#
# Put the relay on Azure App Service (Linux, Basic B1). Idempotent: run it again
# to ship a new build to the same URL with the same accounts intact.
#
# Why this shape, for a team of one to three:
#   * B1 is the cheapest tier that stays awake. The relay arms an in-process
#     timer for every booked meeting, so a plan that sleeps misses them.
#   * /home is persistent and backed up by the platform, so the three state
#     files need no separate storage account and no container registry.
#   * TLS and wss on *.azurewebsites.net come free, and the desktop app needs
#     wss — a browserless client still refuses to carry a session over plain ws.
#
# One instance, deliberately: workspaces, rooms and live sockets live in memory
# and are shared with nobody. A second instance is a second, disagreeing relay.

set -euo pipefail

RG="${STEAD_RG:-stead-rg}"
LOC="${STEAD_LOCATION:-eastus}"
PLAN="${STEAD_PLAN:-stead-plan}"
APP="${STEAD_APP:-stead-relay-$(whoami | tr -cd '[:alnum:]' | tr '[:upper:]' '[:lower:]')}"
RELAY_NAME="${AI_COWORKER_RELAY_NAME:-Stead}"
WORKSPACE_NAME="${AI_COWORKER_WORKSPACE:-Home}"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

say "Subscription"
az account show --query "{name:name, id:id}" -o tsv

say "Building shared + server"
npm run build:core >/dev/null

# --- stage a self-contained app ----------------------------------------------
# App Service runs one package, not an npm workspace tree. The workspace symlink
# `node_modules/@ai-coworker/shared` does not survive a zip, so shared is copied
# in as a real directory instead.
say "Staging deployment package"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

mkdir -p "$stage/packages/server" "$stage/packages/shared" "$stage/node_modules/@ai-coworker"
cp -R packages/server/dist "$stage/packages/server/dist"
cp packages/server/package.json "$stage/packages/server/package.json"
cp -R packages/shared/dist "$stage/packages/shared/dist"
cp packages/shared/package.json "$stage/packages/shared/package.json"

ws_version="$(node -p "require('./packages/server/package.json').dependencies.ws")"
cat >"$stage/package.json" <<JSON
{
  "name": "stead-relay",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "packages/server/dist/main.js",
  "scripts": { "start": "node packages/server/dist/main.js" },
  "dependencies": { "ws": "$ws_version" }
}
JSON

( cd "$stage" && npm install --omit=dev --no-audit --no-fund --loglevel=error >/dev/null )

# Shared goes in *after* the install: npm prunes anything it considers
# extraneous, and a hand-placed package it cannot see in `dependencies` is
# exactly that. A `file:` dependency would instead leave a symlink, which does
# not survive the zip. So: install first, then drop the real directory in.
mkdir -p "$stage/node_modules/@ai-coworker"
cp -R "$stage/packages/shared" "$stage/node_modules/@ai-coworker/shared"

bundle="$stage/../stead-relay-$$.zip"
( cd "$stage" && zip -qr "$bundle" . )
say "Package: $(du -h "$bundle" | cut -f1)"

# --- infrastructure -----------------------------------------------------------
say "Resource group $RG in $LOC"
az group create -n "$RG" -l "$LOC" -o none

if ! az appservice plan show -n "$PLAN" -g "$RG" -o none 2>/dev/null; then
  say "App Service plan $PLAN (Linux B1)"
  az appservice plan create -n "$PLAN" -g "$RG" -l "$LOC" --is-linux --sku B1 -o none
fi

if ! az webapp show -n "$APP" -g "$RG" -o none 2>/dev/null; then
  say "Web app $APP"
  az webapp create -n "$APP" -g "$RG" --plan "$PLAN" --runtime "NODE:22-lts" -o none
fi

say "Configuration"
# WebSockets are off by default and the relay is nothing without them. Always On
# keeps the process alive between connections so meeting timers survive.
az webapp config set -n "$APP" -g "$RG" \
  --web-sockets-enabled true \
  --always-on true \
  --startup-file "node packages/server/dist/main.js" \
  --minimum-elastic-instance-count 1 -o none 2>/dev/null \
  || az webapp config set -n "$APP" -g "$RG" \
       --web-sockets-enabled true --always-on true \
       --startup-file "node packages/server/dist/main.js" -o none

# HTTPS only: the sign-in endpoints carry a session token in the response body.
az webapp update -n "$APP" -g "$RG" --https-only true -o none

az webapp config appsettings set -n "$APP" -g "$RG" --settings \
  AI_COWORKER_REQUIRE_AUTH=1 \
  AI_COWORKER_RELAY_NAME="$RELAY_NAME" \
  AI_COWORKER_WORKSPACE="$WORKSPACE_NAME" \
  AI_COWORKER_ACCOUNT_STATE=/home/data/relay-accounts.json \
  AI_COWORKER_WORKSPACE_STATE=/home/data/relay-workspaces.json \
  AI_COWORKER_RELAY_STATE=/home/data/relay-state.json \
  SCM_DO_BUILD_DURING_DEPLOYMENT=false \
  WEBSITE_RUN_FROM_PACKAGE=0 -o none

say "Deploying"
az webapp deploy -n "$APP" -g "$RG" --src-path "$bundle" --type zip --async false -o none
rm -f "$bundle"

FQDN="$(az webapp show -n "$APP" -g "$RG" --query defaultHostName -o tsv)"

say "Live"
echo "  health   https://$FQDN/health"
echo "  sign-in  https://$FQDN/auth/config"
echo "  relay    wss://$FQDN        <- this goes in the desktop app's relay field"
echo
echo "  tail logs:  az webapp log tail -n $APP -g $RG"
echo "  state:      /home/data (persists across restarts and redeploys)"
echo "  tear down:  az group delete -n $RG --yes"
