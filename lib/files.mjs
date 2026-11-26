/**
 * File references in Bots messages: a person points a bot at files of this computer. A bot is not tied
 * to one folder, so any file may be referenced: one of the folder the conversation works in by its path
 * there, any other by its full path. A reference is the file's full, real path and a name for show (its
 * path in the conversation's folder when it is inside). Nothing of the file is read here: the bot that
 * gets the reference reads the file with its own tools, so a teammate working in another folder opens
 * the same file.
 */
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

/** File references one message carries at most. */
export const MAX_MESSAGE_FILES = 10;
/** Files the picker lists at most for one search. */
export const MAX_LISTED_FILES = 50;
/** Directory entries one search looks at, and how deep it goes: a huge folder answers with what it found. */
const MAX_VISITED = 20000;
const MAX_DEPTH = 12;
const MAX_PATH = 1024;
/** Folders a search does not enter (their files can still be referenced by path). */
const SKIPPED = new Set(['node_modules']);

const slashed = (p) => p.split(sep).join('/');
/** A typed path with `~` as the person's home folder. */
const homed = (p) => (p === '~' ? homedir() : p.startsWith('~/') || p.startsWith(`~${sep}`) ? resolve(homedir(), p.slice(2)) : p);
const isFolder = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};
/** Whether the real path `real` lies inside the real folder `base`. */
const within = (base, real) => real.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);

/** A file reference as a message or a task keeps it (`{path, name}`), or null when it is not one. */
export function cleanFileRef(ref) {
  if (!ref || typeof ref !== 'object') return null;
  const path = typeof ref.path === 'string' ? ref.path : '';
  if (!path || path.length > MAX_PATH || path.includes('\0') || /[\r\n]/.test(path) || !isAbsolute(path)) return null;
  const name = typeof ref.name === 'string' && ref.name.trim() && !/[\r\n\0]/.test(ref.name) ? ref.name.trim().slice(0, MAX_PATH) : path;
  return { path, name };
}

/** A list of file references, without bad ones or repeats (by path): the newest ten. */
export function fileRefs(list) {
  const seen = new Map();
  for (const ref of (Array.isArray(list) ? list : []).map(cleanFileRef).filter(Boolean)) seen.set(ref.path, ref);
  return [...seen.values()].slice(-MAX_MESSAGE_FILES);
}

/**
 * The reference of the file `rel` names: its path in the folder `root` (the one the conversation works
 * in), or a full path anywhere on this computer (`~` is the home folder). Its name for show is its path
 * in `root` when it lies inside, else its full path. Refused: a file that is not there (moved or deleted)
 * and anything that is not a file.
 */
export function resolveFile(root, rel) {
  const asked = typeof rel === 'string' ? rel.trim() : '';
  if (!asked || asked.length > MAX_PATH || asked.includes('\0') || /[\r\n]/.test(asked)) throw new Error('name a file by its path');
  const typed = homed(asked);
  const full = isAbsolute(typed);
  let base = '';
  try {
    base = realpathSync(root);
  } catch {
    if (!full) throw new Error(`the folder ${root} is gone: name the file by its full path`);
  }
  let real;
  try {
    real = realpathSync(full ? typed : resolve(base, typed));
  } catch {
    throw new Error(`no file ${asked}: it was moved or deleted`);
  }
  if (!isFile(real)) throw new Error(`${asked} is not a file`);
  return { path: real, name: slashed(base && within(base, real) ? relative(base, real) : real) };
}

/** The references of the files `rels` name (see `resolveFile`); more than ten are refused. */
export function resolveFiles(root, rels) {
  const list = [...new Set((Array.isArray(rels) ? rels : rels === undefined || rels === null || rels === '' ? [] : [rels]).map((r) => (typeof r === 'string' ? r.trim() : r)))];
  if (list.length > MAX_MESSAGE_FILES) throw new Error(`a message carries at most ${MAX_MESSAGE_FILES} file references`);
  return fileRefs(list.map((rel) => resolveFile(root, rel)));
}

