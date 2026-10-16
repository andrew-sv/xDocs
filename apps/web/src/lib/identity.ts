/**
 * Who you are to everyone else in a document.
 *
 * Drawn from the signed-in account, not invented per tab. This used to be a
 * random animal and colour chosen when the module loaded (#45), which predated
 * sign-in and outlived it: the same person was "Otter 42" in one tab and "Vole
 * 71" in the next, became somebody new on every reload, and never showed the
 * name they had actually signed in with.
 *
 * `id` is what makes a person a person here rather than a connection: awareness
 * has one entry per open tab, so the same account in two windows is two
 * entries, and the collaborator list collapses them on this.
 */
export type Collaborator = {
  id: string;
  name: string;
  color: string;
};

/**
 * Colours far enough apart to tell two carets apart at a glance, and dark
 * enough for white text to sit on them.
 */
const COLORS = ['#e5484d', '#0090ff', '#12a594', '#f76b15', '#8e4ec6', '#e93d82', '#46a758'];

/**
 * The same person gets the same colour everywhere — every tab, every device,
 * every reload — because it is derived from their id rather than drawn at
 * random. Two people can still collide on one, which is why the caret carries a
 * name as well; colour alone was never the identity.
 */
export function colorFor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  return COLORS[Math.abs(hash) % COLORS.length]!;
}

/** The signed-in account, as much of it as a caret needs. */
type SessionUser = { id: string; name?: string | null; email?: string | null };

/**
 * Build the identity to publish, or null before the session has loaded.
 *
 * Null rather than a placeholder on purpose: a caret labelled "Someone" that
 * turns into a name a moment later is worse than one that appears once it can
 * be right. See DocumentEditor, which publishes this to awareness.
 */
export function collaboratorFrom(user: SessionUser | null | undefined): Collaborator | null {
  if (!user?.id) return null;
  // The email's local part is a better guess than "Someone" for an account
  // that never set a name — Google always supplies one, password sign-up need
  // not have.
  const name = user.name?.trim() || user.email?.split('@')[0] || 'Someone';
  return { id: user.id, name, color: colorFor(user.id) };
}

/** Up to two letters for an avatar: initials where there are two words. */
export function initialsFor(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0]!.slice(0, 1).toUpperCase();
  return (words[0]!.slice(0, 1) + words[words.length - 1]!.slice(0, 1)).toUpperCase();
}

/** Platform-appropriate label for the undo shortcut. */
export const undoShortcutLabel =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘Z' : 'Ctrl+Z';
