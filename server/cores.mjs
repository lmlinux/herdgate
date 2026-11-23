import { readdir } from 'node:fs/promises';
import path from 'node:path';

/** The invoking user's runtime directory, never a machine-wide core list. */
export function defaultSocketDir(env = process.env, uid = process.getuid?.() ?? 0) {
  return path.join(env.XDG_RUNTIME_DIR || `/run/user/${uid}`, 'herdr-core');
}

/** Parse an optional comma-separated core allowlist. */
export function parseCoreList(value = '') {
  return [...new Set(value.split(',').map((name) => name.trim()).filter(Boolean))];
}

/** Enumerate public <name>.sock API endpoints; holder sockets are internal. */
export async function discoverCores(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isSocket()
      && entry.name.endsWith('.sock')
      && !entry.name.includes('.holder.')
      && entry.name.length > '.sock'.length)
    .map((entry) => entry.name.slice(0, -'.sock'.length))
    .sort((a, b) => a.localeCompare(b));
}

/** Share each in-flight scan so timer/API callers cannot apply stale results. */
export function createCoreRefresher(directory, discover = discoverCores) {
  let pending = null;
  return () => {
    if (!pending) {
      pending = discover(directory).finally(() => {
        pending = null;
      });
    }
    return pending;
  };
}
