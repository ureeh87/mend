// main.ts is mend, the CLI SPEC.md specifies. It does all of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits, the all-or-nothing write, three-tier line matching
// (section 5), unified diffs (section 6), SEARCH/REPLACE blocks (section 7) and V4A patches (section 8).
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful move edits, as [old, new] pairs, in patch order; used for `R` output rows. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
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
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
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
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
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
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Section 3: files and lines
// ---------------------------------------------------------------------------

interface FileParts {
  lines: string[];
  br: string;
  final: boolean;
}

function fileParts(text: string): FileParts {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinParts(lines: string[], br: string, fin: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (fin ? br : '');
}

// ---------------------------------------------------------------------------
// Section 5: matching lines
// ---------------------------------------------------------------------------

const trail = (s: string): string => s.replace(/[ \t]+$/, '');
const both = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const lead = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

/** One line of O or N. Context lines are the same object in both lists. */
interface Entry {
  text: string;
  ctx: boolean;
  oIdx: number; // index of this line in O, for context lines; -1 otherwise
}

function findTier(fileLines: string[], oTexts: string[], strict: boolean, from = 0): { tier: number; occs: number[] } | null {
  if (oTexts.length === 0) return null;
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const tf = t === 0 ? (s: string): string => s : t === 1 ? trail : both;
    const occs: number[] = [];
    for (let i = from; i + oTexts.length <= fileLines.length; i++) {
      let ok = true;
      for (let j = 0; j < oTexts.length; j++) {
        if (tf(fileLines[i + j]!) !== tf(oTexts[j]!)) {
          ok = false;
          break;
        }
      }
      if (ok) occs.push(i);
    }
    if (occs.length > 0) return { tier: t, occs };
  }
  return null;
}

/** Replace the O lines at `pos` with the N lines, per section 5 (context lines from the file, tier-2 re-indent). */
function applyReplace(fileLines: string[], o: Entry[], n: Entry[], pos: number, tier: number): string[] {
  let f = '';
  let p = '';
  if (tier === 2 && o.length > 0) {
    f = lead(fileLines[pos]!);
    p = lead(o[0]!.text);
  }
  const seg = n.map((e) => {
    if (e.ctx) return fileLines[pos + e.oIdx]!;
    if (tier === 2) {
      const t = e.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(p)) return f + t.slice(p.length);
      return t;
    }
    return e.text;
  });
  return [...fileLines.slice(0, pos), ...seg, ...fileLines.slice(pos + o.length)];
}

