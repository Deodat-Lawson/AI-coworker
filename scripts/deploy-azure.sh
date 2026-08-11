#!/usr/bin/env bash
#
# Put the relay on Azure Container Apps. Idempotent: run it again to ship a new
# image over the same app, same URL, same accounts.
#
# What it creates, all inside one resource group you can delete in one command:
#   registry (ACR)          the image
#   storage + file share    /data — accounts, workspaces, the meeting schedule
#   container apps env      the network the app sits in
#   container app           the relay itself, pinned to exactly one replica
#
# One replica is not a cost decision. The relay holds workspaces, rooms and
# connected sockets in memory and shares none of it; a second replica would be a
# second, disagreeing relay. Scaling out needs shared state first.

set -euo pipefail

RG="${STEAD_RG:-stead-rg}"
LOC="${STEAD_LOCATION:-eastus}"
APP="${STEAD_APP:-stead-relay}"
ENVNAME="${STEAD_ENV:-stead-env}"
ACR="${STEAD_ACR:-steadacr$RANDOM}"
SA="${STEAD_STORAGE:-steadstate$RANDOM}"
SHARE="${STEAD_SHARE:-stead-data}"
TAG="${STEAD_TAG:-$(git rev-parse --short HEAD 2>/dev/null || echo latest)}"
RELAY_NAME="${AI_COWORKER_RELAY_NAME:-Stead}"
WORKSPACE_NAME="${AI_COWORKER_WORKSPACE:-Home}"

# ACR and storage names are global and must be lowercase alphanumerics.
ACR="$(echo "$ACR" | tr -cd '[:alnum:]' | tr '[:upper:]' '[:lower:]')"
SA="$(echo "$SA" | tr -cd '[:alnum:]' | tr '[:upper:]' '[:lower:]')"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

say "Subscription"
az account show --query "{name:name, id:id}" -o tsv

say "Provider registration (no-op once done)"
az provider register --namespace Microsoft.App --wait
az provider register --namespace Microsoft.OperationalInsights --wait
az extension add --name containerapp --upgrade --only-show-errors >/dev/null

say "Resource group $RG in $LOC"
az group create -n "$RG" -l "$LOC" -o none

# --- registry -----------------------------------------------------------------
if ! az acr show -n "$ACR" -g "$RG" -o none 2>/dev/null; then
  existing="$(az acr list -g "$RG" --query "[0].name" -o tsv 2>/dev/null || true)"
  if [ -n "$existing" ]; then ACR="$existing"; else
    say "Registry $ACR"
    az acr create -n "$ACR" -g "$RG" --sku Basic --admin-enabled true -o none
  fi
fi

say "Building $ACR.azurecr.io/$APP:$TAG in the cloud (no local docker push needed)"
az acr build -r "$ACR" -t "$APP:$TAG" -t "$APP:latest" . -o none

ACR_SERVER="$(az acr show -n "$ACR" -g "$RG" --query loginServer -o tsv)"
ACR_USER="$(az acr credential show -n "$ACR" -g "$RG" --query username -o tsv)"
ACR_PASS="$(az acr credential show -n "$ACR" -g "$RG" --query "passwords[0].value" -o tsv)"

# --- state --------------------------------------------------------------------
if ! az storage account show -n "$SA" -g "$RG" -o none 2>/dev/null; then
  existing="$(az storage account list -g "$RG" --query "[0].name" -o tsv 2>/dev/null || true)"
  if [ -n "$existing" ]; then SA="$existing"; else
    say "Storage account $SA"
    az storage account create -n "$SA" -g "$RG" -l "$LOC" --sku Standard_LRS --kind StorageV2 -o none
  fi
fi
az storage share-rm create -g "$RG" --storage-account "$SA" -n "$SHARE" --quota 1 -o none 2>/dev/null || true
SA_KEY="$(az storage account keys list -n "$SA" -g "$RG" --query "[0].value" -o tsv)"

# --- environment --------------------------------------------------------------
if ! az containerapp env show -n "$ENVNAME" -g "$RG" -o none 2>/dev/null; then
  say "Container Apps environment $ENVNAME"
  az containerapp env create -n "$ENVNAME" -g "$RG" -l "$LOC" -o none
fi
az containerapp env storage set -n "$ENVNAME" -g "$RG" \
  --storage-name steadstate \
  --azure-file-account-name "$SA" \
  --azure-file-account-key "$SA_KEY" \
  --azure-file-share-name "$SHARE" \
  --access-mode ReadWrite -o none

ENV_ID="$(az containerapp env show -n "$ENVNAME" -g "$RG" --query id -o tsv)"

# --- the app ------------------------------------------------------------------
spec="$(mktemp -t stead-app).yaml"
cat >"$spec" <<YAML
location: $LOC
type: Microsoft.App/containerApps
properties:
  managedEnvironmentId: $ENV_ID
  configuration:
    activeRevisionsMode: Single
    ingress:
      external: true
      targetPort: 8787
      transport: auto
      allowInsecure: false
      traffic:
        - latestRevision: true
          weight: 100
    registries:
      - server: $ACR_SERVER
        username: $ACR_USER
        passwordSecretRef: acr-password
    secrets:
      - name: acr-password
        value: $ACR_PASS
  template:
    containers:
      - name: relay
        image: $ACR_SERVER/$APP:$TAG
        resources:
          cpu: 0.5
          memory: 1.0Gi
        env:
          - name: AI_COWORKER_REQUIRE_AUTH
            value: "1"
          - name: AI_COWORKER_RELAY_NAME
            value: "$RELAY_NAME"
          - name: AI_COWORKER_WORKSPACE
            value: "$WORKSPACE_NAME"
          - name: AI_COWORKER_RELAY_STATE
            value: /data/relay-state.json
          - name: AI_COWORKER_WORKSPACE_STATE
            value: /data/relay-workspaces.json
          - name: AI_COWORKER_ACCOUNT_STATE
            value: /data/relay-accounts.json
        volumeMounts:
          - volumeName: state
            mountPath: /data
        probes:
          - type: Liveness
            httpGet: { path: /health, port: 8787 }
            initialDelaySeconds: 10
            periodSeconds: 30
    scale:
      minReplicas: 1
      maxReplicas: 1
    volumes:
      - name: state
        storageType: AzureFile
        storageName: steadstate
YAML

if az containerapp show -n "$APP" -g "$RG" -o none 2>/dev/null; then
  say "Updating $APP"
  az containerapp update -n "$APP" -g "$RG" --yaml "$spec" -o none
else
  say "Creating $APP"
  az containerapp create -n "$APP" -g "$RG" --yaml "$spec" -o none
fi
rm -f "$spec"

FQDN="$(az containerapp show -n "$APP" -g "$RG" --query "properties.configuration.ingress.fqdn" -o tsv)"

say "Live"
echo "  health   https://$FQDN/health"
echo "  sign-in  https://$FQDN/auth/config"
echo "  relay    wss://$FQDN        <- this is what people type into the desktop app"
echo
echo "  tail logs:  az containerapp logs show -n $APP -g $RG --follow"
echo "  tear down:  az group delete -n $RG --yes"
