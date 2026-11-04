import { isIgnored, parseIgnore } from './git-tree.js';
import { PROJECT_EXCLUDES } from './make-project.js';

// Make's project inventory never reads PROJECT_EXCLUDES paths, tracked or not
// (`inventoryProject` skips them: .npmrc can hold registry secrets). A saved
// or sandbox tree may still track one, so a deploy comparison of the working
// copy with a git tree must not read its absence from the working copy as a
// change. Make's own tracker and the saved-versus-head blob check cover it.
const rules = parseIgnore(PROJECT_EXCLUDES.join('\n'));
export const isUninventoried = path => String(path).split('/')
  .some((_, index, parts) => isIgnored(rules, parts.slice(0, index + 1).join('/'), index < parts.length - 1));
export const notInventoried = working => path => isUninventoried(path) && !working.has(path);
