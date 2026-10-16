import type {
  DocumentContentDTO,
  DocumentDTO,
  SearchResultDTO,
  Visibility,
  WriteBlockInput,
} from '@xdocs/shared';

export type XdocsClientOptions = { baseUrl: string; token: string };

/**
 * An error whose message is meant to be read by a model.
 *
 * Tool failures are shown to Claude, which then decides what to do next, so
 * "not found, or not visible to this key" leads somewhere and
 * "Request failed with status code 404" does not.
 */
export class XdocsError extends Error {}

export class XdocsClient {
  constructor(private readonly options: XdocsClientOptions) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${this.options.baseUrl.replace(/\/$/, '')}/api${path}`;
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.options.token}`,
          // Better Auth rejects state-changing requests without an Origin, and
          // Node's fetch sends none.
          origin: this.options.baseUrl,
          ...init?.headers,
        },
      });
    } catch (cause) {
      // The server being down is the most common failure by far, and the raw
      // cause ("fetch failed") says nothing about which server or why.
      throw new XdocsError(
        `Could not reach the xDocs API at ${this.options.baseUrl}. Is it running?`,
        { cause },
      );
    }

    if (!response.ok) throw new XdocsError(await describe(response));
    return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
  }

  listDocuments(parentId?: string | null, flat?: boolean): Promise<DocumentDTO[]> {
    const query = flat ? '?flat=1' : parentId ? `?parent=${encodeURIComponent(parentId)}` : '';
    return this.request<DocumentDTO[]>(`/documents${query}`);
  }

  search(query: string): Promise<SearchResultDTO[]> {
    return this.request<SearchResultDTO[]>(`/documents/search?q=${encodeURIComponent(query)}`);
  }

  getDocument(id: string): Promise<DocumentDTO> {
    return this.request<DocumentDTO>(`/documents/${id}`);
  }

  getContent(id: string): Promise<DocumentContentDTO> {
    return this.request<DocumentContentDTO>(`/documents/${id}/content`);
  }

  createDocument(title: string, parentId?: string | null): Promise<DocumentDTO> {
    return this.request<DocumentDTO>('/documents', {
      method: 'POST',
      body: JSON.stringify({ title, ...(parentId ? { parentId } : {}) }),
    });
  }

  replaceContent(
    id: string,
    blocks: WriteBlockInput[],
    title?: string,
  ): Promise<DocumentContentDTO> {
    return this.request<DocumentContentDTO>(`/documents/${id}/content`, {
      method: 'PUT',
      body: JSON.stringify({ blocks, ...(title === undefined ? {} : { title }) }),
    });
  }

  appendContent(id: string, blocks: WriteBlockInput[]): Promise<DocumentContentDTO> {
    return this.request<DocumentContentDTO>(`/documents/${id}/content`, {
      method: 'POST',
      body: JSON.stringify({ blocks }),
    });
  }

  move(id: string, parentId: string | null): Promise<DocumentDTO> {
    return this.request<DocumentDTO>(`/documents/${id}/parent`, {
      method: 'PATCH',
      body: JSON.stringify({ parentId }),
    });
  }

  setVisibility(id: string, visibility: Visibility): Promise<DocumentDTO> {
    return this.request<DocumentDTO>(`/documents/${id}/visibility`, {
      method: 'PATCH',
      body: JSON.stringify({ visibility }),
    });
  }
}

/**
 * Turn an HTTP status into something worth reading.
 *
 * Never includes the key, and never the raw body for an auth failure — the
 * point is to say what to do about it.
 */
async function describe(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  const detail = typeof body?.error === 'string' ? ` (${body.error})` : '';
  switch (response.status) {
    case 401:
      return 'The xDocs API key is invalid or has been revoked. Create a new one in the app under “API keys”.';
    case 403:
      return `Refused: only the owner of a document may do that${detail}`;
    case 404:
      return 'No such document, or it is not visible to this API key.';
    case 400:
      return `The request was rejected as invalid${detail}`;
    default:
      return `The xDocs API returned ${response.status}${detail}`;
  }
}
