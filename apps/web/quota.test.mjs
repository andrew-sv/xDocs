/**
 * The storage quota arithmetic.
 *
 * A pure-logic test, because the interesting cases — exactly at the limit, one
 * byte over, an empty store — cannot be provoked over HTTP without restarting
 * the server with a tiny quota.
 */
import { formatBytes, quotaRefusal } from '@xdocs/shared';

let fail = 0;
const ck = (l, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}`);
  if (!ok) fail++;
};

const MB = 1024 * 1024;

ck('an upload well inside the quota is allowed', quotaRefusal(10 * MB, 1 * MB, 200 * MB) === null);
ck(
  'an upload landing exactly on the limit is allowed',
  quotaRefusal(199 * MB, 1 * MB, 200 * MB) === null,
);
ck('one byte past the limit is refused', quotaRefusal(199 * MB, 1 * MB + 1, 200 * MB) !== null);
ck('a first upload into an empty store is allowed', quotaRefusal(0, 5 * MB, 200 * MB) === null);
ck('a file larger than the whole quota is refused', quotaRefusal(0, 500 * MB, 200 * MB) !== null);

const refusal = quotaRefusal(150 * MB, 60 * MB, 200 * MB) ?? '';
ck('the refusal says what the limit is', refusal.includes('200.0 MB'));
ck('and how much is already used', refusal.includes('150.0 MB'));
ck('and what to do about it', /delete some files/i.test(refusal));

ck('bytes are shown as bytes', formatBytes(512) === '512 B');
ck('kilobytes as kilobytes', formatBytes(2048) === '2 KB');
ck('megabytes with one decimal', formatBytes(3.25 * MB) === '3.3 MB');
ck('gigabytes with one decimal', formatBytes(2 * 1024 * MB) === '2.0 GB');

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
