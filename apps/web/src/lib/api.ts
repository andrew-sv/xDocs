import type { DocumentDTO, Visibility } from '@xdocs/shared';
import { ForbiddenError, UnauthorizedError, clearToken, getToken } from './auth';

/** Empty in dev so the Vite proxy handles it; absolute once deployed. */
const API_BASE = import.meta.env.VITE_API_URL ?? '';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_BASE}/api${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });
  if (res.status === 401) {
    // Stale or absent token: drop it so the gate reappears rather than looping.
    clearToken();
    throw new UnauthorizedError();
  }
  if (res.status === 403) {
    // Signed in successfully, but this account is not allowed. Drop the token
    // so they are not left in a half-signed-in state.
    clearToken();
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ForbiddenError(body?.error);
  }
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} failed: ${res.status}`);
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export const api = {
  listDocuments: () => request<DocumentDTO[]>('/documents'),
  createDocument: (title = 'Untitled') =>
    request<DocumentDTO>('/documents', { method: 'POST', body: JSON.stringify({ title }) }),
  deleteDocument: (id: string) => request<void>(`/documents/${id}`, { method: 'DELETE' }),
  restoreDocument: (id: string) =>
    request<DocumentDTO>(`/documents/${id}/restore`, { method: 'POST' }),
  setVisibility: (id: string, visibility: Visibility) =>
    request<DocumentDTO>(`/documents/${id}/visibility`, {
      method: 'PATCH',
      body: JSON.stringify({ visibility }),
    }),
};
