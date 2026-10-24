/**
 * Which sidebar list responses may reach the screen (#72).
 *
 * The rules here each exist because of a real race (#22, #28), and used to be
 * interleaved with everything else in App.tsx, where only the browser suite
 * could reach them. Nothing in this file knows about React: `useDocumentList`
 * wires it in, and `listFreshness.test.mjs` drives it with promises resolved
 * in whatever order a scenario needs.
 *
 * A list response is applied only when, at the moment it arrives:
 *
 * - **the session it was fetched under is still current** — checked before
 *   the fetch is sent and again after it returns;
 * - **it is still for the level on screen** — two level fetches can be in
 *   flight at once (open a document while the root list is still loading).
 *   Without this guard a slower EARLIER response overwrites the newer one,
 *   leaving the list pinned to a level nobody is looking at — and the sidebar
 *   stuck on its loading state;
 * - **no local change happened since it was sent** (`invalidate`) — creating
 *   a document while the FIRST list fetch is outstanding is the same level, so
 *   that response would land afterwards and wipe the row just added — the new
 *   document open but missing from the sidebar;
 * - **it is not older than the list on screen.** "Older" is the server's read
 *   time (x-list-as-of), not the order fetches were sent: under load the
 *   server answers out of order, and a list sent later but read earlier used
 *   to land last and hide a document just restored.
 *
 * Fetches deliberately do not cancel each other. Every ping from the server
 * starts one (#22), and when each new fetch retired the last, a steady stream
 * of pings meant no response ever landed and the sidebar froze.
 */

/** What a list row needs for unsaved titles to be laid over it. */
export interface TitledRow {
  id: string;
  title: string;
}

/** A level's rows plus the server time they were read at (x-list-as-of). */
export interface LevelResponse<Row> {
  rows: Row[];
  asOf: number;
}

/** How long a typed title outranks fetched rows that disagree with it. */
export const UNSAVED_TITLE_TTL_MS = 30_000;

export class ListFreshness {
  /*
   * The level a response must still be for to be applied. Kept current from
   * every render, so a fetch that is already running sees where the user is
   * NOW rather than where they were when it started.
   */
  private level: string | null;

  /** Bumped by every local change; a fetch sent before the bump is retired. */
  private changes = 0;

  /** The list on screen: which level, and the server time it was read at. */
  private shown: { level: string | null; asOf: number } | null = null;

  /*
   * Whether this account is on its way out, or already gone.
   *
   * Everything fetched here is scoped to the signed-in account, so once
   * sign-out starts nothing it reads may reach the screen. It lives here, not
   * in React state, because the fetches that have to see it are already
   * running and hold a stale closure.
   *
   * A sequence number compared across the await is NOT enough, and that was
   * the first attempt at this: a refetch STARTING during sign-out reads the
   * number after the bump and still carries the token, which is cleared a
   * moment later. It then agrees with itself and lands. What matters is not
   * which session a response belongs to but whether any session is still
   * current.
   */
  private ended = false;

  /*
   * Titles typed in this tab that the server has not stored yet.
   *
   * The title column is written on the collab server's debounced save, so a
   * list fetched in the meantime still carries the old title — and since any
   * change anywhere now triggers a refetch (#22), one can land at any moment.
   * Applied as-is, it flipped a title being typed back to "Untitled". An entry
   * goes once a fetched row agrees with it, or after 30s as a backstop (the
   * save itself pings, so agreement normally comes within seconds).
   */
  private readonly unsaved = new Map<string, { title: string; at: number }>();

  constructor(level: string | null = null) {
    this.level = level;
  }

  /** The level now on screen. */
  setLevel(level: string | null): void {
    this.level = level;
  }

  /** A local change: retire every list fetch already in flight. */
  invalidate(): void {
    this.changes += 1;
  }

  /*
   * Latched BEFORE sign-out awaits anything, so no list read from then on
   * reaches the screen — neither one already in flight nor one starting inside
   * the sign-out itself (#28).
   */
  endSession(): void {
    this.ended = true;
  }

  /*
   * There is a session again, so reads may reach the screen once more.
   * Without this, signing back in after a sign-out would load nothing.
   */
  resumeSession(): void {
    this.ended = false;
  }

  get sessionEnded(): boolean {
    return this.ended;
  }

  /**
   * Fetch `level` and return its rows if they may be applied, or null if the
   * response has been overtaken. Nothing is fetched at all once the session
   * has ended. A rejection from `fetch` propagates untouched.
   *
   * A non-null result has been recorded as the list on screen, and has unsaved
   * titles laid over it — the caller must apply it.
   */
  async load<Row extends TitledRow>(
    level: string | null,
    fetch: (level: string | null) => Promise<LevelResponse<Row>>,
    now: () => number = Date.now,
  ): Promise<Row[] | null> {
    if (this.ended) return null;
    const changesAtStart = this.changes;
    const { rows, asOf } = await fetch(level);
    if (this.ended) return null; // signed out meanwhile
    if (this.level !== level) return null; // navigated elsewhere
    if (this.changes !== changesAtStart) return null; // fetched before a local change
    const shown = this.shown;
    if (shown?.level === level && asOf < shown.asOf) return null; // older than what is shown
    this.shown = { level, asOf };
    return this.withUnsavedTitles(rows, now());
  }

  /** Record a title typed here, ahead of the server's debounced save. */
  noteTitle(id: string, title: string, at: number = Date.now()): void {
    this.unsaved.set(id, { title, at });
  }

  /** `rows` with every still-unsaved title laid over the fetched one. */
  withUnsavedTitles<Row extends TitledRow>(rows: Row[], now: number = Date.now()): Row[] {
    const pending = this.unsaved;
    return rows.map((row) => {
      const typed = pending.get(row.id);
      if (!typed) return row;
      if (row.title === typed.title || now - typed.at > UNSAVED_TITLE_TTL_MS) {
        pending.delete(row.id);
        return row;
      }
      return { ...row, title: typed.title };
    });
  }
}
