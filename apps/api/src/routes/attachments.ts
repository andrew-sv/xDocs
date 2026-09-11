import { MAX_ATTACHMENT_BYTES, attachmentHref, type AttachmentDTO } from '@xdocs/shared';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { canAccessDocument } from '../db/access.js';
import { getDb } from '../db/index.js';
import { attachments } from '../db/schema.js';

type Variables = { userId: string; email: string; authMethod: 'session' | 'api-key' };

/*
 * Ids are checked before they reach SQL: a malformed one would otherwise fail
 * the uuid cast and surface as a 500 instead of the 404 it is.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Room for the multipart framing around the file; the file itself is checked exactly. */
const MULTIPART_OVERHEAD = 64 * 1024;

const TOO_LARGE = `Files are limited to ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`;

/** Only ever a display name and a download suggestion, never a path. */
function cleanFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 255);
  return cleaned || 'file';
}

/** The type is echoed back on download, so only a well-formed bare MIME type survives. */
function cleanContentType(type: string): string {
  const bare = type.split(';')[0]!.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(bare)
    ? bare
    : 'application/octet-stream';
}

/** RFC 6266: an ASCII fallback for old clients, the real name for everyone else. */
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

type AttachmentColumns = Pick<
  typeof attachments.$inferSelect,
  'id' | 'documentId' | 'filename' | 'contentType' | 'size' | 'createdAt'
>;

function toDTO(row: AttachmentColumns): AttachmentDTO {
  return {
    id: row.id,
    documentId: row.documentId,
    filename: row.filename,
    contentType: row.contentType,
    size: row.size,
    createdAt: row.createdAt.toISOString(),
    href: attachmentHref(row.id),
  };
}

/*
 * Access follows the document, and nothing else: anyone who can open a
 * document can attach to it and download from it — the same rule the content
 * routes and the collab socket apply. Every refusal is a 404, never a 403: a
 * stranger's file should be indistinguishable from one that does not exist,
 * and the web client treats 403 as "this account is not allowed in".
 */
export const attachmentsRoute = new Hono<{ Variables: Variables }>()
  .post(
    '/documents/:id/attachments',
    // Refuses an oversized upload while it streams in, rather than after
    // buffering all of it.
    bodyLimit({
      maxSize: MAX_ATTACHMENT_BYTES + MULTIPART_OVERHEAD,
      onError: (c) => c.json({ error: TOO_LARGE }, 413),
    }),
    async (c) => {
      const userId = c.get('userId');
      const id = c.req.param('id');
      if (!UUID.test(id) || !(await canAccessDocument(userId, id))) {
        return c.json({ error: 'Document not found' }, 404);
      }

      const body = await c.req.parseBody().catch(() => null);
      const file = body?.file;
      if (!(file instanceof File)) {
        return c.json({ error: 'Expected a multipart form with a "file" field.' }, 400);
      }
      if (file.size > MAX_ATTACHMENT_BYTES) return c.json({ error: TOO_LARGE }, 413);

      const [row] = await getDb()
        .insert(attachments)
        .values({
          documentId: id,
          filename: cleanFilename(file.name),
          contentType: cleanContentType(file.type),
          size: file.size,
          data: Buffer.from(await file.arrayBuffer()),
          createdBy: userId,
        })
        .returning({
          id: attachments.id,
          documentId: attachments.documentId,
          filename: attachments.filename,
          contentType: attachments.contentType,
          size: attachments.size,
          createdAt: attachments.createdAt,
        });
      return c.json(toDTO(row!), 201);
    },
  )

  /*
   * Download. Always as an attachment, with sniffing off and a sandboxing CSP,
   * so an uploaded HTML or SVG file can never run as a page on the API's
   * origin — whatever type it claims to be.
   */
  .get('/attachments/:id', async (c) => {
    const userId = c.get('userId');
    const id = c.req.param('id');
    if (!UUID.test(id)) return c.json({ error: 'Not found' }, 404);

    const [row] = await getDb().select().from(attachments).where(eq(attachments.id, id));
    // A trashed document is not accessible, so neither are its files — until
    // it is restored.
    if (!row || !(await canAccessDocument(userId, row.documentId))) {
      return c.json({ error: 'Not found' }, 404);
    }

    return c.body(new Uint8Array(row.data), 200, {
      'content-type': row.contentType,
      'content-length': String(row.size),
      'content-disposition': contentDisposition(row.filename),
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'private, no-store',
    });
  });
