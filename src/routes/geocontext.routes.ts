import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { geocontextProxyApi } from '../services/geocontext-proxy.service.js';

const router = Router();

function _auth(req: Parameters<Parameters<typeof router.get>[1]>[0] extends never ? never : never): never {
  return undefined as never;
}

// Helper to extract auth header
function authHeader(req: { headers: { authorization?: string } }): string | undefined {
  return req.headers.authorization;
}

// ---- Locations ----

router.get('/locations', authenticate, async (req, res, next) => {
  try {
    const result = await geocontextProxyApi.getLocations(
      {
        page: req.query.page ? Number(req.query.page) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        search: req.query.search as string | undefined,
        category: req.query.category as string | undefined,
        governorate: req.query.governorate as string | undefined,
        status: req.query.status as string | undefined,
        risk: req.query.risk as string | undefined,
        hasWarnings: req.query.hasWarnings === 'true' ? true : req.query.hasWarnings === 'false' ? false : undefined,
        updatedSince: req.query.updatedSince as string | undefined,
        sortBy: req.query.sortBy as string | undefined,
        sortOrder: req.query.sortOrder as string | undefined,
      },
      authHeader(req),
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get('/locations/:id', authenticate, async (req, res, next) => {
  try {
    const result = await geocontextProxyApi.getLocation(req.params.id as string, authHeader(req));
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/locations', authenticate, async (req, res, next) => {
  try {
    const result = await geocontextProxyApi.createLocation(req.body, authHeader(req));
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

router.put('/locations/:id', authenticate, async (req, res, next) => {
  try {
    const result = await geocontextProxyApi.updateLocation(req.params.id as string, req.body, authHeader(req));
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.delete('/locations/:id', authenticate, async (req, res, next) => {
  try {
    await geocontextProxyApi.deleteLocation(req.params.id as string, authHeader(req));
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

router.put('/locations/:id/status', authenticate, async (req, res, next) => {
  try {
    const result = await geocontextProxyApi.setLocationStatus(
      req.params.id as string, req.body.status as string, authHeader(req),
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.put('/locations/bulk/status', authenticate, async (req, res, next) => {
  try {
    const result = await geocontextProxyApi.bulkSetLocationStatus(
      req.body.ids as string[], req.body.status as string, authHeader(req),
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.delete('/locations/bulk', authenticate, async (req, res, next) => {
  try {
    const result = await geocontextProxyApi.bulkDeleteLocations(req.body.ids as string[], authHeader(req));
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ---- Location Warnings ----

router.post('/locations/:id/warnings', authenticate, async (req, res, next) => {
  try {
    const result = await geocontextProxyApi.addWarning(req.params.id as string, req.body, authHeader(req));
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

router.delete('/locations/:id/warnings/:warningId', authenticate, async (req, res, next) => {
  try {
    await geocontextProxyApi.deleteWarning(req.params.id as string, req.params.warningId as string, authHeader(req));
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// ---- Nearby Services ----

router.get('/locations/:id/nearby-services', authenticate, async (req, res, next) => {
  try {
    const result = await geocontextProxyApi.getNearbyServices(req.params.id as string, authHeader(req));
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/locations/:id/nearby-services', authenticate, async (req, res, next) => {
  try {
    const result = await geocontextProxyApi.addNearbyService(req.params.id as string, req.body, authHeader(req));
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

router.delete('/locations/:id/nearby-services/:serviceId', authenticate, async (req, res, next) => {
  try {
    await geocontextProxyApi.deleteNearbyService(req.params.id as string, req.params.serviceId as string, authHeader(req));
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// ---- Analytics & Activity ----

router.get('/analytics', authenticate, async (req, res, next) => {
  try {
    const result = await geocontextProxyApi.getAnalytics(authHeader(req));
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get('/activity', authenticate, async (req, res, next) => {
  try {
    const result = await geocontextProxyApi.getActivity(authHeader(req));
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ---- Import / Export ----

router.post('/import/geojson', authenticate, async (req, res, next) => {
  try {
    const result = await geocontextProxyApi.importGeoJSON(req.body, authHeader(req));
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

router.get('/export/geojson', authenticate, async (req, res, next) => {
  try {
    const result = await geocontextProxyApi.exportGeoJSON(authHeader(req));
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ---- Governorates ----

router.get('/governorates', authenticate, async (req, res, next) => {
  try {
    const result = await geocontextProxyApi.getGovernorates(authHeader(req));
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ---- Restricted Zones ----

router.get('/restricted-zones', authenticate, async (req, res, next) => {
  try {
    const result = await geocontextProxyApi.getRestrictedZones(authHeader(req));
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/restricted-zones', authenticate, async (req, res, next) => {
  try {
    const result = await geocontextProxyApi.createRestrictedZone(req.body, authHeader(req));
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

router.put('/restricted-zones/:id', authenticate, async (req, res, next) => {
  try {
    const result = await geocontextProxyApi.updateRestrictedZone(req.params.id as string, req.body, authHeader(req));
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.delete('/restricted-zones/:id', authenticate, async (req, res, next) => {
  try {
    await geocontextProxyApi.deleteRestrictedZone(req.params.id as string, authHeader(req));
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// ---- Boundaries ----

router.get('/boundaries', authenticate, async (req, res, next) => {
  try {
    const result = await geocontextProxyApi.getBoundaries(authHeader(req));
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/boundaries', authenticate, async (req, res, next) => {
  try {
    const result = await geocontextProxyApi.createBoundary(req.body, authHeader(req));
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

router.get('/boundaries/:id', authenticate, async (req, res, next) => {
  try {
    const result = await geocontextProxyApi.getBoundary(req.params.id as string, authHeader(req));
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.put('/boundaries/:id', authenticate, async (req, res, next) => {
  try {
    const result = await geocontextProxyApi.updateBoundary(req.params.id as string, req.body, authHeader(req));
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.delete('/boundaries/:id', authenticate, async (req, res, next) => {
  try {
    await geocontextProxyApi.deleteBoundary(req.params.id as string, authHeader(req));
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
