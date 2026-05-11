#!/usr/bin/env bash
# deploy.sh — deploy Cloud Health Portal to Azure
# Usage: bash infra/deploy.sh [dev|staging|prod]
set -euo pipefail

ENVIRONMENT="${1:-dev}"
RESOURCE_GROUP="rg-cloud-health-portal"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
DEPLOY_NAME="chp-manual-$(date +%Y%m%d-%H%M%S)"

echo "==> Environment : $ENVIRONMENT"
echo "==> Resource group: $RESOURCE_GROUP"
echo "==> Deployment name: $DEPLOY_NAME"
echo ""

# ── 1. Verify Azure CLI login ─────────────────────────────────────────────────
echo "[1/5] Checking Azure CLI login..."
if ! az account show --output none 2>/dev/null; then
  echo "ERROR: Not logged in to Azure. Run 'az login' first." >&2
  exit 1
fi
SUBSCRIPTION=$(az account show --query "id" -o tsv)
echo "      Subscription: $SUBSCRIPTION"

# ── 2. Deploy Bicep infrastructure ───────────────────────────────────────────
echo ""
echo "[2/5] Deploying Bicep infrastructure..."
az deployment group create \
  --resource-group "$RESOURCE_GROUP" \
  --template-file "$SCRIPT_DIR/main.bicep" \
  --parameters "@$SCRIPT_DIR/parameters.dev.json" \
  --name "$DEPLOY_NAME" \
  --mode Incremental \
  --output table

# ── 3. Capture outputs ────────────────────────────────────────────────────────
echo ""
echo "[3/5] Capturing deployment outputs..."
FUNC_APP=$(az deployment group show \
  --resource-group "$RESOURCE_GROUP" \
  --name "$DEPLOY_NAME" \
  --query "properties.outputs.functionAppName.value" -o tsv)

SWA_NAME=$(az deployment group show \
  --resource-group "$RESOURCE_GROUP" \
  --name "$DEPLOY_NAME" \
  --query "properties.outputs.staticWebAppName.value" -o tsv)

echo "      Function App : $FUNC_APP"
echo "      Static Web App: $SWA_NAME"

# ── 4. Deploy Azure Functions ─────────────────────────────────────────────────
echo ""
echo "[4/5] Publishing Azure Functions to: $FUNC_APP"
pushd "$REPO_ROOT/backend" > /dev/null
func azure functionapp publish "$FUNC_APP" --python
popd > /dev/null

# ── 5. Build and deploy frontend ──────────────────────────────────────────────
echo ""
echo "[5/5] Building and deploying frontend to: $SWA_NAME"
pushd "$REPO_ROOT/frontend" > /dev/null
npm install
npm run build

SWA_TOKEN=$(az staticwebapp secrets list \
  --name "$SWA_NAME" \
  --query "properties.apiKey" -o tsv)

npx @azure/static-web-apps-cli deploy ./dist \
  --deployment-token "$SWA_TOKEN" \
  --env "$ENVIRONMENT"
popd > /dev/null

echo ""
echo "==> Deployment complete!"
echo "    Function App URL : https://${FUNC_APP}.azurewebsites.net"
echo "    Static Web App   : https://$(az staticwebapp show --name "$SWA_NAME" --query 'defaultHostname' -o tsv)"
