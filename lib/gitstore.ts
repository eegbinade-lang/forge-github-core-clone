// The git object store: blobs, trees and commits in memory, addressed by
// SHA-1 exactly as git computes it, with zlib for pack work. No git binary
// exists in the trial pod, so every object is built and parsed here.
//
// Timestamps come from a logical clock shared with the store, so two runs
// of the same trial produce the same commit ids byte for byte.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface CommitData {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

const AUTHOR = 'Forge <forge@localhost>';

export class GitStore {
  private objects = new Map<string, { type: ObjectType; data: Buffer }>();
  private tick = 0;

  /** A deterministic timestamp: a fixed epoch plus a per-object tick. */
  private stamp(): string {
    this.tick += 1;
    return `${1_700_000_000 + this.tick} +0000`;
  }

  hash(type: ObjectType, data: Buffer): string {
    const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
    return createHash('sha1').update(head).update(data).digest('hex');
  }

  put(type: ObjectType, data: Buffer): string {
    const sha = this.hash(type, data);
    if (!this.objects.has(sha)) this.objects.set(sha, { type, data });
    return sha;
  }

  has(sha: string): boolean {
    return this.objects.has(sha);
  }

  get(sha: string): { type: ObjectType; data: Buffer } | null {
    return this.objects.get(sha) ?? null;
  }

  /** All object ids, for pack generation. */
  ids(): string[] {
    return [...this.objects.keys()];
  }

  // ---- blobs ---------------------------------------------------------------

  putBlob(content: Buffer): string {
    return this.put('blob', content);
  }

  blobData(sha: string): Buffer | null {
    const obj = this.get(sha);
    return obj !== null && obj.type === 'blob' ? obj.data : null;
  }

  // ---- trees ---------------------------------------------------------------

  putTree(entries: TreeEntry[]): string {
    const sorted = [...entries].sort((a, b) => {
      const an = a.mode === '40000' ? `${a.name}/` : a.name;
      const bn = b.mode === '40000' ? `${b.name}/` : b.name;
      return an < bn ? -1 : an > bn ? 1 : 0;
    });
    const parts: Buffer[] = [];
    for (const entry of sorted) {
      parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
      parts.push(Buffer.from(entry.sha, 'hex'));
    }
    return this.put('tree', Buffer.concat(parts));
  }

  readTree(sha: string): TreeEntry[] {
    const obj = this.get(sha);
    if (obj === null || obj.type !== 'tree') return [];
    const entries: TreeEntry[] = [];
    let at = 0;
    while (at < obj.data.length) {
      const space = obj.data.indexOf(0x20, at);
      const nul = obj.data.indexOf(0x00, space);
      entries.push({
        mode: obj.data.toString('utf8', at, space),
        name: obj.data.toString('utf8', space + 1, nul),
        sha: obj.data.toString('hex', nul + 1, nul + 21),
      });
      at = nul + 21;
    }
    return entries;
  }

