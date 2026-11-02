/** node:fs/promises for the phone: the promises object of fs.ts. */
import { promises } from './fs';
export const { readFile, writeFile, appendFile, mkdir, readdir, stat, lstat, rm, rmdir, unlink, rename, copyFile, access, realpath, mkdtemp, chmod, truncate, constants } = promises;
export default promises;
