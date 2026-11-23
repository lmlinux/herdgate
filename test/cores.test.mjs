import assert from 'node:assert/strict';
import test from 'node:test';
import { createCoreRefresher, defaultSocketDir, parseCoreList } from '../server/cores.mjs';

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

test('concurrent discovery callers share one in-flight scan', async () => {
  const pending = [];
  const refresh = createCoreRefresher('/unused', () => new Promise((resolve) => {
    pending.push(resolve);
  }));
  const first = refresh();
  const concurrent = refresh();
  assert.strictEqual(concurrent, first);
  assert.equal(pending.length, 1);
  pending[0](['alpha']);
  assert.deepEqual(await Promise.all([first, concurrent]), [['alpha'], ['alpha']]);

  const later = refresh();
  assert.equal(pending.length, 2);
  pending[1](['alpha', 'zeta']);
  assert.deepEqual(await later, ['alpha', 'zeta']);
});
