export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = { message: text };
  }
  if (!res.ok) {
    const j = (json ?? {}) as { error?: string; message?: string; details?: unknown };
    throw new ApiError(res.status, j.error ?? 'error', j.message ?? `HTTP ${res.status}`, j.details);
  }
  return json as T;
}

export const api = {
  get: <T = unknown>(url: string) => call<T>('GET', url),
  post: <T = unknown>(url: string, body: unknown = {}) => call<T>('POST', url, body),
  put: <T = unknown>(url: string, body: unknown) => call<T>('PUT', url, body),
  del: <T = unknown>(url: string) => call<T>('DELETE', url),
};

export const enc = encodeURIComponent;
