// mend: one patch tool for the four edit formats AI models write (unified diff,
// SEARCH/REPLACE blocks, V4A patches, JSON edit calls), built to SPEC.md.
// Node 22, standard library only. Run as: node main.ts [options] [PATCH]
// The last lines hand a grading trial over to runner.ts when MAKEFUN_ENV_URL
// is set; everything above them is the CLI itself.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) { this.line = line; }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) { this.code = code; this.path = path; }
}

const blank = (s: string): boolean => s.trim() === '';

/** Patch text to patch lines (SPEC 3): split at \n, one trailing \r off each. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\')
    && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines plus its own break kind and whether it ends with one. */
interface FileModel { br: string; lines: string[]; fin: boolean }

function splitFile(text: string): FileModel {
  if (text === '') return { br: '\n', lines: [], fin: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const fin = text.endsWith(br);
  if (fin) parts.pop();
  return { br, lines: parts, fin };
}

function joinFile(m: FileModel): string {
  return m.lines.length === 0 ? '' : m.lines.join(m.br) + (m.fin ? m.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted). */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try { if (statSync(p).isFile()) v = readFileSync(p, 'utf8'); } catch { v = null; }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/* ---------------- matching (SPEC 5) ---------------- */

type Item = { kind: 'ctx' | 'old' | 'new'; text: string; backslash?: boolean; fromEmpty?: boolean };

const rstrip = (s: string): string => s.replace(/[ \t]+$/, '');
const bstrip = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const lead = (s: string): string => /^[ \t]*/.exec(s)![0]!;

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rstrip(a) === rstrip(b);
  return bstrip(a) === bstrip(b);
}

function occursAt(lines: string[], pos: number, o: string[], tier: number): boolean {
  for (let k = 0; k < o.length; k += 1) if (!lineEq(lines[pos + k]!, o[k]!, tier)) return false;
  return true;
}

/** First tier (0 exact, 1 trailing-ws, 2 both-ws) at which o occurs, from `from`. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0, eofOnly = false):
  { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions: number[] = [];
    for (let i = from; i + o.length <= lines.length; i += 1) {
      if (eofOnly && i + o.length !== lines.length) continue;
      if (occursAt(lines, i, o, tier)) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** Lines to write for items matched at `pos`: context keeps the file's own
 *  line; at tier 2 the other lines are re-indented from O's indent to the
 *  file's first matched line's indent. */
function buildN(items: Item[], fileLines: string[], pos: number, o: string[], tier: number): string[] {
  const out: string[] = [];
  const f = o.length > 0 ? lead(fileLines[pos] ?? '') : '';
  const p = o.length > 0 ? lead(o[0]!) : '';
  let oi = 0;
  for (const it of items) {
    if (it.kind === 'ctx') { out.push(fileLines[pos + oi]!); oi += 1; }
    else if (it.kind === 'old') { oi += 1; }
    else if (tier === 2 && it.text.trim() !== '' && it.text.startsWith(p)) out.push(f + it.text.slice(p.length));
    else out.push(it.text);
  }
  return out;
}

const oldOf = (items: Item[]): string[] => items.filter((i) => i.kind !== 'new').map((i) => i.text);
const newOf = (items: Item[]): string[] => items.filter((i) => i.kind !== 'old').map((i) => i.text);

/* ---------------- format detection (SPEC 4) ---------------- */

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ')
    || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ---------------- unified diffs (SPEC 6) ---------------- */

interface Hunk { a: number; items: Item[] }
interface Section {
  diffOld?: string; diffNew?: string; rawOld?: string; rawNew?: string;
  renFrom?: string; renTo?: string; isCreate: boolean; isDelete: boolean; hunks: Hunk[];
}

/** Path text of a --- / +++ header line: after the marker, to the first tab. */
function headerPath(line: string): string {
  let p = line.slice(4).split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}
const stripAB = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  const fresh = (): Section => {
    const s: Section = { isCreate: false, isDelete: false, hunks: [] };
    sections.push(s);
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^a\/(.+) b\/(.+)$/.exec(line.slice(11));
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: Number(m[1]), items: [] };
      i += 1;
      while (i < lines.length) {
        const l = lines[i]!;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (l === '') { hunk.items.push({ kind: 'ctx', text: '', fromEmpty: true }); i += 1; continue; }
        const c = l[0]!;
        if (c === ' ') hunk.items.push({ kind: 'ctx', text: l.slice(1) });
        else if (c === '-') hunk.items.push({ kind: 'old', text: l.slice(1) });
        else if (c === '+') hunk.items.push({ kind: 'new', text: l.slice(1) });
        else if (c === '\\') {
          const prev = hunk.items[hunk.items.length - 1];
          if (prev !== undefined) prev.backslash = true;
          i += 1;
          continue;
        } else break;
        i += 1;
      }
      while (hunk.items.length > 0 && hunk.items[hunk.items.length - 1]!.fromEmpty === true) hunk.items.pop();
      cur.hunks.push(hunk);
      continue;
    }
    const pairAhead = line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');
    if (pairAhead && !(cur !== null && cur.hunks.length === 0 && cur.rawOld === undefined)) {
      cur = fresh();
      cur.rawOld = headerPath(line);
      cur.rawNew = headerPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      // Section header: names and flags; everything else here is ignored.
      if (line.startsWith('--- ')) {
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        cur.rawOld = headerPath(line);
        cur.rawNew = headerPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      if (line.startsWith('+++ ')) { if (cur.rawNew === undefined) cur.rawNew = headerPath(line); i += 1; continue; }
      if (line.startsWith('rename from ')) { cur.renFrom = stripAB(line.slice(12).trim()); i += 1; continue; }
      if (line.startsWith('rename to ')) { cur.renTo = stripAB(line.slice(10).trim()); i += 1; continue; }
      if (line.startsWith('new file mode')) { cur.isCreate = true; i += 1; continue; }
      if (line.startsWith('deleted file mode')) { cur.isDelete = true; i += 1; continue; }
      i += 1;
      continue;
    }
    i += 1; // prose and other lines outside sections are ignored
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

/** Apply one section's hunks to a model; `path` names no-match failures. */
function applyHunks(model: FileModel, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const hunk of hunks) {
    const o = oldOf(hunk.items);
    if (o.length === 0) {
      const add = newOf(hunk.items);
      const pos = Math.max(0, Math.min(hunk.a + d, model.lines.length));
      const atEnd = pos === model.lines.length;
      model.lines.splice(pos, 0, ...add);
      if (atEnd && add.length > 0) {
        const lastNew = [...hunk.items].reverse().find((x) => x.kind === 'new');
        model.fin = !(lastNew?.backslash === true);
      }
      d += add.length;
      continue;
    }
    const found = findTier(model.lines, o, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = hunk.a - 1 + d;
    let pos = found.positions[0]!;
    for (const q of found.positions) {
      if (Math.abs(q - target) < Math.abs(pos - target)) pos = q;
    }
    const built = buildN(hunk.items, model.lines, pos, o, found.tier);
    const atEnd = pos + o.length === model.lines.length;
    model.lines.splice(pos, o.length, ...built);
    if (atEnd) {
      const last = [...hunk.items].reverse().find((x) => x.kind !== 'old');
      model.fin = last === undefined ? true : !(last.backslash === true);
    }
    d += built.length - o.length;
  }
}

function unifiedEdit(s: Section, strict: boolean): Edit {
  const oldP = s.rawOld ?? s.renFrom ?? s.diffOld;
  const newP = s.rawNew ?? s.renTo ?? s.diffNew;
  const create = s.isCreate || s.rawOld === '/dev/null';
  const del = s.isDelete || s.rawNew === '/dev/null';
  return (tree) => {
    if (create) {
      const p = newP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const texts: string[] = [];
      let lastPlus: Item | undefined;
      for (const h of s.hunks) for (const it of h.items) {
        if (it.kind === 'new') { texts.push(it.text); lastPlus = it; }
      }
      tree.now.set(p, texts.length === 0 ? '' : texts.join('\n') + (lastPlus?.backslash === true ? '' : '\n'));
      return;
    }
    if (del) {
      const p = oldP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const o = oldP!;
    const n = newP!;
    if (!safe(o)) throw new Fail('unsafe', o);
    if (!safe(n)) throw new Fail('unsafe', n);
    const src = tree.get(o);
    if (src === null) throw new Fail('missing', o);
    if (n !== o && tree.get(n) !== null) throw new Fail('exists', n);
    const model = splitFile(src);
    applyHunks(model, s.hunks, strict, o);
    if (n !== o) {
      tree.now.set(o, null);
      tree.now.set(n, joinFile(model));
      tree.moves.push([o, n]);
    } else {
      tree.now.set(o, joinFile(model));
    }
  };
}

/* ---------------- SEARCH/REPLACE blocks (SPEC 7) ---------------- */

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  interface Block { path: string; oldLines: string[]; newLines: string[] }
  const blocks: Block[] = [];
  let prevEnd = 0;
  let lastPath: string | undefined;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i += 1; continue; }
    const at = i;
    let path: string | undefined;
    for (let j = at - 1; j >= prevEnd; j -= 1) {
      const l = lines[j]!;
      if (!blank(l) && !l.trim().startsWith('```')) { path = l.trim(); break; }
    }
    path ??= lastPath;
    if (path === undefined) throw new Exit2(`error: parse ${at + 1}`);
    let eq = -1;
    for (let k = at + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '=======') { eq = k; break; }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let k = eq + 1; k < lines.length; k += 1) {
        if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') { rep = k; break; }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${at + 1}`);
    blocks.push({ path, oldLines: lines.slice(at + 1, eq), newLines: lines.slice(eq + 1, rep) });
    lastPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return blocks.map((b) => (tree: Tree) => {
    const p = b.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (b.oldLines.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const src = tree.get(p);
    if (src === null) throw new Fail('missing', p);
    const model = splitFile(src);
    const found = findTier(model.lines, b.oldLines, strict);
    if (found === null) throw new Fail('no-match', p);
    if (found.positions.length > 1) throw new Fail('ambiguous', p);
    const pos = found.positions[0]!;
    const items: Item[] = b.newLines.map((text) => ({ kind: 'new' as const, text }));
    model.lines.splice(pos, b.oldLines.length, ...buildN(items, model.lines, pos, b.oldLines, found.tier));
    tree.now.set(p, joinFile(model));
  });
}

/* ---------------- V4A patches (SPEC 8) ---------------- */

interface Chunk { anchor: string | null; items: Item[]; eof: boolean }
type VSection =
  | { kind: 'add'; path: string; texts: string[] }
  | { kind: 'del'; path: string }
  | { kind: 'upd'; path: string; moveTo?: string; chunks: Chunk[] };

const vHead = (l: string): string | null =>
  l.startsWith('*** Add File: ') ? 'add'
    : l.startsWith('*** Delete File: ') ? 'del'
      : l.startsWith('*** Update File: ') ? 'upd' : null;

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) if (!blank(lines[k]!)) { last = k; break; }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) { i += 1; continue; }
    const kind = vHead(line);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const path = line.slice(line.indexOf(': ') + 2).trim();
    // Collect this section's raw lines (with their numbers), to the next head.
    const raw: Array<{ n: number; text: string }> = [];
    let j = i + 1;
    while (j < last && vHead(lines[j]!) === null) { raw.push({ n: j + 1, text: lines[j]! }); j += 1; }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') {
      const texts: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) texts.push(r.text.slice(1));
        else if (r.text === '') texts.push('');
        else throw new Exit2(`error: parse ${r.n}`);
      }
      sections.push({ kind: 'add', path, texts });
    } else if (kind === 'del') {
      for (const r of raw) if (!blank(r.text)) throw new Exit2(`error: parse ${r.n}`);
      sections.push({ kind: 'del', path });
    } else {
      let moveTo: string | undefined;
      let k = 0;
      if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
        moveTo = raw[0]!.text.slice('*** Move to: '.length).trim();
        k = 1;
      }
      const chunks: Chunk[] = [];
      let cur: Chunk | null = null;
      for (; k < raw.length; k += 1) {
        const r = raw[k]!;
        if (r.text === '*** End of File') {
          if (cur !== null) { cur.eof = true; cur = null; }
          continue;
        }
        if (r.text.startsWith('@@')) {
          const anchor = r.text.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, items: [], eof: false };
          chunks.push(cur);
          continue;
        }
        const c = r.text[0];
        if (r.text === '' || c === ' ' || c === '-' || c === '+') {
          if (cur === null) { cur = { anchor: null, items: [], eof: false }; chunks.push(cur); }
          if (r.text === '') cur.items.push({ kind: 'ctx', text: '' });
          else cur.items.push({ kind: c === ' ' ? 'ctx' : c === '-' ? 'old' : 'new', text: r.text.slice(1) });
          continue;
        }
        throw new Exit2(`error: parse ${r.n}`);
      }
      if (chunks.length === 0 && moveTo === undefined) throw new Exit2(`error: parse ${i + 1}`);
      sections.push({ kind: 'upd', path, moveTo, chunks });
    }
    i = j;
  }
  return sections.map((s) => v4aEdit(s, strict));
}

