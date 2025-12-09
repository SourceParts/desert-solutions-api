# Desert Solutions API

Microfrontend API service for Desert Solutions quotation and product management.

## Overview

This is a Next.js-based API microfrontend that handles all Desert Solutions business logic, extracted from the main Source Parts application to optimize bundle size and deployment.

## Routes

- `/api/desert-solutions/datasheet` - Generate product datasheets (PDF)
- `/api/desert-solutions/invoice/*` - Invoice creation and status
- `/api/desert-solutions/payment/webhook` - Payment webhook handler
- `/api/desert-solutions/photos/[productId]` - Product photos
- `/api/desert-solutions/products/*` - Product list and details
- `/api/desert-solutions/quotation/*` - Quotation management (create, get, PDF, email, photo addendum)

## Technology Stack

- **Framework**: Next.js 15.5.7
- **Runtime**: React 19
- **PDF Generation**: @react-pdf/renderer 4.3.0
- **Shared Code**: @sourceparts/shared (workspace package)

## Development

```bash
# Install dependencies
pnpm install

# Run development server (port 3005)
pnpm dev

# Build for production
pnpm build

# Start production server
pnpm start
```

## Deployment

This microfrontend is deployed on Vercel and accessed via routing from the main Source Parts application.

**Production URL**: https://desert-solutions-api.vercel.app

## Related

- Main Application: https://github.com/SourceParts/Landing_Page
- Admin API: https://github.com/SourceParts/admin-api
- Studio API: https://github.com/SourceParts/studio-api
- PDF API: https://github.com/SourceParts/pdf-api
