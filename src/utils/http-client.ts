export class HttpClientError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
    this.name = 'HttpClientError';
  }
}

export const DEFAULT_TIMEOUT_MS = 10_000;

export async function get<T = unknown>(
  url: string,
  params?: Record<string, string | number | undefined>,
  headers?: Record<string, string>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const searchParams = new URLSearchParams();
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) searchParams.set(key, String(value));
    }
  }
  const fullUrl = searchParams.toString() ? `${url}?${searchParams}` : url;
  const res = await fetch(fullUrl, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    throw new HttpClientError(res.status, `GET ${fullUrl} failed with ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function post<T = unknown>(
  url: string,
  body?: unknown,
  headers?: Record<string, string>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new HttpClientError(res.status, `POST ${url} failed with ${res.status}`, await res.text());
  }
  return (await res.json()) as T;
}

export async function put<T = unknown>(
  url: string,
  body?: unknown,
  headers?: Record<string, string>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new HttpClientError(res.status, `PUT ${url} failed with ${res.status}`, await res.text());
  }
  return (await res.json()) as T;
}

export async function del<T = unknown>(
  url: string,
  headers?: Record<string, string>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  body?: unknown,
): Promise<T> {
  const res = await fetch(url, {
    method: 'DELETE',
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new HttpClientError(res.status, `DELETE ${url} failed with ${res.status}`, await res.text());
  }
  if (res.status === 204 || res.headers.get('content-length') === '0') return undefined as T;
  return (await res.json()) as T;
}

export async function upstreamError(
  fallback: string,
  response: Response,
): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: string; error?: string };
    const detail = body.detail || body.error;
    if (detail) return `${fallback}: ${detail}`;
  } catch {
    // ignore unparseable bodies
  }
  return fallback;
}
