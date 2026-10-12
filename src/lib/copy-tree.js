import { constants, copyFileSync, lstatSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Copy new package/skill trees using explicit paths. Refuse symlinks and existing
// destinations; callers stage copies before replacing managed installations.
export function copyTree(source, destination) {
  const stat = lstatSync(source);
  if (stat.isDirectory()) {
    mkdirSync(destination, { mode: stat.mode & 0o777 });
    for (const name of readdirSync(source)) copyTree(join(source, name), join(destination, name));
  } else if (stat.isFile()) {
    copyFileSync(source, destination, constants.COPYFILE_EXCL);
  } else {
    throw new Error('Refusing to copy a symlink or special file');
  }
}
