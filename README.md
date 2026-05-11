# Cloud Health Portal

Cloud Health Portal — Multi-customer AWS cost optimization reporting portal built on Azure.

## Overview

A full-stack portal that ingests AWS Cost Explorer CSV exports, runs trend analysis, and generates per-customer cost optimization reports — all hosted on Azure.

## Architecture

```
cloud-health-portal/
├── frontend/          React + Vite SPA (Azure Static Web Apps)
├── backend/           Python Azure Functions API
│   ├── upload_csv/    Accepts and validates CSV uploads
│   ├── run_trends/    Runs cost trend analysis
│   ├── build_report/  Generates PDF/HTML cost reports
│   └── shared/        Common utilities and models
├── infra/             Bicep Infrastructure-as-Code
└── .github/workflows/ CI/CD pipelines (GitHub Actions)
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, Vite, TypeScript |
| Backend | Python 3.12, Azure Functions v4 |
| Storage | Azure Blob Storage |
| IaC | Azure Bicep |
| CI/CD | GitHub Actions |

## Getting Started

### Prerequisites
- Node.js 18+
- Python 3.12+
- Azure Functions Core Tools v4
- Azure CLI
- GitHub CLI

### Frontend
```bash
cd frontend
npm install
npm run dev
```

### Backend
```bash
cd backend
pip install -r requirements.txt
func start
```

### Infrastructure
```bash
cd infra
az deployment group create --resource-group rg-cloud-health --template-file main.bicep
```

## Contributing

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Commit your changes
4. Open a pull request
