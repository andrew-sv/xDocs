/**
 * The storage quota arithmetic.
 *
 * A pure-logic test, because the interesting cases — exactly at the limit, one
 * byte over, an empty store — cannot be provoked over HTTP without restarting
 * the server with a tiny quota.
 */
import { check } from '@xdocs/test-support/harness';
import { formatBytes, quotaRefusal } from '@xdocs/shared';

const MB = 1024 * 1024;

check(
  'an upload well inside the quota is allowed',
  quotaRefusal(10 * MB, 1 * MB, 200 * MB) === null,
);
check(
  'an upload landing exactly on the limit is allowed',
  quotaRefusal(199 * MB, 1 * MB, 200 * MB) === null,
);
check('one byte past the limit is refused', quotaRefusal(199 * MB, 1 * MB + 1, 200 * MB) !== null);
check('a first upload into an empty store is allowed', quotaRefusal(0, 5 * MB, 200 * MB) === null);
check(
  'a file larger than the whole quota is refused',
  quotaRefusal(0, 500 * MB, 200 * MB) !== null,
);

const refusal = quotaRefusal(150 * MB, 60 * MB, 200 * MB) ?? '';
check('the refusal says what the limit is', refusal.includes('200.0 MB'));
check('and how much is already used', refusal.includes('150.0 MB'));
check('and what to do about it', /delete some files/i.test(refusal));

check('bytes are shown as bytes', formatBytes(512) === '512 B');
check('kilobytes as kilobytes', formatBytes(2048) === '2 KB');
check('megabytes with one decimal', formatBytes(3.25 * MB) === '3.3 MB');
check('gigabytes with one decimal', formatBytes(2 * 1024 * MB) === '2.0 GB');
