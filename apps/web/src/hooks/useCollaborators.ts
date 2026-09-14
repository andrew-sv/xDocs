import type { HocuspocusProvider } from '@hocuspocus/provider';
import { useEffect, useState } from 'react';
import type { Collaborator } from '../lib/identity';

/**
 * Everyone else currently in this document.
 *
 * Read from the same awareness state the carets are drawn from, so presence
 * needs no channel of its own: a person is "here" exactly when their editor is
 * open, and they disappear when the socket closes, without anything having to
 * be cleaned up.
 *
 * Two things are deliberately collapsed:
 *
 * - **Tabs.** Awareness has one entry per connection, so someone with the
 *   document open twice would otherwise be two people in the list. They are
 *   keyed by account id instead.
 * - **You.** Your own tabs are excluded by account id, not by client id — the
 *   list answers "who ELSE is here", and your other window is not someone else.
 */
export function useCollaborators(
  provider: HocuspocusProvider | null,
  me: Collaborator | null,
): Collaborator[] {
  const [others, setOthers] = useState<Collaborator[]>([]);
  const myId = me?.id ?? null;

  useEffect(() => {
    const awareness = provider?.awareness;
    if (!awareness) {
      setOthers([]);
      return;
    }

    const read = () => {
      const byPerson = new Map<string, Collaborator>();
      awareness.getStates().forEach((state) => {
        const user = (state as { user?: Partial<Collaborator> }).user;
        // A state exists from the moment a peer connects, before its editor has
        // published anything, so an entry without a user is normal — not a bug.
        if (!user?.id || !user.name || !user.color) return;
        if (user.id === myId) return;
        byPerson.set(user.id, user as Collaborator);
      });
      // Stable order, so the row does not reshuffle as people type.
      setOthers([...byPerson.values()].sort((a, b) => a.name.localeCompare(b.name)));
    };

    read();
    awareness.on('change', read);
    return () => {
      awareness.off('change', read);
    };
  }, [provider, myId]);

  return others;
}
