import { env } from '../config/env.js';
import { AppError } from '../middleware/errorHandler.js';

export interface VoiceResponse {
  text_response: string;
  audio_response?: string | null;
  conversation_id?: string | null;
}

export async function processVoice(
  audioBuffer: Buffer,
  audioMimeType: string,
  options?: {
    lat?: number;
    lon?: number;
    conversationId?: string;
    authorization?: string;
  },
): Promise<VoiceResponse> {
  const formData = new FormData();
  const ext = audioMimeType.split('/')[1] ?? 'webm';
  const blob = new Blob([audioBuffer], { type: audioMimeType });
  formData.append('audio', blob, `audio.${ext}`);
  if (options?.lat !== undefined) formData.append('lat', String(options.lat));
  if (options?.lon !== undefined) formData.append('lon', String(options.lon));
  if (options?.conversationId) formData.append('conversation_id', options.conversationId);

  const headers: Record<string, string> = {
    'X-Internal-Api-Key': env.INTERNAL_API_KEY,
  };
  if (options?.authorization) headers['Authorization'] = options.authorization;

  const response = await fetch(`${env.AI_SERVICE_URL}/voice`, {
    method: 'POST',
    headers,
    body: formData,
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new AppError(502, 'AI voice service unavailable');
  }

  return response.json() as Promise<VoiceResponse>;
}
