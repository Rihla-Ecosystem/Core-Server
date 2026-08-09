# Core-Server — Handoff

> Read relevant section only. Appends 3–6 lines. Prune Changelog > 25.
> Last updated: 2026-08-09

## Current status
- Express + Prisma + PostgreSQL core service (port 3000). DB container `core-server-db` (5434) hosting `core_server`; test DB `core_server_test`.
- Prisma 6.19.3 (CLI). Migration `20260809023822_add_incident_reports` applied; client regenerated.
- `tsc --noEmit` clean; full test suite `node --test` under `.env.test` passes 2173/2173.

## In-progress / next
- Everything for this task landed and verified locally. Next: restart core on 3000, then smoke `/api/reports` (user) + `/api/admin/incident-reports` (admin role), and confirm `POST /context-notifications/location` returns `skipped:true` on <50m movement.

## Architecture notes
- Context engine: `POST /context-notifications/location` → `context-engine.service.ts` aggregates geo/risk/profile, calls ai-service `/analyze`, persists notifications + `context_reports`, SSEs online users.
- New incident reports: `incident_reports` table, feature owned entirely by Core now (GeoContext's version was dropped).
- Context reports (AI-generated) are distinct from incident reports (user-submitted) — two separate tables/APIs.

## Key files
- `prisma/schema.prisma` (IncidentReport model + 3 enums) · `prisma/migrations/20260809023822_add_incident_reports/`
- `src/services/incident-report.service.ts` · `src/controllers/incident-report.controller.ts` · `src/routes/incident-report.routes.ts` (mounted `/reports`)
- `src/controllers/incident-report-admin.controller.ts` · `src/routes/incident-report-admin.routes.ts` (mounted `/admin/incident-reports`, role admin/moderator)
- `src/routes/context-notification.routes.ts` (lat/lng bounds + 60/min limiter) · `src/services/context-engine.service.ts` (50m throttle)
- `src/types/context-notification.ts` (ContextEngineResult.contextReport now nullable + `skipped` flag)

## Gotchas
- Env: `DATABASE_URL=postgresql://core_user:@localhost:5434/core_server`, tests use `.env.test` → `/core_server_test`. `JWT_ACCESS_SECRET`/`INTERNAL_API_KEY` must match across services.
- No `npm test` script — run via `node --env-file=.env.test --import tsx --test-concurrency=1 --test tests/*.test.ts`.
- DB creds/port: started with `docker start core-server-db geocontext_db`.

## Changelog
- 2026-08-09: INCIDENT REPORTS RE-ADDED (feature dropped from GeoContext now lives in Core). Model + `IncidentReportType/Severity/Status` enums, `relatedSiteName` varchar(255), user FK cascade, indexes `[userId, createdAt]`/`[status]`. User API `/api/reports` (5/min, zod bound lat/lng, status starts PENDING) + admin `/api/admin/incident-reports` (list/get/patch status+adminNotes, requireRole admin/moderator). Context-engine: 50m min-distance throttle — repeated movement pings skip AI + report write (`skipped:true`, null report); bounds + 60/min limiter on `/location`. 2173/2173 tests + tsc clean.