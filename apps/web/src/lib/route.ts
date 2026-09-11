/**
 * The open document's place in the URL: `/doc/<id>`, or `/` for none.
 *
 * One route, so the History API is enough; a router library would be a
 * dependency for a regular expression. Vercel already rewrites every path to
 * index.html (vercel.json), and Vite's dev server does the same, so a deep
 * link loads the app.
 */
const DOCUMENT_PATH = /^\/doc\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

/** The document the address bar names, if any. */
export function documentIdFromLocation(): string | null {
  return DOCUMENT_PATH.exec(window.location.pathname)?.[1] ?? null;
}

export function documentPath(id: string | null): string {
  return id ? `/doc/${id}` : '/';
}
