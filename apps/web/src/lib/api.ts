import type {
  ApiKeyDTO,
  AttachmentDTO,
  AttachmentUsageDTO,
  DocumentAttachmentDTO,
  DocumentContentDTO,
  DocumentVersionContentDTO,
  DocumentVersionDTO,
  CreatedApiKeyDTO,
  DocumentDTO,
  SearchResultDTO,
  TrashEntryDTO,
  Visibility,
} from '@xdocs/shared';
// A value, not a type: `send()` compares the server's code against it.
import { ACCOUNT_NOT_ALLOWED } from '@xdocs/shared';
import { ForbiddenError, UnauthorizedError, clearToken, getToken } from './auth';

/** Empty in dev so the Vite proxy handles it; absolute once deployed. */
const API_BASE = import.meta.env.VITE_API_URL ?? '';

/** An authenticated fetch, with auth failures handled the same way everywhere. */
async function send(path: string, init?: RequestInit): Promise<Response> {
  const token = getToken();
  const res = await fetch(`${API_BASE}/api${path}`, {
    ...init,
    headers: {
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
    const body = (await res.json().catch(() => null)) as
      | { error?: string; code?: string }
      | null;
    /*
     * Only the allowlist refusal ends the session, and it says so by its code.
     *
     * Every 403 used to be read as "this account is not allowed in", which
     * dropped the token and showed the login gate. That made 403 unusable for
     * an ordinary refusal — an owner-only route answering "only the owner can
     * delete this" would have signed the user out — and is why routes that
     * simply cannot serve you answer 404 instead (#31).
     */
    if (body?.code === ACCOUNT_NOT_ALLOWED) {
      // Drop the token so they are not left in a half-signed-in state.
      clearToken();
      throw new ForbiddenError(body.error);
    }
    // An ordinary refusal of this one action: the caller shows it and the
    // session carries on untouched.
    throw new Error(body?.error ?? 'You are not allowed to do that.');
  }
  return res;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await send(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} failed: ${res.status}`);
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

/** The server's own explanation where there is one — "Files are limited to 10 MB." */
async function failure(res: Response, fallback: string): Promise<Error> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return new Error(typeof body?.error === 'string' ? body.error : `${fallback} (${res.status})`);
}

/** RFC 6266 filename*, then plain filename. */
function filenameFrom(disposition: string | null): string | null {
  if (!disposition) return null;
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (encoded) {
    try {
      return decodeURIComponent(encoded[1]!);
    } catch {
      // Fall through to the ASCII form.
    }
  }
  return /filename="([^"]*)"/i.exec(disposition)?.[1] ?? null;
}

export const api = {
  /** Children of `parentId`, or the top level when omitted. */
  listDocuments: (parentId?: string | null) =>
    request<DocumentDTO[]>(`/documents${parentId ? `?parent=${parentId}` : ''}`),
  /** The same, with the server time the list was read — see refresh() in App. */
  listLevel: async (parentId: string | null): Promise<{ rows: DocumentDTO[]; asOf: number }> => {
    const res = await send(`/documents${parentId ? `?parent=${parentId}` : ''}`);
    if (!res.ok) throw new Error(`GET /documents failed: ${res.status}`);
    return {
      rows: (await res.json()) as DocumentDTO[],
      asOf: Number(res.headers.get('x-list-as-of') ?? 0),
    };
  },
  createDocument: (title = 'Untitled', parentId?: string | null) =>
    request<DocumentDTO>('/documents', {
      method: 'POST',
      body: JSON.stringify({ title, ...(parentId ? { parentId } : {}) }),
    }),
  deleteDocument: (id: string) => request<void>(`/documents/${id}`, { method: 'DELETE' }),
  search: (q: string) =>
    request<SearchResultDTO[]>(`/documents/search?q=${encodeURIComponent(q)}`),
  /** Every visible document at once — used by the move picker. */
  listAllDocuments: () => request<DocumentDTO[]>('/documents?flat=1'),
  moveDocument: (id: string, parentId: string | null) =>
    request<DocumentDTO>(`/documents/${id}/parent`, {
      method: 'PATCH',
      body: JSON.stringify({ parentId }),
    }),
  listApiKeys: () => request<ApiKeyDTO[]>('/keys'),
  createApiKey: (name: string) =>
    request<CreatedApiKeyDTO>('/keys', { method: 'POST', body: JSON.stringify({ name }) }),
  revokeApiKey: (id: string) => request<void>(`/keys/${id}`, { method: 'DELETE' }),
  listTrash: () => request<TrashEntryDTO[]>('/documents/trash'),
  /** Irreversible: removes the row and its Yjs content. */
  permanentlyDelete: (id: string) =>
    request<void>(`/documents/${id}/permanent`, { method: 'DELETE' }),
  getDocument: (id: string) => request<DocumentDTO>(`/documents/${id}`),
  /** Ancestors, root first — for opening a document whose place in the tree is unknown. */
  getDocumentPath: (id: string) => request<DocumentDTO[]>(`/documents/${id}/path`),
  restoreDocument: (id: string) =>
    request<DocumentDTO>(`/documents/${id}/restore`, { method: 'POST' }),
  setVisibility: (id: string, visibility: Visibility) =>
    request<DocumentDTO>(`/documents/${id}/visibility`, {
      method: 'PATCH',
      body: JSON.stringify({ visibility }),
    }),
  /** Multipart, so no JSON content type: fetch writes the boundary itself. */
  uploadAttachment: async (documentId: string, file: File): Promise<AttachmentDTO> => {
    const form = new FormData();
    form.append('file', file, file.name);
    const res = await send(`/documents/${documentId}/attachments`, { method: 'POST', body: form });
    if (!res.ok) throw await failure(res, 'Upload failed');
    return (await res.json()) as AttachmentDTO;
  },
  /** Newest first. Content is fetched per version, never for the whole list. */
  listVersions: (documentId: string) => request<DocumentVersionDTO[]>(`/documents/${documentId}/versions`),
  getVersion: (documentId: string, versionId: string) =>
    request<DocumentVersionContentDTO>(`/documents/${documentId}/versions/${versionId}`),
  /** Keep the document as it stands right now. */
  saveVersion: (documentId: string) =>
    request<DocumentVersionDTO>(`/documents/${documentId}/versions`, { method: 'POST' }),
  /** A CRDT edit on the server; open editors receive it over the socket. */
  restoreVersion: (documentId: string, versionId: string) =>
    request<DocumentContentDTO>(`/documents/${documentId}/versions/${versionId}/restore`, { method: 'POST' }),
  attachmentUsage: () => request<AttachmentUsageDTO>('/attachments/usage'),
  listAttachments: (documentId: string) =>
    request<DocumentAttachmentDTO[]>(`/documents/${documentId}/attachments`),
  deleteAttachment: (id: string) => request<void>(`/attachments/${id}`, { method: 'DELETE' }),
  downloadAttachment: async (id: string): Promise<{ blob: Blob; filename: string | null }> => {
    const res = await send(`/attachments/${id}`);
    if (!res.ok) throw await failure(res, 'Download failed');
    return { blob: await res.blob(), filename: filenameFrom(res.headers.get('content-disposition')) };
  },
};
