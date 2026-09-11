import { createApiKeySchema, type ApiKeyDTO } from '@xdocs/shared';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { generateApiKey } from '../apiKeys.js';
import { getDb } from '../db/index.js';
import { apiKeys } from '../db/schema.js';

type Variables = { userId: string; email: string; authMethod: 'session' | 'api-key' };

export const keysRoute = new Hono<{ Variables: Variables }>()
  /*
   * Key management is session-only.
   *
   * A key that could mint more keys would turn one leaked credential into
   * permanent access that revoking the original does not undo. Signing in is
   * the only way to change what credentials exist.
   */
  .use('*', async (c, next) => {
    if (c.get('authMethod') !== 'session') {
      return c.json({ error: 'API keys cannot manage API keys — sign in to do that.' }, 403);
    }
    return next();
  })

  .get('/', async (c) => {
    const rows = await getDb()
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        prefix: apiKeys.prefix,
        createdAt: apiKeys.createdAt,
        lastUsedAt: apiKeys.lastUsedAt,
      })
      .from(apiKeys)
      .where(and(eq(apiKeys.userId, c.get('userId')), isNull(apiKeys.revokedAt)))
      .orderBy(desc(apiKeys.createdAt));

    const keys: ApiKeyDTO[] = rows.map((row) => ({
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      createdAt: row.createdAt.toISOString(),
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    }));
    return c.json(keys);
  })

  .post('/', async (c) => {
    const body = createApiKeySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: body.error.flatten() }, 400);

    const { key, hash, prefix } = generateApiKey();
    const [row] = await getDb()
      .insert(apiKeys)
      .values({ name: body.data.name, hash, prefix, userId: c.get('userId') })
      .returning();

    // The only time the key exists outside the client's hands. It is not
    // recoverable afterwards — that is the point of storing only the hash.
    return c.json(
      {
        key,
        id: row!.id,
        name: row!.name,
        prefix: row!.prefix,
        createdAt: row!.createdAt.toISOString(),
        lastUsedAt: null,
      },
      201,
    );
  })

  .delete('/:id', async (c) => {
    // Ownership is in the where clause, so someone else's key id revokes
    // nothing rather than revoking theirs.
    const revoked = await getDb()
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(apiKeys.id, c.req.param('id')),
          eq(apiKeys.userId, c.get('userId')),
          isNull(apiKeys.revokedAt),
        ),
      )
      .returning({ id: apiKeys.id });

    if (revoked.length === 0) return c.json({ error: 'Key not found' }, 404);
    return c.body(null, 204);
  });
