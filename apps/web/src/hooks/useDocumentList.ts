import type { DocumentDTO } from '@xdocs/shared';
import { useCallback, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { api } from '../lib/api';
import { ForbiddenError, UnauthorizedError } from '../lib/auth';
import { ListFreshness } from '../lib/listFreshness';

/** Where `refresh()` reports how the fetch went; all are App's state setters. */
export interface ListReport {
  setLocked: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setDeniedReason: Dispatch<SetStateAction<string | null>>;
}

/**
 * The sidebar's rows for `level`, kept fresh by the rules in
 * `lib/listFreshness.ts` (#72).
 *
 * This is only the React wiring: every decision about whether a response may
 * land is made by `ListFreshness`, which is tested without React.
 */
export function useDocumentList(
  level: string | null,
  { setLocked, setError, setDeniedReason }: ListReport,
) {
  // One instance for the life of the app; never replaced, so it is never a
  // dependency that changes.
  const [freshness] = useState(() => new ListFreshness(level));
  // Every render, so a fetch already running sees the level on screen now.
  freshness.setLevel(level);

  const [documents, setDocuments] = useState<DocumentDTO[]>([]);
  /*
   * Which level the loaded list belongs to.
   *
   * Without this the sidebar keeps rendering the previous level's rows until
   * the new fetch returns — you see the old tree for a moment after clicking
   * into a document. Comparing it against the current level tells us the list
   * is stale, so we show a loading state instead of the wrong documents.
   */
  const [documentsParentId, setDocumentsParentId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const rows = await freshness.load(level, api.listLevel);
      if (rows === null) return;
      setDocuments(rows);
      setDocumentsParentId(level);
      setLocked(false);
      setError(null);
    } catch (e) {
      // A gated deployment answers 401 until a valid password is supplied;
      // that is a login prompt, not an error to render.
      if (e instanceof UnauthorizedError) {
        setLocked(true);
        return;
      }
      if (e instanceof ForbiddenError) {
        // Signed in, but not on the allowlist — say so instead of looping.
        setDeniedReason(e.message);
        setLocked(true);
        return;
      }
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [freshness, level, setLocked, setError, setDeniedReason]);

  const invalidateList = useCallback(() => freshness.invalidate(), [freshness]);
  const withUnsavedTitles = useCallback(
    (rows: DocumentDTO[]) => freshness.withUnsavedTitles(rows),
    [freshness],
  );
  const noteTitle = useCallback(
    (id: string, title: string) => freshness.noteTitle(id, title),
    [freshness],
  );
  const endSession = useCallback(() => freshness.endSession(), [freshness]);
  const resumeSession = useCallback(() => freshness.resumeSession(), [freshness]);
  /** Read at call time, so a fetch already running sees a sign-out. */
  const sessionEnded = useCallback(() => freshness.sessionEnded, [freshness]);

  return {
    documents,
    setDocuments,
    documentsParentId,
    refresh,
    invalidateList,
    withUnsavedTitles,
    noteTitle,
    endSession,
    resumeSession,
    sessionEnded,
  };
}
