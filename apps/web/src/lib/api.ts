import type { DocumentDTO } from '@xdocs/shared';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
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
};
