/**
 * Every Make write goes through the filesystem bridge into the open session's
 * sandbox working copy. Make persists source only through its own Save, which
 * creates a new Make version, and the CLI never triggers it: a reopened file
 * is rebuilt from the last saved version and session writes are gone. See
 * _vaults/figma-cli/wiki/make/persistence.md.
 */

export const SESSION_ONLY_NOTE = 'Written to the open Make session only. It is lost when the file is reopened unless it is saved in Make, which creates a new version.';

// Fields every completed write reports; never claim that the project was saved.
export const sessionOnly = Object.freeze({ persistence: 'session-only', note: SESSION_ONLY_NOTE });

/** Refuse a Make write before any connection unless --session-only was given. */
export function requireSessionOnly(command, options) {
  if (options?.sessionOnly === true) return;
  const error = new Error(`make ${command} refused before any write: Make writes are session-only and are lost when the file is reopened unless saved in Make. Pass --session-only to accept this (see REFERENCE.md, "Make writes are session-only").`);
  error.code = 'MAKE_SESSION_ONLY_REQUIRED';
  throw error;
}
