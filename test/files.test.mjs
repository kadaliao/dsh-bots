import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { cleanFileRef, fileNoteText, fileRefs, listFiles, MAX_MESSAGE_FILES, pickerFiles, resolveFile, resolveFiles } from '../lib/files.mjs';

/** A conversation's folder with a few files, a file beside it, and links that lead out of it. */
function workspace(t) {
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'bots-files-')));
  t.after(() => rmSync(top, { recursive: true, force: true }));
  const root = join(top, 'ws');
  for (const dir of ['docs/specs', 'src', '.git', 'node_modules/dep']) mkdirSync(join(root, dir), { recursive: true });
  for (const file of ['README.md', 'docs/plan.md', 'docs/specs/plan-v2.md', 'src/app.js', 'src/Planner.js', '.env', '.git/config', 'node_modules/dep/plan.js']) writeFileSync(join(root, file), file);
  writeFileSync(join(top, 'secret.txt'), 'outside');
  symlinkSync(join(top, 'secret.txt'), join(root, 'link.txt'));
  symlinkSync(top, join(root, 'up'));
  return { top, root };
}

test('a reference is the real, full path of a file; one of the conversation\'s folder is shown by its path there', (t) => {
  const { root } = workspace(t);
  assert.deepEqual(resolveFile(root, 'docs/plan.md'), { path: join(root, 'docs', 'plan.md'), name: 'docs/plan.md' });
  assert.deepEqual(resolveFile(root, ' ./docs/../docs/specs/plan-v2.md '), { path: join(root, 'docs', 'specs', 'plan-v2.md'), name: 'docs/specs/plan-v2.md' });
  // A hidden file is not listed, but may be named.
  assert.equal(resolveFile(root, '.env').name, '.env');
  // Named by its full path, a file of the folder is still shown by its path there.
  assert.deepEqual(resolveFile(root, join(root, 'README.md')), { path: join(root, 'README.md'), name: 'README.md' });
  // The folder itself may be reached through a link: the reference is the real path.
  const { top } = workspace(t);
  symlinkSync(join(top, 'ws'), join(top, 'alias'));
  assert.equal(resolveFile(join(top, 'alias'), 'src/app.js').path, join(top, 'ws', 'src', 'app.js'));
});

test('a bot is not tied to a folder: any file of this computer is referenced, by its full path', (t) => {
  const { top, root } = workspace(t);
  const secret = { path: join(top, 'secret.txt'), name: join(top, 'secret.txt') };
  assert.deepEqual(resolveFile(root, join(top, 'secret.txt')), secret);
  // A path from the conversation's folder may leave it, and a link is the file it leads to.
  assert.deepEqual(resolveFile(root, '../secret.txt'), secret);
  assert.deepEqual(resolveFile(root, 'link.txt'), secret);
  assert.deepEqual(resolveFile(root, 'up/secret.txt'), secret);
  // A folder whose name starts like the conversation's is not inside it.
  mkdirSync(join(top, 'ws-other'));
  writeFileSync(join(top, 'ws-other', 'a.txt'), 'x');
  assert.equal(resolveFile(root, '../ws-other/a.txt').name, join(top, 'ws-other', 'a.txt'));
  // A full path stands without the conversation's folder; `~` is the home folder.
  assert.deepEqual(resolveFile(join(top, 'nowhere'), secret.path), secret);
  assert.throws(() => resolveFile(root, '~/no-such-file-of-bots-tests.md'), /no file ~\/no-such-file-of-bots-tests\.md: it was moved or deleted/);
  assert.throws(() => resolveFile(root, '~'), /~ is not a file/);
});

test('refused: a folder, a file that is gone, a path that is none', (t) => {
  const { top, root } = workspace(t);
  assert.throws(() => resolveFile(root, 'docs'), /docs is not a file/);
  assert.throws(() => resolveFile(root, '.'), /is not a file/);
  assert.throws(() => resolveFile(root, top), /is not a file/);
  assert.throws(() => resolveFile(root, 'docs/gone.md'), /moved or deleted/);
  assert.throws(() => resolveFile(root, join(top, 'gone.md')), /moved or deleted/);
  for (const bad of ['', '  ', 'a\nb', 'a\0b', null, undefined, 7, {}]) assert.throws(() => resolveFile(root, bad), /name a file by its path/);
  assert.throws(() => resolveFile(join(top, 'nowhere'), 'README.md'), /the folder .* is gone: name the file by its full path/);
  // Moved after it was picked: the message is refused, saying so.
  renameSync(join(root, 'docs', 'plan.md'), join(root, 'docs', 'plan-old.md'));
  assert.throws(() => resolveFile(root, 'docs/plan.md'), /no file docs\/plan\.md: it was moved or deleted/);
});

test('a message names at most ten files, once each', (t) => {
  const { top, root } = workspace(t);
  assert.deepEqual(resolveFiles(root, undefined), []);
  assert.deepEqual(resolveFiles(root, []), []);
  assert.deepEqual(resolveFiles(root, 'README.md').map((f) => f.name), ['README.md']);
  assert.deepEqual(resolveFiles(root, ['README.md', 'src/app.js', './README.md', 'README.md', join(root, 'README.md')]).map((f) => f.name), ['README.md', 'src/app.js']);
  assert.deepEqual(resolveFiles(root, ['link.txt', join(top, 'secret.txt'), '../secret.txt']).map((f) => f.path), [join(top, 'secret.txt')], 'one file, however it is named');
  const many = Array.from({ length: MAX_MESSAGE_FILES + 1 }, (_, i) => `f${i}.txt`);
  for (const f of many) writeFileSync(join(root, f), f);
  assert.throws(() => resolveFiles(root, many), /at most 10 file references/);
  assert.equal(resolveFiles(root, many.slice(1)).length, 10);
  assert.throws(() => resolveFiles(root, ['README.md', 'docs']), /is not a file/, 'one bad path refuses the message');
});

