/**
 * Collaborator identity: the parts that are pure functions (#45).
 *
 * The browser suite proves two accounts see each other's real names; this
 * covers what that cannot reach cheaply — that a colour is genuinely a function
 * of the id and not of when the module loaded, and the odd shapes a display
 * name arrives in.
 */
import { collaboratorFrom, colorFor, initialsFor } from './src/lib/identity.ts';

let fail = 0;
const ck = (l, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}`);
  if (!ok) fail++;
};

// --- colour is derived, not drawn ------------------------------------------
ck('the same id always gives the same colour', colorFor('user-abc') === colorFor('user-abc'));
ck('and still does on a later call', colorFor('user-abc') === colorFor('user-abc'));
ck('different ids generally differ', colorFor('user-abc') !== colorFor('user-xyz'));
ck('a colour is always a hex value', /^#[0-9a-f]{6}$/i.test(colorFor('anything')));
ck('the empty id still yields a colour rather than undefined', /^#/.test(colorFor('')));

/*
 * Spread matters: a hash that funnelled everyone into one colour would pass
 * every test above and make the carets useless.
 */
const spread = new Set(Array.from({ length: 200 }, (_, i) => colorFor(`user-${i}`)));
ck('200 ids use more than one colour', spread.size > 1);
ck('and reach most of the palette', spread.size >= 5);

// --- initials ---------------------------------------------------------------
ck('two words give two initials', initialsFor('Ada Lovelace') === 'AL');
ck('one word gives one', initialsFor('Ada') === 'A');
ck('three words use the first and last', initialsFor('Ada King Lovelace') === 'AL');
ck('extra whitespace is ignored', initialsFor('  Ada   Lovelace  ') === 'AL');
ck('lowercase is upper-cased', initialsFor('ada lovelace') === 'AL');
ck('an empty name does not crash', initialsFor('') === '?');
ck('nor does whitespace alone', initialsFor('   ') === '?');
ck('a non-Latin name keeps its own letters', initialsFor('Ада Лавлейс') === 'АЛ');

// --- building the identity from a session ----------------------------------
const user = { id: 'u1', name: 'Ada Lovelace', email: 'ada@example.com' };
ck('a signed-in user becomes a collaborator', collaboratorFrom(user)?.name === 'Ada Lovelace');
ck('carrying their id, so tabs can be collapsed', collaboratorFrom(user)?.id === 'u1');
ck('and the colour their id maps to', collaboratorFrom(user)?.color === colorFor('u1'));

ck(
  'a nameless account falls back to the email local part',
  collaboratorFrom({ id: 'u2', name: null, email: 'grace@example.com' })?.name === 'grace',
);
ck(
  'a blank name is treated as no name',
  collaboratorFrom({ id: 'u3', name: '   ', email: 'alan@example.com' })?.name === 'alan',
);
ck(
  'with neither, something sayable rather than empty',
  collaboratorFrom({ id: 'u4' })?.name === 'Someone',
);

/*
 * Null, not a placeholder: DocumentEditor publishes nothing until it has a real
 * identity, so nobody sees a caret that is about to rename itself.
 */
ck('no session yields no collaborator', collaboratorFrom(null) === null);
ck('nor does an undefined one', collaboratorFrom(undefined) === null);
ck('nor a user without an id', collaboratorFrom({ name: 'Ghost' }) === null);

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);