/**
 * The files of the folder `root` whose path has every word of `query` (any case), for the picker:
 * `{files: string[], truncated}`, paths inside the folder with `/`, the closest first (the name itself
 * matches, then the one closer to the top). Hidden entries (a leading dot), `node_modules` and links are left
 * out, and a very large folder is searched only so far (`truncated`).
 */
export function listFiles(root, query = '', { limit = MAX_LISTED_FILES } = {}) {
  const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const whole = words.join(' ');
  let base;
  try {
    base = realpathSync(root);
  } catch {
    return { files: [], truncated: false };
  }
  const found = [];
  let visited = 0;
  let truncated = false;
  let level = [''];
  for (let depth = 0; level.length && depth <= MAX_DEPTH && !truncated; depth += 1) {
    const next = [];
    for (const dir of level) {
      let entries = [];
      try {
        entries = readdirSync(dir ? resolve(base, dir) : base, { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const e of entries) {
        if (e.name.startsWith('.') || SKIPPED.has(e.name)) continue;
        visited += 1;
        if (visited > MAX_VISITED) {
          truncated = true;
          break;
        }
        const rel = dir ? `${dir}/${e.name}` : e.name;
        if (e.isDirectory()) next.push(rel);
        else if (e.isFile() && words.every((w) => rel.toLowerCase().includes(w))) found.push(rel);
      }
      if (truncated) break;
    }
    if (depth === MAX_DEPTH && next.length) truncated = true;
    level = next;
  }
  const rank = (rel) => (whole && rel.slice(rel.lastIndexOf('/') + 1).toLowerCase().includes(whole) ? 0 : 1);
  const depthOf = (rel) => rel.split('/').length;
  const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  found.sort((a, b) => rank(a) - rank(b) || depthOf(a) - depthOf(b) || byName(a.toLowerCase(), b.toLowerCase()) || byName(a, b));
  return { files: found.slice(0, Math.max(0, limit)), truncated: truncated || found.length > limit };
}

/**
 * What the picker shows for what the person typed: `{root, files, truncated, elsewhere}`, the files (as
 * `listFiles` gives them) of the folder `root`. That is the conversation's folder `base`; another folder
 * the person chose (`dir`, a full path); or, when a full path is typed (`/…`, `~/…`), the folder it
 * names, searched by what follows the part of the path that exists: `~/docs/plan` lists the files of
 * `~/docs` with `plan` in their path. A typed path that is a file is that one file, a hidden one too.
 * `elsewhere`: `root` is not the conversation's folder, so its files are referenced by their full paths.
 */
export function pickerFiles(base, { q = '', dir = '' } = {}) {
  const typed = homed(String(q ?? '').trim());
  const chosen = homed(String(dir ?? '').trim());
  let root = chosen && isAbsolute(chosen) ? chosen : base;
  let words = String(q ?? '');
  let only = '';
  if (typed && isAbsolute(typed) && typed.length <= MAX_PATH && !typed.includes('\0')) {
    const rest = [];
    root = resolve(typed);
    if (isFile(root)) only = basename(root);
    while (!isFolder(root)) {
      const up = dirname(root);
      if (up === root) break;
      rest.unshift(basename(root));
      root = up;
    }
    words = rest.join(' ');
  }
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  const elsewhere = real(root) !== real(base);
  return only ? { root, files: [only], truncated: false, elsewhere } : { root, ...listFiles(root, words), elsewhere };
}

/**
 * The line after a message's words that names the files the person referenced, by their full paths.
 * One that is no longer there says so (`gone`, by default checked now).
 */
export function fileNoteText(refs, { gone = (ref) => !existsSync(ref.path) } = {}) {
  const list = refs.map((r) => `${r.path}${gone(r) ? ' (not there now: moved or deleted)' : ''}`).join(', ');
  const one = refs.length === 1;
  return `[${one ? 'File referenced' : `${refs.length} files referenced`}: ${list}. The person points you to ${one ? 'this file' : 'these files'} on this computer: read ${one ? 'it' : 'them'} at ${one ? 'this full path' : 'these full paths'} (your working folder may be another one). A task or message you send a teammate from here carries ${one ? 'the reference' : 'the references'} by itself.]`;
}