  /** Build nested trees from a flat path -> blob sha map; returns the root tree sha. */
  buildTree(files: ReadonlyMap<string, string>): string {
    interface Node { dirs: Map<string, Node>; files: Map<string, string> }
    const root: Node = { dirs: new Map(), files: new Map() };
    for (const [path, sha] of files) {
      const parts = path.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i]!;
        if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: new Map() });
        node = node.dirs.get(part)!;
      }
      node.files.set(parts[parts.length - 1]!, sha);
    }
    const emit = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, sha] of node.files) entries.push({ mode: '100644', name, sha });
      for (const [name, dir] of node.dirs) entries.push({ mode: '40000', name, sha: emit(dir) });
      return this.putTree(entries);
    };
    return emit(root);
  }

  /** Flatten a tree into path -> blob sha, recursively. */
  flattenTree(treeSha: string, prefix = ''): Map<string, string> {
    const out = new Map<string, string>();
    for (const entry of this.readTree(treeSha)) {
      if (entry.mode === '40000') {
        for (const [path, sha] of this.flattenTree(entry.sha, `${prefix}${entry.name}/`)) out.set(path, sha);
      } else {
        out.set(`${prefix}${entry.name}`, entry.sha);
      }
    }
    return out;
  }

  /** Walk a path inside a tree; returns the entry it names, or null. */
  lookup(treeSha: string, path: string): { mode: string; sha: string } | null {
    const parts = path.split('/');
    let current = treeSha;
    for (let i = 0; i < parts.length; i++) {
      const entry = this.readTree(current).find((e) => e.name === parts[i]);
      if (entry === undefined) return null;
      if (i === parts.length - 1) return { mode: entry.mode, sha: entry.sha };
      if (entry.mode !== '40000') return null;
      current = entry.sha;
    }
    return null;
  }

  // ---- commits ---------------------------------------------------------------

  putCommit(tree: string, parents: string[], message: string): string {
    const stamp = this.stamp();
    const lines = [`tree ${tree}`];
    for (const parent of parents) lines.push(`parent ${parent}`);
    lines.push(`author ${AUTHOR} ${stamp}`);
    lines.push(`committer ${AUTHOR} ${stamp}`);
    return this.put('commit', Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8'));
  }

  readCommit(sha: string): CommitData | null {
    const obj = this.get(sha);
    if (obj === null || obj.type !== 'commit') return null;
    const text = obj.data.toString('utf8');
    const split = text.indexOf('\n\n');
    const head = split === -1 ? text : text.slice(0, split);
    const data: CommitData = { tree: '', parents: [], author: '', committer: '', message: split === -1 ? '' : text.slice(split + 2) };
    for (const line of head.split('\n')) {
      if (line.startsWith('tree ')) data.tree = line.slice(5);
      else if (line.startsWith('parent ')) data.parents.push(line.slice(7));
      else if (line.startsWith('author ')) data.author = line.slice(7);
      else if (line.startsWith('committer ')) data.committer = line.slice(10);
    }
    return data;
  }

  /** Newest-first history from a tip, following first parents then all parents (BFS by insertion). */
  history(tip: string, limit = 1000): string[] {
    const seen = new Set<string>();
    const order: string[] = [];
    const queue = [tip];
    while (queue.length > 0 && order.length < limit) {
      const sha = queue.shift()!;
      if (seen.has(sha) || !this.has(sha)) continue;
      seen.add(sha);
      order.push(sha);
      const commit = this.readCommit(sha);
      if (commit !== null) queue.push(...commit.parents);
    }
    return order;
  }

  isAncestor(ancestor: string, tip: string): boolean {
    if (ancestor === tip) return true;
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length > 0) {
      const sha = queue.shift()!;
      if (sha === ancestor) return true;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const commit = this.readCommit(sha);
      if (commit !== null) queue.push(...commit.parents);
    }
    return false;
  }

  /** Follow tag objects to the commit they name (or return the sha itself). */
  peelToCommit(sha: string): string | null {
    let current = sha;
    for (let depth = 0; depth < 10; depth++) {
      const obj = this.get(current);
      if (obj === null) return null;
      if (obj.type === 'commit') return current;
      if (obj.type !== 'tag') return null;
      const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (match === null) return null;
      current = match[1]!;
    }
    return null;
  }

  /** The commit a tag object peels to, one level: tag -> its object header. */
  tagTarget(sha: string): string | null {
    const obj = this.get(sha);
    if (obj === null || obj.type !== 'tag') return null;
    const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
    return match === null ? null : match[1]!;
  }

  mergeBase(a: string, b: string): string | null {
    const ancestorsOfA = new Set(this.history(a, 100000));
    for (const sha of this.history(b, 100000)) {
      if (ancestorsOfA.has(sha)) return sha;
    }
    return null;
  }
}

/**
 * Three-way merge of flat file maps. Returns the merged map, or null when a
 * path changed on both sides in different ways (a conflict).
 */
export function threeWayMerge(
  base: ReadonlyMap<string, string>,
  ours: ReadonlyMap<string, string>,
  theirs: ReadonlyMap<string, string>,
): Map<string, string> | null {
  const merged = new Map<string, string>();
  const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    if (o === t) {
      if (o !== undefined) merged.set(path, o);
    } else if (b === o) {
      if (t !== undefined) merged.set(path, t);
    } else if (b === t) {
      if (o !== undefined) merged.set(path, o);
    } else {
      return null;
    }
  }
  return merged;
}

/** Line-multiset diff counts between two file contents. */
export function lineDiff(before: Buffer | null, after: Buffer | null): { additions: number; deletions: number } {
  const count = (buf: Buffer | null): Map<string, number> => {
    const map = new Map<string, number>();
    if (buf === null) return map;
    const text = buf.toString('utf8');
    if (text === '') return map;
    for (const line of text.split('\n')) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const a = count(before);
  const b = count(after);
  let additions = 0;
  let deletions = 0;
  for (const [line, n] of b) additions += Math.max(0, n - (a.get(line) ?? 0));
  for (const [line, n] of a) deletions += Math.max(0, n - (b.get(line) ?? 0));
  // A trailing newline makes the final empty segment a phantom line; drop it.
  if (after !== null && after.toString('utf8').endsWith('\n')) additions = Math.max(0, additions - 1);
  if (before !== null && before.toString('utf8').endsWith('\n')) deletions = Math.max(0, deletions - 1);
  return { additions, deletions };
}

export { deflateSync, inflateSync };
