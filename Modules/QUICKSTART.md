# Rihla Platform — Quick-Start Guide

## Port Map

| Service | Container name | Host port | Container port |
|---|---|---|---|
| Core Server | `rihla-core-server` | **3000** | 3000 |
| AI Service | `rihla-ai-service` | **3003** | 3003 |
| GeoContext (GIS) | `rihla-gis-service` | **8000** | 8000 |
| Context Service (env) | `rihla-context-service` | **3001** | 3001 |
| Risk Intelligence | `rihla-risk-intelligence` | **3004** | 3004 |
| PostgreSQL | `rihla-postgres` | **5434** | 5432 |
| Qdrant (HTTP) | `rihla-qdrant` | **6333** | 6333 |
| Qdrant (gRPC) | `rihla-qdrant` | **6334** | 6334 |

---

## Prerequisites

1. **Docker Desktop** must be running.
2. Each service must have a real `.env` file populated from its `.env.example`.  
   Minimum required values that must NOT be placeholders in production:
   - `JWT_ACCESS_SECRET` — **must be identical across Core-Server, AI-Service, GeoContext, and Risk_Intelligence**
   - `INTERNAL_API_KEY` — **must be identical across Core-Server and AI-Service**
   - `DATABASE_URL` — PostgreSQL connection string
   - `GEMINI_API_KEYS` — comma-separated Gemini API keys (AI service only)

3. Services must be cloned as siblings of this repo:
   ```
   projects/
   ├── Core-Server/       ← this repo
   ├── ai-service/
   ├── GeoContext/
   ├── context-service/
   └── Risk_Intelligence/
   ```

---

## First-Time Setup

```bash
# 1. Clone all sibling services (adjust URLs as needed)
cd /path/to/projects
git clone https://github.com/Rihla-Ecosystem/Core-Server.git
git clone https://github.com/Rihla-Ecosystem/ai-service.git
git clone https://github.com/Rihla-Ecosystem/GeoContext.git
git clone https://github.com/Rihla-Ecosystem/context-service.git
git clone https://github.com/Rihla-Ecosystem/Risk_Intelligence.git

# 2. Copy and fill .env files in each service
cp Core-Server/.env.example Core-Server/.env
cp ai-service/.env.example  ai-service/.env
# ... etc. — fill in real secrets

# 3. Start only the database first, run migration + seed
cd Core-Server
docker compose up postgres -d
npm install
npm run prisma:migrate   # applies all pending migrations
npm run prisma:seed      # idempotent: safe to re-run

# 4. Start the full platform
cd Modules
docker compose up --build
```

---

## Day-to-Day Commands

```bash
# Start entire platform
cd Core-Server/Modules && docker compose up -d

# View logs for a specific service
docker compose logs -f core-server
docker compose logs -f ai-service

# Stop everything
docker compose down

# Restart a single service without rebuilding others
docker compose restart core-server

# Rebuild and restart one service (e.g. after code change)
docker compose up --build core-server -d

# Run Prisma migration after schema changes
cd Core-Server && npm run prisma:migrate

# Re-run seed (safe — uses upsert)
cd Core-Server && npm run prisma:seed
```

---

## Verification Gates

Run these in order before declaring the deployment healthy:

### Gate 1 — JWT and secrets
```bash
# Should return 401 (no token)
curl http://localhost:3000/api/geo/pois?lat=30.0&lon=31.0

# Should return 403 (wrong internal key)
curl http://localhost:3000/api/internal/geo?lat=30.0&lon=31.0

# Should return 401 (wrong internal key)
curl -H "X-Internal-Api-Key: wrong" http://localhost:3000/api/internal/geo?lat=30.0&lon=31.0
```

### Gate 2 — GeoContext filtering
```bash
# Obtain a JWT via login first, then:
export TOKEN="Bearer <your_access_token>"

# Public endpoint — should NOT contain infrastructure/military/restricted items
curl -H "Authorization: $TOKEN" "http://localhost:3000/api/geo/pois?lat=30.044&lon=31.235"

# Internal endpoint — unfiltered (requires internal key)
curl -H "X-Internal-Api-Key: <key>" "http://localhost:3000/api/internal/geo?lat=30.044&lon=31.235"
```

### Gate 3 — Context schemas
```bash
# Safety context
curl -H "Authorization: $TOKEN" "http://localhost:3000/api/safety?lat=30.044&lon=31.235"

# Currency
curl -H "Authorization: $TOKEN" "http://localhost:3000/api/currency/info"
curl -H "Authorization: $TOKEN" "http://localhost:3000/api/currency/rates?base=USD"

# Journeys
curl -H "Authorization: $TOKEN" "http://localhost:3000/api/journeys"

# Internal combined context
curl -H "X-Internal-Api-Key: <key>" \
  "http://localhost:3000/api/internal/combined-context?user_id=<uuid>&lat=30&lon=31"
```

### Gate 4 — AI integration
```bash
curl -X POST -H "Authorization: $TOKEN" -H "Content-Type: application/json" \
  -d '{"message":"Tell me about the Pyramids","lat":29.9792,"lon":31.1342}' \
  http://localhost:3000/api/chat
```

### Gate 5 — Full Compose smoke test
```bash
# All services should be healthy
docker compose ps

# Core server health
curl http://localhost:3000/health

# AI service health
curl http://localhost:3003/health
```

---

## Unit Tests

```bash
cd Core-Server

# Requires a running PostgreSQL on port 5434 (docker compose up postgres)
npm test
```

The test script loads `.env.test` automatically — no manual env setup needed for unit tests beyond a running database.
