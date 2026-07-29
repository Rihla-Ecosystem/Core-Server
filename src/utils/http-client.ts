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

export async function get<T = unknown>(
  url: string,
  params?: Record<string, string | number | undefined>,
  headers?: Record<string, string>,
): Promise<T> {
  const searchParams = new URLSearchParams();
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) searchParams.set(key, String(value));
    }
  }
  const fullUrl = searchParams.toString() ? `${url}?${searchParams}` : url;
  const res = await fetch(fullUrl, { headers });
  if (!res.ok) {
    throw new HttpClientError(res.status, `GET ${fullUrl} failed with ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function post<T = unknown>(
  url: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new HttpClientError(res.status, `POST ${url} failed with ${res.status}`, await res.text());
  }
  return (await res.json()) as T;
}
