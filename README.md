# leadsetu-api — Backend REST API

> **Port:** 3001
> **Role:** Main backend. Handles auth, all CRM data, webhooks, billing, and orchestrates calls to leadsetu-ai.

## 🔌 How It Connects

```
leadsetu-web (3000)  →  leadsetu-api (3001)  →  leadsetu-ai (3002)
                              ↓
                         PostgreSQL + Redis
```

## 📁 Key Folders

```
src/
├── common/          ← Guards, interceptors, decorators, pipes
├── modules/         ← One folder per feature (leads, deals, inbox, etc.)
│   ├── auth/        ← JWT login, refresh, register
│   ├── tenants/     ← Multi-tenancy core
│   ├── leads/       ← Core CRM — start here!
│   ├── contacts/
│   ├── deals/
│   ├── inbox/       ← WhatsApp + Email conversations
│   └── ...more
├── database/
│   ├── schema.prisma  ← Database schema (Prisma ORM)
│   ├── migrations/
│   └── seeds/
└── types/
    └── contracts.ts   ← ⚠️ SHARED TYPES (keep in sync with other repos)
```

## 🚀 Setup

```bash
cp .env.example .env

npm install
npm run db:migrate     # Run Prisma migrations
npm run db:seed        # Seed dev data
npm run start:dev      # Start on port 3001
```

## 🗄️ Database




## 🔐 Auth Flow

```
POST /v1/auth/login → { accessToken (15m), refreshToken (7d) }
POST /v1/auth/refresh → new accessToken
All other routes → require Bearer accessToken header
```

## ⚠️ Shared Types

The file `src/types/contracts.ts` is shared across all 3 repos.
**Keep it in sync manually** whenever you change an interface.
