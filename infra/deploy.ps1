# deploy.ps1 — deploy Cloud Health Portal to Azure
# Usage: .\infra\deploy.ps1 [-Environment dev|staging|prod]
param(
    [ValidateSet('dev', 'staging', 'prod')]
    [string]$Environment = 'dev'
)

$ErrorActionPreference = 'Stop'
$ResourceGroup = 'rg-cloud-health-portal'
$ScriptDir    = $PSScriptRoot
$RepoRoot     = Split-Path $ScriptDir -Parent
$DeployName   = "chp-manual-$(Get-Date -Format 'yyyyMMdd-HHmmss')"

Write-Host "==> Environment : $Environment"
Write-Host "==> Resource group: $ResourceGroup"
Write-Host "==> Deployment name: $DeployName"
Write-Host ""

# ── 1. Verify Azure CLI login ─────────────────────────────────────────────────
Write-Host "[1/5] Checking Azure CLI login..."
az account show --output none
if ($LASTEXITCODE -ne 0) {
    Write-Error "Not logged in to Azure. Run 'az login' first."
    exit 1
}
$Subscription = az account show --query "id" -o tsv
Write-Host "      Subscription: $Subscription"

# ── 2. Deploy Bicep infrastructure ───────────────────────────────────────────
Write-Host ""
Write-Host "[2/5] Deploying Bicep infrastructure..."
az deployment group create `
    --resource-group $ResourceGroup `
    --template-file "$ScriptDir\main.bicep" `
    --parameters "@$ScriptDir\parameters.dev.json" `
    --name $DeployName `
    --mode Incremental `
    --output table
if ($LASTEXITCODE -ne 0) { Write-Error "Bicep deployment failed."; exit 1 }

# ── 3. Capture outputs ────────────────────────────────────────────────────────
Write-Host ""
Write-Host "[3/5] Capturing deployment outputs..."
$FuncApp = az deployment group show `
    --resource-group $ResourceGroup `
    --name $DeployName `
    --query "properties.outputs.functionAppName.value" -o tsv

$SwaName = az deployment group show `
    --resource-group $ResourceGroup `
    --name $DeployName `
    --query "properties.outputs.staticWebAppName.value" -o tsv

Write-Host "      Function App : $FuncApp"
Write-Host "      Static Web App: $SwaName"

# ── 4. Deploy Azure Functions ─────────────────────────────────────────────────
Write-Host ""
Write-Host "[4/5] Publishing Azure Functions to: $FuncApp"
Push-Location "$RepoRoot\backend"
func azure functionapp publish $FuncApp --python
if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Error "Function App publish failed."; exit 1 }
Pop-Location

# ── 5. Build and deploy frontend ──────────────────────────────────────────────
Write-Host ""
Write-Host "[5/5] Building and deploying frontend to: $SwaName"
Push-Location "$RepoRoot\frontend"

npm install
if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Error "npm install failed."; exit 1 }

npm run build
if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Error "Frontend build failed."; exit 1 }

$SwaToken = az staticwebapp secrets list `
    --name $SwaName `
    --query "properties.apiKey" -o tsv

npx @azure/static-web-apps-cli deploy ./dist `
    --deployment-token $SwaToken `
    --env $Environment
if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Error "Static Web App deploy failed."; exit 1 }

Pop-Location

Write-Host ""
Write-Host "==> Deployment complete!"
$FuncUrl = "https://$FuncApp.azurewebsites.net"
$SwaHost = az staticwebapp show --name $SwaName --query 'defaultHostname' -o tsv
Write-Host "    Function App URL : $FuncUrl"
Write-Host "    Static Web App   : https://$SwaHost"
