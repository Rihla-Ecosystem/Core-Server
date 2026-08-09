// ---------------------------------------------------------------------------
// Incident Report Service
// ---------------------------------------------------------------------------
// User-submitted incident reports (safety, scam, service, damage,
// accessibility). Migrated from the now-removed GeoContext `/reports` feature:
// users report a problem with type/severity/description + optional location,
// admins review them via the admin queue. Reports are rate-limited per user.
import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { AppError } from '../middleware/errorHandler.js';

export type IncidentReportType =
  | 'SAFETY'
  | 'SCAM'
  | 'SERVICE'
  | 'DAMAGE'
  | 'ACCESSIBILITY'
  | 'OTHER';
export type IncidentReportSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface CreateIncidentReportInput {
  type: IncidentReportType;
  severity: IncidentReportSeverity;
  description: string;
  lat?: number;
  lng?: number;
  relatedSiteName?: string;
}

export interface UpdateIncidentReportStatusInput {
  status: 'PENDING' | 'IN_REVIEW' | 'RESOLVED' | 'REJECTED';
  adminNotes?: string;
}

function sanitizeReport(report: {
  id: string;
  type: string;
  severity: string;
  description: string;
  lat: number | null;
  lng: number | null;
  relatedSiteName: string | null;
  status: string;
  adminNotes: string | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: report.id,
    type: report.type,
    severity: report.severity,
    description: report.description,
    lat: report.lat,
    lng: report.lng,
    relatedSiteName: report.relatedSiteName,
    status: report.status,
    adminNotes: report.adminNotes,
    reviewedBy: report.reviewedBy,
    reviewedAt: report.reviewedAt,
    createdAt: report.createdAt,
    updatedAt: report.updatedAt,
  };
}

export async function createIncidentReport(userId: string, input: CreateIncidentReportInput) {
  const report = await prisma.incidentReport.create({
    data: {
      userId,
      type: input.type,
      severity: input.severity,
      description: input.description,
      lat: input.lat,
      lng: input.lng,
      relatedSiteName: input.relatedSiteName,
    },
  });
  return sanitizeReport(report);
}

export async function listOwnReports(
  userId: string,
  page: number,
  limit: number,
  status?: string,
) {
  const where: Prisma.IncidentReportWhereInput = {
    userId,
    ...(status && ['PENDING', 'IN_REVIEW', 'RESOLVED', 'REJECTED'].includes(status)
      ? { status: status as Prisma.IncidentReportWhereInput['status'] }
      : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.incidentReport.count({ where }),
    prisma.incidentReport.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
  ]);
  return {
    reports: rows.map(sanitizeReport),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function getIncidentReport(userId: string, reportId: string) {
  const report = await prisma.incidentReport.findFirst({ where: { id: reportId, userId } });
  if (!report) throw new AppError(404, 'Incident report not found');
  return sanitizeReport(report);
}

export async function deleteIncidentReport(userId: string, reportId: string) {
  const existing = await prisma.incidentReport.findFirst({ where: { id: reportId, userId } });
  if (!existing) throw new AppError(404, 'Incident report not found');
  if (existing.status !== 'PENDING') {
    throw new AppError(409, 'Only pending reports can be deleted');
  }
  await prisma.incidentReport.delete({ where: { id: reportId } });
  return { id: reportId, deleted: true };
}

// ---------------------------------------------------------------------------
// Admin review queue
// ---------------------------------------------------------------------------

export async function listAllIncidentReports(opts: {
  page: number;
  limit: number;
  status?: string;
  type?: string;
  severity?: string;
  search?: string;
}) {
  const where: Prisma.IncidentReportWhereInput = {
    ...(opts.status && ['PENDING', 'IN_REVIEW', 'RESOLVED', 'REJECTED'].includes(opts.status)
      ? { status: opts.status as Prisma.IncidentReportWhereInput['status'] }
      : {}),
    ...(opts.type && ['SAFETY', 'SCAM', 'SERVICE', 'DAMAGE', 'ACCESSIBILITY', 'OTHER'].includes(opts.type)
      ? { type: opts.type as Prisma.IncidentReportWhereInput['type'] }
      : {}),
    ...(opts.severity && ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(opts.severity)
      ? { severity: opts.severity as Prisma.IncidentReportWhereInput['severity'] }
      : {}),
    ...(opts.search
      ? { description: { contains: opts.search, mode: 'insensitive' as Prisma.QueryMode } }
      : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.incidentReport.count({ where }),
    prisma.incidentReport.findMany({
      where,
      skip: (opts.page - 1) * opts.limit,
      take: opts.limit,
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { id: true, displayName: true, email: true } } },
    }),
  ]);
  return {
    reports: rows.map((r) => ({
      ...sanitizeReport(r),
      user: r.user,
    })),
    pagination: { page: opts.page, limit: opts.limit, total, totalPages: Math.ceil(total / opts.limit) },
  };
}

export async function getIncidentReportAdmin(reportId: string) {
  const report = await prisma.incidentReport.findUnique({
    where: { id: reportId },
    include: { user: { select: { id: true, displayName: true, email: true } } },
  });
  if (!report) throw new AppError(404, 'Incident report not found');
  return { ...sanitizeReport(report), user: report.user };
}

export async function updateIncidentReportStatus(
  adminUserId: string,
  reportId: string,
  input: UpdateIncidentReportStatusInput,
) {
  const existing = await prisma.incidentReport.findUnique({ where: { id: reportId } });
  if (!existing) throw new AppError(404, 'Incident report not found');

  const now = new Date();
  const terminal = input.status === 'RESOLVED' || input.status === 'REJECTED';
  const report = await prisma.incidentReport.update({
    where: { id: reportId },
    data: {
      status: input.status,
      adminNotes: input.adminNotes != null ? input.adminNotes : existing.adminNotes,
      reviewedBy: terminal ? adminUserId : existing.reviewedBy,
      reviewedAt: terminal ? now : existing.reviewedAt,
    },
  });
  return sanitizeReport(report);
}