import { McpServer } from '@modelcontextprotocol/server';
import type { ContentBlockDTO, DocumentContentDTO, DocumentDTO } from '@xdocs/shared';
import * as z from 'zod';
import { XdocsClient, XdocsError, type XdocsClientOptions } from './client.js';

/*
 * Every tool is a thin translation of one REST route.
 *
 * Deliberately thin: the API is the security boundary, and going through it
 * over HTTP — rather than importing the database or the route handlers — means
 * an MCP client cannot reach anything its API key could not already reach with
 * curl. There is no second permission model to keep in step with the first.
 */

const documentIdSchema = z.string().describe('The document id (a uuid).');
const blocksSchema = z
  .array(z.union([z.string(), z.object({ type: z.literal('code'), text: z.string() })]))
  .describe(
    'Blocks, in order. A string is a paragraph; a newline inside one starts another paragraph block. ' +
      'Links are written as [label](https://example.com) and become real links; a backslash escapes a ' +
      'literal bracket. {"type": "code", "text": "..."} is ONE code block that keeps its newlines and ' +
      'indentation and renders in a monospace font — use it for code, commands, config and ASCII diagrams ' +
      '(its text is verbatim, so link notation stays as typed).',
  );

/** Documents are summarised as text so the model can read a result directly. */
function describeDocument(doc: DocumentDTO): string {
  const where = doc.parentId ? `nested under ${doc.parentId}` : 'top level';
  return `${doc.title || 'Untitled'} — ${doc.id} (${doc.visibility}, ${where})`;
}

function describeBlock(block: ContentBlockDTO, index: number): string {
  // Fenced, so code reads as code and its layout survives the numbering.
  const text = block.type === 'code' ? `\`\`\`\n${block.text}\n\`\`\`` : block.text;
  return `${index + 1}. ${text}`;
}

function describeContent(content: DocumentContentDTO): string {
  const body = content.blocks.map(describeBlock).join('\n');
  return `# ${content.title || 'Untitled'}\n(${content.id})\n\n${body || '(empty)'}`;
}

const ok = (text: string, structured?: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text }],
  ...(structured ? { structuredContent: structured } : {}),
});

export function createXdocsServer(options: XdocsClientOptions): McpServer {
  const client = new XdocsClient(options);
  const server = new McpServer({ name: 'xdocs', version: '0.1.0' });

  server.registerTool(
    'search_documents',
    {
      title: 'Search documents',
      description:
        'Full-text search across document titles and body text. Returns matches with the path each one lives under and a snippet, best matches first.',
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .describe('Words to search for. The last word matches as a prefix.'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query }) => {
      const hits = await client.search(query);
      if (hits.length === 0) return ok(`Nothing matches “${query}”.`);
      const text = hits
        .map((hit) => {
          const path = hit.path.map((p) => p.title || 'Untitled').join(' / ');
          // The snippet marks matches with [[ ]]; strip them for reading.
          const snippet = hit.snippet.replace(/\[\[|\]\]/g, '').trim();
          return `- ${hit.document.title || 'Untitled'} (${hit.document.id})${
            path ? `\n  in: ${path}` : ''
          }${snippet ? `\n  …${snippet}…` : ''}`;
        })
        .join('\n');
      return ok(`${hits.length} result(s) for “${query}”:\n${text}`);
    },
  );

  server.registerTool(
    'list_documents',
    {
      title: 'List documents',
      description:
        "List documents. By default the top level; pass parentId for one document's children, or flat: true for every document you can see at once.",
      inputSchema: z.object({
        parentId: z.string().nullish().describe('List the children of this document.'),
        flat: z
          .boolean()
          .optional()
          .describe('Return the whole visible tree instead of one level.'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ parentId, flat }) => {
      const docs = await client.listDocuments(parentId ?? null, flat === true);
      if (docs.length === 0) return ok('No documents here.');
      return ok(docs.map((doc) => `- ${describeDocument(doc)}`).join('\n'));
    },
  );

  server.registerTool(
    'read_document',
    {
      title: 'Read a document',
      description:
        'Read a document’s title and the text of every block, in order. Links come back as ' +
        '[label](href) and can be written back unchanged; code blocks are shown fenced with ```.',
      inputSchema: z.object({ id: documentIdSchema }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id }) => {
      const content = await client.getContent(id);
      return ok(describeContent(content), {
        id: content.id,
        title: content.title,
        // The same shape the write tools take, so a read can be written back.
        blocks: content.blocks.map((block) =>
          block.type === 'code' ? { type: 'code', text: block.text } : block.text,
        ),
      });
    },
  );

  server.registerTool(
    'create_document',
    {
      title: 'Create a document',
      description:
        'Create a document, optionally with its first blocks and nested under a parent. New documents are private to the key’s owner; a nested one copies its parent’s visibility.',
      inputSchema: z.object({
        title: z.string().min(1).max(200),
        blocks: blocksSchema.optional(),
        parentId: z.string().nullish().describe('Create it as a sub-document of this document.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ title, blocks, parentId }) => {
      const doc = await client.createDocument(title, parentId ?? null);
      // Two calls behind one tool: "write me a document about X" should not
      // need the model to remember to make the second one.
      if (blocks && blocks.length > 0) {
        const content = await client.replaceContent(doc.id, blocks);
        return ok(`Created ${describeDocument(doc)}\n\n${describeContent(content)}`);
      }
      return ok(`Created ${describeDocument(doc)}`);
    },
  );

  server.registerTool(
    'append_to_document',
    {
      title: 'Append to a document',
      description: 'Add blocks to the end of a document, leaving what is already there alone.',
      inputSchema: z.object({ id: documentIdSchema, blocks: blocksSchema }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ id, blocks }) => ok(describeContent(await client.appendContent(id, blocks))),
  );

  server.registerTool(
    'replace_document_content',
    {
      title: 'Replace a document’s content',
      description:
        'Replace every block in a document, and optionally its title. The previous text is gone from the document, though it remains undoable in the editor.',
      inputSchema: z.object({
        id: documentIdSchema,
        blocks: blocksSchema,
        title: z.string().max(200).optional(),
      }),
      // Destructive: it removes text someone may have written.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ id, blocks, title }) =>
      ok(describeContent(await client.replaceContent(id, blocks, title))),
  );

  server.registerTool(
    'move_document',
    {
      title: 'Move a document',
      description:
        'Move a document under another one, or to the top level with parentId: null. Sub-documents move with it. Visibility is unchanged, so a public document under a private parent stops being visible to others.',
      inputSchema: z.object({
        id: documentIdSchema,
        parentId: z.string().nullable().describe('The new parent, or null for the top level.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ id, parentId }) => ok(`Moved: ${describeDocument(await client.move(id, parentId))}`),
  );

  server.registerTool(
    'set_document_visibility',
    {
      title: 'Set visibility',
      description:
        'Make a document private (its owner only) or public (every signed-in user, who can also edit it). Only the owner may change this.',
      inputSchema: z.object({
        id: documentIdSchema,
        visibility: z.enum(['private', 'public']),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ id, visibility }) =>
      ok(`Now ${visibility}: ${describeDocument(await client.setVisibility(id, visibility))}`),
  );

  return server;
}

/**
 * There is deliberately no delete, restore or permanent-delete tool.
 *
 * A mistaken delete is a surprise found later rather than a dialog declined,
 * so removing a document stays a human action in the UI, where it has a
 * confirmation and an undo.
 */

export { XdocsError };
