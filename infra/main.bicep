@description('Environment name (dev, staging, prod)')
param environment string = 'dev'

@description('Azure region for all resources')
param location string = 'eastus2'

@description('Existing Cosmos DB account name')
param cosmosDbAccountName string

@description('Existing Storage account name')
param storageAccountName string

@description('Existing Key Vault name')
param keyVaultName string

@description('AI Foundry endpoint URL')
param aiEndpoint string

@description('AI Foundry deployment name')
param aiDeploymentName string

var prefix = 'chp-${environment}'

// ── Existing resources (reference only, not created here) ────────────────────

resource cosmosDb 'Microsoft.DocumentDB/databaseAccounts@2023-11-15' existing = {
  name: cosmosDbAccountName
}

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-01-01' existing = {
  name: storageAccountName
}

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

// ── Azure Functions (Python, consumption plan) ───────────────────────────────

resource appServicePlan 'Microsoft.Web/serverfarms@2023-01-01' = {
  name: '${prefix}-plan'
  location: location
  sku: {
    name: 'Y1'
    tier: 'Dynamic'
  }
  kind: 'functionapp'
  properties: {
    reserved: true  // required for Linux consumption plan
  }
}

resource functionApp 'Microsoft.Web/sites@2023-01-01' = {
  name: '${prefix}-func'
  location: location
  kind: 'functionapp,linux'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: appServicePlan.id
    siteConfig: {
      linuxFxVersion: 'Python|3.12'
      appSettings: [
        {
          name: 'AzureWebJobsStorage'
          value: 'DefaultEndpointsProtocol=https;AccountName=${storageAccount.name};AccountKey=${storageAccount.listKeys().keys[0].value};EndpointSuffix=core.windows.net'
        }
        {
          name: 'FUNCTIONS_EXTENSION_VERSION'
          value: '~4'
        }
        {
          name: 'FUNCTIONS_WORKER_RUNTIME'
          value: 'python'
        }
        {
          name: 'STORAGE_CONNECTION_STRING'
          value: 'DefaultEndpointsProtocol=https;AccountName=${storageAccount.name};AccountKey=${storageAccount.listKeys().keys[0].value};EndpointSuffix=core.windows.net'
        }
        {
          name: 'COSMOS_CONNECTION_STRING'
          value: cosmosDb.listConnectionStrings().connectionStrings[0].connectionString
        }
        {
          name: 'KEY_VAULT_URI'
          value: keyVault.properties.vaultUri
        }
        {
          name: 'AI_ENDPOINT'
          value: aiEndpoint
        }
        {
          name: 'AI_DEPLOYMENT_NAME'
          value: aiDeploymentName
        }
        {
          name: 'WEBSITE_RUN_FROM_PACKAGE'
          value: '1'
        }
      ]
      cors: {
        allowedOrigins: [
          'https://red-sand-05177ba0f.7.azurestaticapps.net'
        ]
        supportCredentials: false
      }
    }
    httpsOnly: true
  }
}

// Grant Function App identity read access to Key Vault secrets
resource kvAccessPolicy 'Microsoft.KeyVault/vaults/accessPolicies@2023-07-01' = {
  name: '${keyVaultName}/add'
  properties: {
    accessPolicies: [
      {
        tenantId: subscription().tenantId
        objectId: functionApp.identity.principalId
        permissions: {
          secrets: ['get', 'list']
        }
      }
    ]
  }
}

// ── Azure Static Web App (Standard tier) ─────────────────────────────────────

resource staticWebApp 'Microsoft.Web/staticSites@2023-01-01' = {
  name: '${prefix}-swa'
  location: location
  sku: {
    name: 'Standard'
    tier: 'Standard'
  }
  properties: {
    buildProperties: {
      appLocation: 'frontend'
      outputLocation: 'dist'
    }
  }
}

// ── Outputs ──────────────────────────────────────────────────────────────────

output functionAppName string = functionApp.name
output functionAppUrl string = 'https://${functionApp.properties.defaultHostName}'
output functionAppPrincipalId string = functionApp.identity.principalId

output staticWebAppName string = staticWebApp.name
output staticWebAppUrl string = 'https://${staticWebApp.properties.defaultHostname}'
output staticWebAppApiKey string = staticWebApp.listSecrets().properties.apiKey

output storageAccountName string = storageAccount.name
output storageAccountBlobEndpoint string = storageAccount.properties.primaryEndpoints.blob

output cosmosDbAccountName string = cosmosDb.name
output cosmosDbEndpoint string = cosmosDb.properties.documentEndpoint

output keyVaultUri string = keyVault.properties.vaultUri

output aiEndpointOut string = aiEndpoint
output aiDeploymentNameOut string = aiDeploymentName