test('the picker lists the files of a folder: by words of the path, the closest first, without hidden ones, node_modules or links', (t) => {
  const { root } = workspace(t);
  assert.deepEqual(listFiles(root), { files: ['README.md', 'docs/plan.md', 'src/app.js', 'src/Planner.js', 'docs/specs/plan-v2.md'], truncated: false });
  // The name itself matches first; any case.
  assert.deepEqual(listFiles(root, 'PLAN').files, ['docs/plan.md', 'src/Planner.js', 'docs/specs/plan-v2.md']);
  assert.deepEqual(listFiles(root, 'docs v2').files, ['docs/specs/plan-v2.md']);
  assert.deepEqual(listFiles(root, 'src').files, ['src/app.js', 'src/Planner.js']);
  assert.deepEqual(listFiles(root, 'secret').files, [], 'nothing behind a link');
  assert.deepEqual(listFiles(root, 'env').files, []);
  assert.deepEqual(listFiles(root, '', { limit: 2 }), { files: ['README.md', 'docs/plan.md'], truncated: true });
  assert.deepEqual(listFiles(join(root, 'nowhere')), { files: [], truncated: false });
});

test('the picker starts in the conversation\'s folder, and looks in a chosen folder or where a typed path leads', (t) => {
  const { top, root } = workspace(t);
  assert.deepEqual(pickerFiles(root), { root, files: ['README.md', 'docs/plan.md', 'src/app.js', 'src/Planner.js', 'docs/specs/plan-v2.md'], truncated: false, elsewhere: false });
  assert.deepEqual(pickerFiles(root, { q: 'docs v2' }), { root, files: ['docs/specs/plan-v2.md'], truncated: false, elsewhere: false });
  // Another folder the person chose: its files are referenced by their full paths (`elsewhere`).
  assert.deepEqual(pickerFiles(root, { dir: top, q: 'secret' }), { root: top, files: ['secret.txt'], truncated: false, elsewhere: true });
  assert.equal(pickerFiles(root, { dir: root }).elsewhere, false, 'the conversation\'s own folder');
  assert.equal(pickerFiles(root, { dir: 'docs' }).root, root, 'a folder is chosen by its full path');
  // A typed full path: the folder it names, searched by what follows the part that exists.
  assert.deepEqual(pickerFiles(root, { q: join(root, 'docs') }), { root: join(root, 'docs'), files: ['plan.md', 'specs/plan-v2.md'], truncated: false, elsewhere: true });
  assert.deepEqual(pickerFiles(root, { q: join(root, 'docs', 'spe') }), { root: join(root, 'docs'), files: ['specs/plan-v2.md'], truncated: false, elsewhere: true });
  assert.deepEqual(pickerFiles(root, { q: join(top, 'nowhere', 'plan') }).root, top);
  assert.deepEqual(pickerFiles(root, { q: join(top, 'nowhere', 'plan') }).files, [], 'both words have to be in the path');
  assert.deepEqual(pickerFiles(root, { q: join(top, 'ws', 'plan') }).files, ['docs/plan.md', 'src/Planner.js', 'docs/specs/plan-v2.md']);
  // A typed path that is a file is that file, a hidden one too; a typed path wins over a chosen folder.
  assert.deepEqual(pickerFiles(root, { q: join(root, '.env') }), { root, files: ['.env'], truncated: false, elsewhere: false });
  assert.deepEqual(pickerFiles(root, { q: ` ${join(top, 'secret.txt')} `, dir: join(root, 'src') }), { root: top, files: ['secret.txt'], truncated: false, elsewhere: true });
  assert.equal(pickerFiles(root, { q: '~' }).root, homedir());
});

test('references are kept clean: full paths only, the newest ten, one per file', () => {
  assert.equal(cleanFileRef(null), null);
  assert.equal(cleanFileRef({ path: 'docs/plan.md' }), null);
  assert.equal(cleanFileRef({ path: '/a/b\nc' }), null);
  assert.deepEqual(cleanFileRef({ path: '/a/b.md', name: ' b.md ', extra: 1 }), { path: '/a/b.md', name: 'b.md' });
  assert.deepEqual(cleanFileRef({ path: '/a/b.md' }), { path: '/a/b.md', name: '/a/b.md' });
  assert.deepEqual(fileRefs('nope'), []);
  assert.deepEqual(fileRefs([{ path: '/a/1' }, { path: 'x' }, { path: '/a/2', name: '2' }, { path: '/a/1', name: 'one' }]), [{ path: '/a/1', name: 'one' }, { path: '/a/2', name: '2' }]);
  assert.equal(fileRefs(Array.from({ length: 14 }, (_, i) => ({ path: `/a/${i}` }))).length, 10);
});

test('the line a bot reads names the files by their full paths, and says when one is gone', (t) => {
  const { root } = workspace(t);
  const plan = resolveFile(root, 'docs/plan.md');
  const app = resolveFile(root, 'src/app.js');
  assert.equal(fileNoteText([plan]), `[File referenced: ${plan.path}. The person points you to this file on this computer: read it at this full path (your working folder may be another one). A task or message you send a teammate from here carries the reference by itself.]`);
  rmSync(app.path);
  assert.match(fileNoteText([plan, app]), new RegExp(`^\\[2 files referenced: ${plan.path.replace(/[.\\/]/g, '\\$&')}, ${app.path.replace(/[.\\/]/g, '\\$&')} \\(not there now: moved or deleted\\)\\. The person points you to these files`));
});
