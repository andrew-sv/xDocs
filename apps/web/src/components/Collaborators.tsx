import { initialsFor, type Collaborator } from '../lib/identity';

/** Beyond this the row would crowd the title; the rest become "+N". */
const SHOWN = 3;

type Props = {
  /** Everyone else in the document — see useCollaborators. */
  people: Collaborator[];
};

/**
 * Who else is in this document, as a row of initials in each person's own
 * colour — the same colour their caret is drawn in, so the two read as one
 * thing rather than two unrelated hints.
 *
 * Renders nothing when you are alone, rather than an empty row or a "just you"
 * label: an editor with nobody else in it should look like an ordinary editor.
 */
export function Collaborators({ people }: Props) {
  if (people.length === 0) return null;

  const shown = people.slice(0, SHOWN);
  const overflow = people.length - shown.length;

  return (
    <div
      className="collaborators"
      data-testid="collaborators"
      // The list is decorative next to the carets, but a screen reader gets no
      // presence from those at all, so it is named here.
      aria-label={`Also here: ${people.map((p) => p.name).join(', ')}`}
    >
      {shown.map((person) => (
        <span
          key={person.id}
          className="collaborator"
          data-testid="collaborator"
          style={{ backgroundColor: person.color }}
          title={person.name}
        >
          {initialsFor(person.name)}
        </span>
      ))}
      {overflow > 0 && (
        <span
          className="collaborator collaborator-overflow"
          title={people
            .slice(SHOWN)
            .map((p) => p.name)
            .join(', ')}
        >
          +{overflow}
        </span>
      )}
    </div>
  );
}