function plainEntries(texts: string[]): Entry[] {
  return texts.map((t, i) => ({ text: t, ctx: false, oIdx: i }));
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs
// ---------------------------------------------------------------------------

interface BodyItem {
  kind: 'ctx' | 'del' | 'add' | 'bs';
  text: string;
  rawEmpty?: boolean;
}

interface Hunk {
  a: number;
  o: Entry[];
  n: Entry[];
  bsAfterLastCtxPlus: boolean;
  lastAddBs: boolean;
  hasAdd: boolean;
}

interface UniSection {
  oldP: string | null;
  newP: string | null;
  diffOld: string | null;
  diffNew: string | null;
  renameOld: string | null;
  renameNew: string | null;
  hasPair: boolean;
  createFlag: boolean;
  deleteFlag: boolean;
  hunks: Hunk[];
}

function headerPath(line: string): string {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  return t.replace(/^[ \t]+|[ \t]+$/g, '');
}

function cleanPath(p: string): string | null {
  if (p === '/dev/null') return null;
  if (p.startsWith('a/')) return p.slice(2);
  if (p.startsWith('b/')) return p.slice(2);
  return p;
}

function buildON(items: BodyItem[]): { o: Entry[]; n: Entry[] } {
  const o: Entry[] = [];
  const n: Entry[] = [];
  for (const it of items) {
    if (it.kind === 'ctx') {
      const e: Entry = { text: it.text, ctx: true, oIdx: o.length };
      o.push(e);
      n.push(e);
    } else if (it.kind === 'del') {
      o.push({ text: it.text, ctx: false, oIdx: o.length });
    } else if (it.kind === 'add') {
      n.push({ text: it.text, ctx: false, oIdx: -1 });
    }
  }
  return { o, n };
}

function parseHunk(lines: string[], i: number): { hunk: Hunk; next: number } {
  const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(lines[i]!);
  if (!hm) throw new Exit2(`error: parse ${i + 1}`);
  const a = parseInt(hm[1]!, 10);
  let j = i + 1;
  const items: BodyItem[] = [];
  while (j < lines.length) {
    const l = lines[j]!;
    if (l === 'diff --git' || l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      items.push({ kind: 'ctx', text: '', rawEmpty: true });
      j++;
      continue;
    }
    const c = l[0]!;
    if (c === ' ' || c === '-' || c === '+' || c === '\\') {
      items.push({ kind: c === ' ' ? 'ctx' : c === '-' ? 'del' : c === '+' ? 'add' : 'bs', text: c === '\\' ? '' : l.slice(1) });
      j++;
      continue;
    }
    break;
  }
  while (items.length > 0) {
    const last = items[items.length - 1]!;
    if (last.kind === 'ctx' && last.rawEmpty) items.pop();
    else break;
  }
  const { o, n } = buildON(items);
  let bsAfterLastCtxPlus = false;
  for (let k = items.length - 1; k >= 0; k--) {
    if (items[k]!.kind === 'ctx' || items[k]!.kind === 'add') {
      bsAfterLastCtxPlus = items[k + 1] !== undefined && items[k + 1]!.kind === 'bs';
      break;
    }
  }
  let lastAddBs = false;
  let hasAdd = false;
  for (let k = items.length - 1; k >= 0; k--) {
    if (items[k]!.kind === 'add') {
      hasAdd = true;
      lastAddBs = items[k + 1] !== undefined && items[k + 1]!.kind === 'bs';
      break;
    }
  }
  return { hunk: { a, o, n, bsAfterLastCtxPlus, lastAddBs, hasAdd }, next: j };
}

function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): FileParts {
  const parts = fileParts(text);
  let lines = parts.lines;
  let fin = parts.final;
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      const at = Math.min(Math.max(h.a + d, 0), lines.length);
      const atEnd = at === lines.length;
      const ins = h.n.map((e) => e.text);
      lines = [...lines.slice(0, at), ...ins, ...lines.slice(at)];
      if (atEnd) fin = !h.bsAfterLastCtxPlus;
      d += h.n.length;
      continue;
    }
    const found = findTier(lines, h.o.map((e) => e.text), strict);
    if (!found) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let pos = found.occs[0]!;
    let best = Math.abs(pos - target);
    for (const p of found.occs) {
      const dd = Math.abs(p - target);
      if (dd < best) {
        best = dd;
        pos = p;
      }
    }
    const toEnd = pos + h.o.length === lines.length;
    lines = applyReplace(lines, h.o, h.n, pos, found.tier);
    if (toEnd) fin = !h.bsAfterLastCtxPlus;
    d += h.n.length - h.o.length;
  }
  return { lines, br: parts.br, final: fin };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line === 'diff --git' || line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)[ \t]*$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = {
        oldP: null,
        newP: null,
        diffOld: m[1]!,
        diffNew: m[2]!,
        renameOld: null,
        renameNew: null,
        hasPair: false,
        createFlag: false,
        deleteFlag: false,
        hunks: [],
      };
      sections.push(cur);
      inHeader = true;
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (!cur) throw new Exit2(`error: parse ${i + 1}`);
      const r = parseHunk(lines, i);
      cur.hunks.push(r.hunk);
      inHeader = false;
      i = r.next;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur && inHeader && !cur.hasPair) {
        cur.oldP = cleanPath(headerPath(line));
        cur.newP = cleanPath(headerPath(lines[i + 1]!));
        cur.hasPair = true;
        i += 2;
        continue;
      }
      cur = {
        oldP: cleanPath(headerPath(line)),
        newP: cleanPath(headerPath(lines[i + 1]!)),
        diffOld: null,
        diffNew: null,
        renameOld: null,
        renameNew: null,
        hasPair: true,
        createFlag: false,
        deleteFlag: false,
        hunks: [],
      };
      sections.push(cur);
      inHeader = true;
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (cur && inHeader) {
      if (line.startsWith('rename from ')) cur.renameOld = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameNew = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.createFlag = true;
      else if (line.startsWith('deleted file mode')) cur.deleteFlag = true;
      i++;
      continue;
    }
    i++;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => {
    const oldP = s.hasPair ? s.oldP : (s.renameOld ?? s.diffOld);
    const newP = s.hasPair ? s.newP : (s.renameNew ?? s.diffNew);
    return (tree: Tree): void => {
      if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
      if (newP !== null && newP !== oldP && !safe(newP)) throw new Fail('unsafe', newP);
      const isCreate = oldP === null || s.createFlag;
      const isDelete = !isCreate && (newP === null || s.deleteFlag);
      if (isCreate) {
        if (newP === null) return;
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const plus: string[] = [];
        for (const h of s.hunks) for (const e of h.n) if (!e.ctx) plus.push(e.text);
        let fin = true;
        for (let hi = s.hunks.length - 1; hi >= 0; hi--) {
          if (s.hunks[hi]!.hasAdd) {
            fin = !s.hunks[hi]!.lastAddBs;
            break;
          }
        }
        tree.now.set(newP, joinParts(plus, '\n', plus.length > 0 && fin));
        return;
      }
      if (isDelete) {
        if (oldP === null) return;
        if (tree.get(oldP) === null) throw new Fail('missing', oldP);
        tree.now.set(oldP, null);
        return;
      }
      if (oldP !== null && newP !== null && oldP !== newP) {
        const before = tree.get(oldP);
        if (before === null) throw new Fail('missing', oldP);
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const res = applyHunks(before, s.hunks, strict, oldP);
        tree.now.set(oldP, null);
        tree.now.set(newP, joinParts(res.lines, res.br, res.final));
        tree.moves.push([oldP, newP]);
        return;
      }
      const path = oldP ?? newP;
      if (path === null) return;
      const before = tree.get(path);
      if (before === null) throw new Fail('missing', path);
      const res = applyHunks(before, s.hunks, strict, path);
      tree.now.set(path, joinParts(res.lines, res.br, res.final));
    };
  });
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks
// ---------------------------------------------------------------------------

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const s = i;
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j--) {
      const t = lines[j]!;
      if (blank(t)) continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let eq = -1;
    let end = -1;
    for (let j = s + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    for (let j = s + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (eq === -1 || end === -1 || end < eq) throw new Exit2(`error: parse ${s + 1}`);
    const old = lines.slice(s + 1, eq);
    const nw = lines.slice(eq + 1, end);
    const p = path;
    edits.push((tree: Tree): void => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (old.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, joinParts(nw, '\n', nw.length > 0));
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const parts = fileParts(before);
      const found = findTier(parts.lines, old, strict);
      if (!found) throw new Fail('no-match', p);
      if (found.occs.length > 1) throw new Fail('ambiguous', p);
      const newLines = applyReplace(parts.lines, plainEntries(old), nw.map((t) => ({ text: t, ctx: false, oIdx: -1 })), found.occs[0]!, found.tier);
      tree.now.set(p, joinParts(newLines, parts.br, parts.final));
    });
    prevEnd = end;
    prevPath = p;
    i = end + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string;
  eof: boolean;
  o: Entry[];
  n: Entry[];
  oTexts: string[];
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, joinParts(fileLines, '\n', fileLines.length > 0));
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function findAnchor(lines: string[], anchor: string, cursor: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const tf = t === 0 ? (s: string): string => s : t === 1 ? trail : both;
    for (let i = cursor; i < lines.length; i++) {
      if (tf(lines[i]!) === tf(anchor)) return i;
    }
  }
  return -1;
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const parts = fileParts(before);
    let lines = parts.lines;
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== '') {
        const idx = findAnchor(lines, ch.anchor, cursor, strict);
        if (idx === -1) throw new Fail('no-match', path);
        cursor = idx + 1;
      }
      if (ch.o.length === 0) {
        const at = ch.eof ? lines.length : cursor;
        const ins = ch.n.map((e) => e.text);
        lines = [...lines.slice(0, at), ...ins, ...lines.slice(at)];
        cursor = at + ins.length;
        continue;
      }
      let pos = -1;
      let tier = 0;
      if (ch.eof) {
        const want = lines.length - ch.o.length;
        if (want >= cursor && want >= 0) {
          const tiers = strict ? [0] : [0, 1, 2];
          for (const t of tiers) {
            const tf = t === 0 ? (s: string): string => s : t === 1 ? trail : both;
            let ok = true;
            for (let j = 0; j < ch.oTexts.length; j++) {
              if (tf(lines[want + j]!) !== tf(ch.oTexts[j]!)) {
                ok = false;
                break;
              }
            }
            if (ok) {
              pos = want;
              tier = t;
              break;
            }
          }
        }
        if (pos === -1) throw new Fail('no-match', path);
      } else {
        const found = findTier(lines, ch.oTexts, strict, cursor);
        if (!found) throw new Fail('no-match', path);
        pos = found.occs[0]!;
        tier = found.tier;
      }
      lines = applyReplace(lines, ch.o, ch.n, pos, tier);
      cursor = pos + ch.n.length;
    }
    const out = joinParts(lines, parts.br, parts.final);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const secStart = (l: string): { kind: string; path: string } | null => {
    if (l.startsWith('*** Add File: ')) return { kind: 'add', path: l.slice(14).trim() };
    if (l.startsWith('*** Delete File: ')) return { kind: 'delete', path: l.slice(17).trim() };
    if (l.startsWith('*** Update File: ')) return { kind: 'update', path: l.slice(17).trim() };
    return null;
  };
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    const s = secStart(line);
    if (!s) throw new Exit2(`error: parse ${i + 1}`);
    let j = i + 1;
    while (j < last && !secStart(lines[j]!)) j++;
    const raw = lines.slice(i + 1, j);
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
    const headerLine = i + 1;
    if (s.kind === 'add') {
      const fl: string[] = [];
      for (let k = 0; k < raw.length; k++) {
        const l = raw[k]!;
        if (l.startsWith('+')) fl.push(l.slice(1));
        else if (l === '') fl.push('');
        else throw new Exit2(`error: parse ${i + 2 + k}`);
      }
      edits.push(v4aAddEdit(s.path, fl));
    } else if (s.kind === 'delete') {
      for (let k = 0; k < raw.length; k++) {
        if (!blank(raw[k]!)) throw new Exit2(`error: parse ${i + 2 + k}`);
      }
      edits.push(v4aDeleteEdit(s.path));
    } else {
      // Update File section.
      let idx = 0;
      let moveTo: string | null = null;
      let k = 0;
      while (k < raw.length && blank(raw[k]!)) k++;
      if (k < raw.length && raw[k]!.startsWith('*** Move to: ')) {
        moveTo = raw[k]!.slice(13).trim();
        idx = k + 1;
      }
      const chunks: VChunk[] = [];
      while (idx < raw.length) {
        if (chunks.length > 0) {
          while (idx < raw.length && blank(raw[idx]!)) idx++;
          if (idx >= raw.length) break;
          if (!raw[idx]!.startsWith('@@')) throw new Exit2(`error: parse ${i + 2 + idx}`);
        }
        let anchor = '';
        if (raw[idx]!.startsWith('@@')) {
          anchor = raw[idx]!.slice(2).trim();
          idx++;
        }
        const items: BodyItem[] = [];
        let eof = false;
        while (idx < raw.length) {
          const l = raw[idx]!;
          if (l.trim() === '*** End of File') {
            eof = true;
            idx++;
            break;
          }
          if (l.startsWith('@@')) break;
          if (l === '') {
            items.push({ kind: 'ctx', text: '', rawEmpty: true });
            idx++;
            continue;
          }
          const c = l[0]!;
          if (c === ' ' || c === '-' || c === '+') {
            items.push({ kind: c === ' ' ? 'ctx' : c === '-' ? 'del' : 'add', text: l.slice(1) });
            idx++;
            continue;
          }
          throw new Exit2(`error: parse ${i + 2 + idx}`);
        }
        const { o, n } = buildON(items);
        chunks.push({ anchor, eof, o, n, oTexts: o.map((e) => e.text) });
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
      edits.push(v4aUpdateEdit(s.path, moveTo, chunks, strict));
    }
    i = j;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

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
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Output rows: A/D/M per changed path, with qualifying move pairs as R rows sorted by <new>.
  const rByNew = new Map<string, string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rByNew.set(newP, oldP);
    }
  }
  const rows: { key: string; row: string }[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (was === null && rByNew.has(p)) continue;
    if (now === null && [...rByNew.values()].includes(p)) continue;
    rows.push({ key: p, row: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [newP, oldP] of rByNew) rows.push({ key: newP, row: `R ${oldP} -> ${newP}` });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
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
  const out = rows.map((r) => r.row);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
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