function findAnchor(lines: string[], anchor: string, cursor: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    for (let k = cursor; k < lines.length; k += 1) {
      if (lineEq(lines[k]!, anchor, tier)) return k;
    }
  }
  return null;
}

function v4aEdit(s: VSection, strict: boolean): Edit {
  return (tree) => {
    if (s.kind === 'add') {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, s.texts.length === 0 ? '' : s.texts.join('\n') + '\n');
      return;
    }
    if (s.kind === 'del') {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.moveTo !== undefined && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    const src = tree.get(s.path);
    if (src === null) throw new Fail('missing', s.path);
    if (s.moveTo !== undefined && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    const model = splitFile(src);
    let cursor = 0;
    for (const chunk of s.chunks) {
      if (chunk.anchor !== null) {
        const at = findAnchor(model.lines, chunk.anchor, cursor, strict);
        if (at === null) throw new Fail('no-match', s.path);
        cursor = at + 1;
      }
      const o = oldOf(chunk.items);
      if (o.length === 0) {
        const add = newOf(chunk.items);
        const pos = chunk.eof ? model.lines.length : Math.min(cursor, model.lines.length);
        model.lines.splice(pos, 0, ...add);
        cursor = pos + add.length;
        continue;
      }
      const found = findTier(model.lines, o, strict, cursor, chunk.eof);
      if (found === null) throw new Fail('no-match', s.path);
      const pos = found.positions[0]!;
      const built = buildN(chunk.items, model.lines, pos, o, found.tier);
      model.lines.splice(pos, o.length, ...built);
      cursor = pos + built.length;
    }
    if (s.moveTo !== undefined) {
      tree.now.set(s.path, null);
      tree.now.set(s.moveTo, joinFile(model));
      tree.moves.push([s.path, s.moveTo]);
    } else {
      tree.now.set(s.path, joinFile(model));
    }
  };
}

/* ---------------- JSON edits (SPEC 9) ---------------- */

function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== ''
    && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number'
    && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const m = splitFile(before);
      if (line < 0 || line > m.lines.length) throw new Fail('no-match', p);
      m.lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(m));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try { v = JSON.parse(text); } catch { throw new Exit2(`error: parse ${first + 1}`); }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, idx) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try { e = jsonEdit(JSON.parse(l)); } catch { e = null; }
    if (e === null) throw new Exit2(`error: parse ${idx + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ---------------- invocation, output, atomic write (SPEC 1, 2, 10) ---------------- */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  // Move rows replace the moved pair's D and A rows, and sort by the new path.
  const moveNew = new Map<string, string>();
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && tree.now.get(o) === null
      && tree.original(n) === null && (tree.now.get(n) ?? null) !== null) moveNew.set(n, o);
  }
  const moveOld = new Set(moveNew.values());
  const byBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const rows: Array<{ key: string; text: string }> = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now || moveOld.has(p)) continue;
    if (moveNew.has(p)) rows.push({ key: p, text: `R ${moveNew.get(p)!} -> ${p}` });
    else rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((x, y) => byBytes(x.key, y.key));
  if (!check) {
    for (const p of [...tree.now.keys()].sort(byBytes)) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
