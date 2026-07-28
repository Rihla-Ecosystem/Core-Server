import { env } from '../config/env.js';
import { AppError } from '../middleware/errorHandler.js';

export interface IdentifyResponse {
  name: string;
  name_ar?: string | null;
  description: string;
  category?: string | null;
  historical_period?: string | null;
  wikipedia_url?: string | null;
  image_url?: string | null;
  nearby_sites?: unknown[] | null;
  cached: boolean;
}

export async function identifyLandmark(
  imageBuffer: Buffer,
  imageMimeType: string,
  options?: {
    lat?: number;
    lon?: number;
    radius?: number;
    authorization?: string;
  },
): Promise<IdentifyResponse> {
  const formData = new FormData();
  const blob = new Blob([imageBuffer], { type: imageMimeType });
  formData.append('image', blob, `image.${imageMimeType.split('/')[1] ?? 'jpg'}`);
  if (options?.lat !== undefined) formData.append('lat', String(options.lat));
  if (options?.lon !== undefined) formData.append('lon', String(options.lon));
  if (options?.radius !== undefined) formData.append('radius', String(options.radius));

  const headers: Record<string, string> = {
    'X-Internal-Api-Key': env.INTERNAL_API_KEY,
  };
  if (options?.authorization) headers['Authorization'] = options.authorization;

  const response = await fetch(`${env.AI_SERVICE_URL}/identify`, {
    method: 'POST',
    headers,
    body: formData,
  });

  if (!response.ok) {
    throw new AppError(502, 'AI identification service unavailable');
  }

  return response.json() as Promise<IdentifyResponse>;
}
