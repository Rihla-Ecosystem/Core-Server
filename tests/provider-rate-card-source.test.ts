/**
 * Phase 2F-B source-scan guarantees (no database).
 *
 * Proves the read-only loader/repository keep the static card live, are not
 * wired into any runtime path yet, never fall back to or cache anything, never
 * write, and never leak into routes/controllers/Wallet/billing modules.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const SRC_ROOT = join(REPO_ROOT, 'src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
}

const SRC_FILES = walk(SRC_ROOT);
const LOADER_PATH = join(SRC_ROOT, 'services', 'provider-rate-card-loader.service.ts');
const REPO_PATH = join(SRC_ROOT, 'repositories', 'provider-rate-card.repository.ts');
const TYPES_PATH = join(SRC_ROOT, 'types', 'provider-rate-card-load.ts');
const DATE_PATH = join(SRC_ROOT, 'utils', 'provider-rate-card-date.ts');

const SCAN_TARGETS = [LOADER_PATH, REPO_PATH, TYPES_PATH, DATE_PATH];

test('1. static PROVIDER_RATE_CARD remains the active runtime card', () => {
  const configPath = join(SRC_ROOT, 'config', 'provider-rate-card', 'index.ts');
  const content = readFileSync(configPath, 'utf8');
  assert.ok(content.includes('export const PROVIDER_RATE_CARD'));
  assert.ok(content.includes('export const RATE_CARD_PROVIDERS'));
  const aggregatePath = join(SRC_ROOT, 'utils', 'provider-pricing', 'aggregate.ts');
  assert.ok(readFileSync(aggregatePath, 'utf8').includes('PROVIDER_RATE_CARD'));
  const shadowPath = join(SRC_ROOT, 'services', 'ai-shadow-pricing.service.ts');
  assert.ok(readFileSync(shadowPath, 'utf8').includes('PROVIDER_RATE_CARD'), 'shadow pricing must still use the static card');
});

test('2. shadow pricing runtime does not import the 2F-B loader/repository', () => {
  for (const file of SRC_FILES) {
    if (!/ai-shadow-pricing.*\.service\.ts/.test(file)) continue;
    const content = readFileSync(file, 'utf8');
    assert.ok(
      !content.includes('provider-rate-card-loader') && !content.includes('provider-rate-card.repository'),
      `${file} must not import the 2F-B loader/repository`,
    );
  }
});

test('3. recompute service does not import the 2F-B loader/repository', () => {
  const recomputePath = join(SRC_ROOT, 'services', 'ai-shadow-pricing-recompute.service.ts');
  const content = readFileSync(recomputePath, 'utf8');
  assert.ok(!content.includes('provider-rate-card-loader'));
  assert.ok(!content.includes('provider-rate-card.repository'));
});

test('4. no route or controller imports the 2F-B loader/repository', () => {
  const offenders: string[] = [];
  for (const file of SRC_FILES) {
    if (file.startsWith(join(SRC_ROOT, 'routes')) || file.startsWith(join(SRC_ROOT, 'controllers'))) {
      const content = readFileSync(file, 'utf8');
      if (content.includes('provider-rate-card-loader') || content.includes('provider-rate-card.repository')) {
        offenders.push(file.slice(SRC_ROOT.length + 1));
      }
    }
  }
  assert.deepEqual(offenders, [], 'no route/controller may import the 2F-B loader/repository');
});

test('5. Wallet / token reservation / durable billing modules do not import the 2F-B loader/repository', () => {
  const offenders: string[] = [];
  for (const file of SRC_FILES) {
    if (!/token-reservation|token\.service|ai-billing|payment|paymob|business-token|tokenized/.test(file)) continue;
    if (/provider-rate-card-loader|provider-rate-card\.repository/.test(file)) continue;
    const content = readFileSync(file, 'utf8');
    if (content.includes('provider-rate-card-loader') || content.includes('provider-rate-card.repository')) {
      offenders.push(file.slice(SRC_ROOT.length + 1));
    }
  }
  assert.deepEqual(offenders, [], 'Wallet/billing modules must not import the 2F-B loader/repository');
});

test('6. the repository does not import the static card', () => {
  const code = stripComments(readFileSync(REPO_PATH, 'utf8'));
  assert.ok(!code.includes('config/provider-rate-card'), 'repository must not import the static card');
  assert.ok(!code.includes('PROVIDER_RATE_CARD'), 'repository must not reference the static card');
});

test('7. the loader does not import the static card', () => {
  const code = stripComments(readFileSync(LOADER_PATH, 'utf8'));
  assert.ok(!code.includes('config/provider-rate-card'), 'loader must not import the static card');
  assert.ok(!code.includes('PROVIDER_RATE_CARD'), 'loader must not reference the static card');
});

test('8. no static-card fallback pattern exists in the 2F-B modules', () => {
  for (const p of SCAN_TARGETS) {
    const code = stripComments(readFileSync(p, 'utf8'));
    assert.ok(!/try\s*\{[\s\S]*PROVIDER_RATE_CARD/.test(code), `${p} must not fall back to the static card`);
    assert.ok(!code.includes('catch (') || !/PROVIDER_RATE_CARD/.test(code), `${p} must not return the static card on error`);
  }
});

test('9. no cache implementation exists in the 2F-B modules', () => {
  for (const p of SCAN_TARGETS) {
    const code = stripComments(readFileSync(p, 'utf8'));
    for (const token of ['new Map(', 'new WeakMap(', 'new Map<', 'ttl', 'TTL', 'LRU', 'redis', 'memcache', 'refetchInterval', 'staleWhileRevalidate']) {
      assert.ok(!code.includes(token), `${p} must not contain cache token ${token}`);
    }
  }
});

test('10. the repository is read-only (no create/update/delete/upsert)', () => {
  const code = stripComments(readFileSync(REPO_PATH, 'utf8'));
  for (const token of ['.create(', '.update(', '.delete(', '.upsert(', 'createMany', 'updateMany', 'deleteMany', 'createManyAndReturn']) {
    assert.ok(!code.includes(token), `repository must not contain write token ${token}`);
  }
});

test('11. the loader is read-only (no write tokens)', () => {
  const code = stripComments(readFileSync(LOADER_PATH, 'utf8'));
  for (const token of ['.create(', '.update(', '.delete(', '.upsert(', 'createMany', 'updateMany', 'deleteMany']) {
    assert.ok(!code.includes(token), `loader must not contain write token ${token}`);
  }
});

test('12. only the Phase 2F-C admin rate-card route/controller exist (no other rate-card route/controller)', () => {
  const allowed = new Set([
    'admin-rate-card.routes.ts',
    'admin-rate-card.controller.ts',
  ]);
  const offenders: string[] = [];
  for (const file of SRC_FILES) {
    if (!file.startsWith(join(SRC_ROOT, 'routes')) && !file.startsWith(join(SRC_ROOT, 'controllers'))) continue;
    if (/rate-?card/i.test(file)) {
      const base = file.slice(SRC_ROOT.length + 1);
      if (!allowed.has(base) && !allowed.has(base.split('/').pop() ?? '')) {
        offenders.push(base);
      }
    }
  }
  assert.deepEqual(offenders, [], 'only the Phase 2F-C admin rate-card route/controller may exist');
});

test('12b. the Phase 2F-C admin rate-card route and controller exist', () => {
  const routesPath = join(SRC_ROOT, 'routes', 'admin-rate-card.routes.ts');
  const controllerPath = join(SRC_ROOT, 'controllers', 'admin-rate-card.controller.ts');
  assert.ok(readFileSync(routesPath, 'utf8').includes('/drafts'), 'route must expose the draft workflow');
  assert.ok(readFileSync(controllerPath, 'utf8').includes('createDraft'), 'controller must expose createDraft');
  assert.ok(readFileSync(controllerPath, 'utf8').includes('publish'), 'controller must expose publish');
});

test('12c. static rate-card import is script-only (no runtime route/controller action)', () => {
  const routesPath = join(SRC_ROOT, 'routes', 'admin-rate-card.routes.ts');
  const controllerPath = join(SRC_ROOT, 'controllers', 'admin-rate-card.controller.ts');
  const routesCode = stripComments(readFileSync(routesPath, 'utf8'));
  const controllerCode = stripComments(readFileSync(controllerPath, 'utf8'));
  assert.ok(!routesCode.includes('/import/static'), 'route must not expose a static-import endpoint');
  assert.ok(!controllerCode.includes('importStatic'), 'controller must not expose importStatic');
  assert.ok(!controllerCode.includes('importStaticRateCardAsDraft'), 'controller must not call the static-import service');

  const scriptPath = join(REPO_ROOT, 'scripts', 'import-static-provider-rate-card-draft.ts');
  const scriptCode = readFileSync(scriptPath, 'utf8');
  assert.ok(scriptCode.includes("'/core_server_test'"), 'script must hard-gate on /core_server_test');
  assert.ok(scriptCode.includes('importStaticRateCardAsDraft'), 'script must drive the service import');
  for (const p of SRC_FILES) {
    if (!p.startsWith(join(SRC_ROOT, 'routes')) && !p.startsWith(join(SRC_ROOT, 'controllers'))) continue;
    const code = readFileSync(p, 'utf8');
    assert.ok(!code.includes('import-static-provider-rate-card-draft'), `route/controller ${p} must not reference the script`);
  }
});

test('13. the loader/repository are only imported by the Phase 2G-B billing rate-card resolver and DB shadow comparison', () => {
  const offenders: string[] = [];
  for (const file of SRC_FILES) {
    if (file === LOADER_PATH || file === REPO_PATH || file === TYPES_PATH || file === DATE_PATH) continue;
    // Phase 2F-D: shadow-pricing-deps.ts is allowed to import the loader for DB shadow comparison
    if (file.endsWith('shadow-pricing-deps.ts')) continue;
    // Phase 2G-B: the authoritative billing rate-card resolver wires the loader/repository
    // for DATABASE_PRIMARY billing (load once per operation, fail closed on failure).
    if (file.endsWith('billing-rate-card.service.ts')) continue;
    const content = readFileSync(file, 'utf8');
    if (content.includes('provider-rate-card-loader') || content.includes('provider-rate-card.repository')) {
      offenders.push(file.slice(SRC_ROOT.length + 1));
    }
  }
  assert.deepEqual(offenders, [], 'the 2F-B loader/repository must only be wired through the Phase 2G-B billing rate-card resolver and DB shadow comparison');
});

test('14. the loader/repository perform no pricing arithmetic or model selection', () => {
  for (const p of [LOADER_PATH, REPO_PATH]) {
    const code = stripComments(readFileSync(p, 'utf8'));
    assert.ok(!code.includes('priceProviderCall'), `${p} must not call pricing arithmetic`);
    assert.ok(!code.includes('aggregateProviderCalls'), `${p} must not aggregate pricing`);
    assert.ok(!code.includes('resolveRate'), `${p} must not perform model-price selection`);
  }
});
