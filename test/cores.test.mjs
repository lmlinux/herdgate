import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultSocketDir, parseCoreList } from '../server/cores.mjs';

test('socket discovery uses only the invoking user runtime directory', () => {
  assert.equal(
    defaultSocketDir({ XDG_RUNTIME_DIR: '/run/user/123' }, 999),
    '/run/user/123/herdr-core',
  );
  assert.equal(defaultSocketDir({}, 123), '/run/user/123/herdr-core');
  assert.equal(defaultSocketDir({}, 0), '/run/user/0/herdr-core');
});

test('configured core names are generic, trimmed and deduplicated', () => {
  assert.deepEqual(parseCoreList('alpha, team-west_2,alpha,另一个'), [
    'alpha',
    'team-west_2',
    '另一个',
  ]);
  assert.deepEqual(parseCoreList(''), []);
});
