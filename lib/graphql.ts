// GraphQL v4: a small lexer, parser and executor covering exactly the
// documents gh and github-mcp-server send — viewer, repository, issues and
// pull requests with cursor pagination, the create/close/merge/comment
// mutations, Relay node(id:), batched operations, and the __type probes
// feature detection relies on. Global ids are opaque, stable base64.

import { threeWayMerge } from './gitstore.ts';
import { mergePull, pullFiles, type Reply } from './rest.ts';
import type { Issue, Pull, Repo, Store } from './store.ts';

// ---- lexer / parser ------------------------------------------------------------

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'str'; value: string }
  | { kind: 'num'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'obj'; fields: Map<string, Value> };

interface FieldNode {
  alias: string | null;
  name: string;
  args: Map<string, Value>;
  selections: Selection[];
}

type Selection = { kind: 'field'; field: FieldNode } | { kind: 'fragment'; typeCondition: string; selections: Selection[] };

interface Operation { type: 'query' | 'mutation'; selections: Selection[] }

function lex(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === '#') { while (i < source.length && source[i] !== '\n') i++; continue; }
    if (/\s|,/.test(ch)) { i++; continue; }
    if (source.startsWith('...', i)) { tokens.push('...'); i += 3; continue; }
    if ('{}()[]:$!@='.includes(ch)) { tokens.push(ch); i++; continue; }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') { out += source[j + 1] === 'n' ? '\n' : source[j + 1] === 't' ? '\t' : source[j + 1]; j += 2; }
        else { out += source[j]; j++; }
      }
      tokens.push(`"${out}`);
      i = j + 1;
      continue;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i));
    if (name !== null) { tokens.push(name[0]); i += name[0].length; continue; }
    const num = /^-?\d+(\.\d+)?/.exec(source.slice(i));
    if (num !== null) { tokens.push(num[0]); i += num[0].length; continue; }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

class Parser {
  private tokens: string[];
  private at = 0;
  constructor(source: string) { this.tokens = lex(source); }
  private peek(): string | undefined { return this.tokens[this.at]; }
  private next(): string { const t = this.tokens[this.at++]; if (t === undefined) throw new Error('unexpected end of document'); return t; }
  private expect(token: string): void { const t = this.next(); if (t !== token) throw new Error(`expected ${token}, got ${t}`); }
  private skipBalanced(open: string, close: string): void {
    let depth = 0;
    do {
      const t = this.next();
      if (t === open) depth++;
      else if (t === close) depth--;
    } while (depth > 0);
  }

  parseOperation(): Operation {
    let type: 'query' | 'mutation' = 'query';
    const head = this.peek();
    if (head === 'query' || head === 'mutation') {
      type = this.next() as 'query' | 'mutation';
      if (this.peek() !== undefined && /^[A-Za-z_]/.test(this.peek()!)) this.next(); // operation name
      if (this.peek() === '(') this.skipBalanced('(', ')'); // variable definitions
      if (this.peek() === '@') { this.next(); if (/^[A-Za-z_]/.test(this.peek() ?? '')) this.next(); if (this.peek() === '(') this.skipBalanced('(', ')'); }
    }
    const selections = this.parseSelectionSet();
    return { type, selections };
  }

  private parseSelectionSet(): Selection[] {
    this.expect('{');
    const out: Selection[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        const on = this.next();
        if (on !== 'on') throw new Error('only inline fragments are supported');
        const typeCondition = this.next();
        out.push({ kind: 'fragment', typeCondition, selections: this.parseSelectionSet() });
      } else {
        out.push({ kind: 'field', field: this.parseField() });
      }
    }
    this.expect('}');
    return out;
  }

  private parseField(): FieldNode {
    let name = this.next();
    let alias: string | null = null;
    if (this.peek() === ':') { this.next(); alias = name; name = this.next(); }
    const args = new Map<string, Value>();
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const argName = this.next();
        this.expect(':');
        args.set(argName, this.parseValue());
      }
      this.expect(')');
    }
    const selections = this.peek() === '{' ? this.parseSelectionSet() : [];
    return { alias, name, args, selections };
  }

  private parseValue(): Value {
    const t = this.next();
    if (t === '$') return { kind: 'var', name: this.next() };
    if (t.startsWith('"')) return { kind: 'str', value: t.slice(1) };
    if (t === '[') {
      const items: Value[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (t === '{') {
      const fields = new Map<string, Value>();
      while (this.peek() !== '}') {
        const key = this.next();
        this.expect(':');
        fields.set(key, this.parseValue());
      }
      this.expect('}');
      return { kind: 'obj', fields };
    }
    if (t === 'true' || t === 'false') return { kind: 'bool', value: t === 'true' };
    if (t === 'null') return { kind: 'null' };
    if (/^-?\d/.test(t)) return { kind: 'num', value: Number(t) };
    return { kind: 'enum', value: t };
  }
}

// ---- values ---------------------------------------------------------------------

type Vars = Record<string, unknown>;

function resolve(value: Value, vars: Vars): unknown {
  switch (value.kind) {
    case 'var': return vars[value.name];
    case 'str': case 'num': case 'bool': case 'enum': return value.value;
    case 'null': return null;
    case 'list': return value.items.map((item) => resolve(item, vars));
    case 'obj': {
      const out: Record<string, unknown> = {};
      for (const [key, v] of value.fields) out[key] = resolve(v, vars);
      return out;
    }
  }
}

function arg(field: FieldNode, name: string, vars: Vars): unknown {
  const value = field.args.get(name);
  return value === undefined ? undefined : resolve(value, vars);
}

// ---- global ids --------------------------------------------------------------------

function gid(type: string, key: number): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64');
}

function parseGid(id: string): { type: string; key: number } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const match = /^([A-Za-z]+):(\d+)$/.exec(text);
    return match === null ? null : { type: match[1]!, key: Number(match[2]) };
  } catch {
    return null;
  }
}

// ---- schema --------------------------------------------------------------------------

interface Ctx {
  store: Store;
  base: string;
  vars: Vars;
  errors: { message: string }[];
}

interface Obj {
  __type: string;
  [key: string]: unknown;
}

type Resolver = (ctx: Ctx, obj: Obj, field: FieldNode) => unknown;

const SCHEMA_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'rateLimit'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'reopenIssue', 'createRepository'],
  User: ['id', 'login', 'name', 'email', 'url', 'avatarUrl', 'isViewer'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'hasProjectsEnabled', 'isPrivate', 'description', 'url', 'createdAt', 'updatedAt', 'issue', 'issues', 'pullRequest', 'pullRequests', 'labels', 'stargazerCount', 'forkCount', 'primaryLanguage'],
  Issue: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'url', 'author', 'repository', 'labels', 'comments', 'createdAt', 'updatedAt', 'closedAt', 'assignees', 'participants', 'milestone', 'reactions', 'viewerCanUpdate'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'headRef', 'baseRef', 'files', 'commits', 'author', 'url', 'createdAt', 'updatedAt', 'closedAt', 'mergeCommit', 'additions', 'deletions', 'changedFiles', 'isDraft', 'viewerCanUpdate'],
  Ref: ['id', 'name', 'prefix', 'target'],
  Label: ['id', 'name', 'color', 'description'],
  Comment: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  CommentEdge: ['node', 'cursor'],
  CommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  ReopenIssuePayload: ['issue', 'clientMutationId'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'ofType', 'specifiedByURL'],
  __Field: ['name', 'description', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __Schema: ['types', 'queryType', 'mutationType'],
};

const ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'MARKETPLACE', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};

// ---- object factories -------------------------------------------------------------------

function userObj(store: Store): Obj {
  const login = store.viewerLogin ?? 'viewer';
  return { __type: 'User', id: gid('User', 1), login, name: login, email: `${login}@example.invalid`, url: '', avatarUrl: '', isViewer: true };
}

function repoObj(store: Store, repo: Repo): Obj {
  return { __type: 'Repository', _repo: repo, id: gid('Repository', repo.id), databaseId: repo.id };
}

function issueObj(store: Store, repo: Repo, issue: Issue): Obj {
  void store;
  return {
    __type: 'Issue', _repo: repo, _issue: issue,
    id: gid('Issue', issue.id), databaseId: issue.id, number: issue.number, title: issue.title, body: issue.body,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
  };
}

function pullObj(store: Store, repo: Repo, pull: Pull): Obj {
  void store;
  return {
    __type: 'PullRequest', _repo: repo, _pull: pull,
    id: gid('PullRequest', pull.id), databaseId: pull.id, number: pull.number, title: pull.title, body: pull.body,
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged, mergedAt: pull.mergedAt,
    headRefName: pull.headRef, baseRefName: pull.baseRef,
  };
}

function findIssue(store: Store, id: number): { repo: Repo; issue: Issue } | null {
  for (const repo of store.allRepos()) {
    for (const issue of repo.issues.values()) if (issue.id === id) return { repo, issue };
  }
  return null;
}

function findPull(store: Store, id: number): { repo: Repo; pull: Pull } | null {
  for (const repo of store.allRepos()) {
    for (const pull of repo.pulls.values()) if (pull.id === id) return { repo, pull };
  }
  return null;
}

function cursorOf(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberOfCursor(cursor: string): number | null {
  try {
    const match = /^cursor:(\d+)$/.exec(Buffer.from(cursor, 'base64').toString('utf8'));
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

interface Connection { nodes: Obj[]; hasNextPage: boolean; endCursor: string | null }

function connect(items: Obj[], field: FieldNode, vars: Vars, keyOf: (obj: Obj) => number): Connection {
  const first = Number(arg(field, 'first', vars) ?? 100);
  const after = arg(field, 'after', vars);
  let start = 0;
  if (typeof after === 'string' && after !== '') {
    const mark = numberOfCursor(after);
    const index = mark === null ? -1 : items.findIndex((item) => keyOf(item) === mark);
    start = index >= 0 ? index + 1 : 0;
  }
  const page = items.slice(start, start + Math.max(0, first));
  return {
    nodes: page,
    hasNextPage: start + page.length < items.length,
    endCursor: page.length > 0 ? cursorOf(keyOf(page[page.length - 1]!)) : null,
  };
}

// ---- resolvers -----------------------------------------------------------------------------

function repoField(ctx: Ctx, repo: Repo, field: FieldNode): unknown {
  const store = ctx.store;
  switch (field.name) {
    case 'name': return repo.name;
    case 'nameWithOwner': return `${store.ownerOf(repo)}/${repo.name}`;
    case 'owner': return userObj(store);
    case 'defaultBranchRef': return { __type: 'Ref', id: gid('Ref', repo.id), name: repo.defaultBranch, prefix: 'refs/heads/' };
    case 'viewerPermission': return 'ADMIN';
    case 'hasIssuesEnabled': case 'hasProjectsEnabled': return true;
    case 'isPrivate': return repo.isPrivate;
    case 'description': return repo.description;
    case 'url': return `${ctx.base}/${store.ownerOf(repo)}/${repo.name}`;
    case 'createdAt': return repo.createdAt;
    case 'updatedAt': return repo.updatedAt;
    case 'stargazerCount': case 'forkCount': return 0;
    case 'primaryLanguage': return null;
    case 'issue': {
      const number = Number(arg(field, 'number', ctx.vars));
      const issue = repo.issues.get(number);
      return issue === undefined ? null : issueObj(store, repo, issue);
    }
    case 'issues': {
      const states = (arg(field, 'states', ctx.vars) as string[] | undefined) ?? null;
      let list = [...repo.issues.values()];
      if (states !== null) {
        const wanted = states.map((s) => (s === 'OPEN' ? 'open' : 'closed'));
        list = list.filter((i) => wanted.includes(i.state));
      }
      const orderBy = arg(field, 'orderBy', ctx.vars) as { field?: string; direction?: string } | undefined;
      const desc = orderBy?.direction !== 'ASC';
      list.sort((a, b) => (desc ? b.number - a.number : a.number - b.number));
      const conn = connect(list.map((i) => issueObj(store, repo, i)), field, ctx.vars, (o) => (o._issue as Issue).number);
      return { __type: 'IssueConnection', _conn: conn };
    }
    case 'pullRequest': {
      const number = Number(arg(field, 'number', ctx.vars));
      const pull = repo.pulls.get(number);
      return pull === undefined ? null : pullObj(store, repo, pull);
    }
    case 'pullRequests': {
      const states = (arg(field, 'states', ctx.vars) as string[] | undefined) ?? ['OPEN'];
      let list = [...repo.pulls.values()];
      list = list.filter((p) => {
        const state = p.merged ? 'MERGED' : p.state === 'open' ? 'OPEN' : 'CLOSED';
        return states.includes(state);
      });
      list.sort((a, b) => b.number - a.number);
      const conn = connect(list.map((p) => pullObj(store, repo, p)), field, ctx.vars, (o) => (o._pull as Pull).number);
      return { __type: 'PullRequestConnection', _conn: conn };
    }
    default: return undefined;
  }
}

function pullField(ctx: Ctx, repo: Repo, pull: Pull, field: FieldNode): unknown {
  const store = ctx.store;
  switch (field.name) {
    case 'mergeable': {
      if (pull.merged || pull.state !== 'open') return 'UNKNOWN';
      const headTip = store.branchTip(repo, pull.headRef);
      const baseTip = store.branchTip(repo, pull.baseRef);
      if (headTip === null || baseTip === null) return 'UNKNOWN';
      const mergeBase = store.git.mergeBase(baseTip, headTip);
      const merged = threeWayMerge(store.filesAt(repo, mergeBase), store.filesAt(repo, baseTip), store.filesAt(repo, headTip));
      return merged === null ? 'CONFLICTING' : 'MERGEABLE';
    }
    case 'headRefOid': return store.branchTip(repo, pull.headRef) ?? '';
    case 'baseRefOid': return store.branchTip(repo, pull.baseRef) ?? '';
    case 'headRef': return { __type: 'Ref', id: gid('Ref', pull.id * 2), name: pull.headRef, prefix: 'refs/heads/' };
    case 'baseRef': return { __type: 'Ref', id: gid('Ref', pull.id * 2 + 1), name: pull.baseRef, prefix: 'refs/heads/' };
    case 'files': {
      const files = pullFiles(store, repo, pull);
      const first = Number(arg(field, 'first', ctx.vars) ?? 100);
      const nodes = files.slice(0, first).map((f) => ({
        __type: 'PullRequestFile',
        path: f.filename as string,
        additions: f.additions as number,
        deletions: f.deletions as number,
        changeType: (f.status as string) === 'added' ? 'ADDED' : (f.status as string) === 'removed' ? 'DELETED' : 'MODIFIED',
      }));
      return { __type: 'PullRequestFileConnection', _conn: { nodes, hasNextPage: files.length > nodes.length, endCursor: null } };
    }
    case 'author': return userObj(store);
    case 'url': return `${ctx.base}/${store.ownerOf(repo)}/${repo.name}/pull/${pull.number}`;
    case 'createdAt': return pull.createdAt;
    case 'updatedAt': return pull.updatedAt;
    case 'closedAt': return pull.state === 'closed' ? pull.updatedAt : null;
    case 'isDraft': return false;
    case 'viewerCanUpdate': return true;
    case 'additions': return pullFiles(store, repo, pull).reduce((sum, f) => sum + (f.additions as number), 0);
    case 'deletions': return pullFiles(store, repo, pull).reduce((sum, f) => sum + (f.deletions as number), 0);
    case 'changedFiles': return pullFiles(store, repo, pull).length;
    case 'mergeCommit': return pull.mergeCommitSha === null ? null : { __type: 'Commit', oid: pull.mergeCommitSha, id: gid('Commit', 0) };
    default: return undefined;
  }
}

function resolveField(ctx: Ctx, obj: Obj, field: FieldNode): unknown {
  const store = ctx.store;
  if (field.name === '__typename') return obj.__type;
  const type = obj.__type;
  const known = SCHEMA_FIELDS[type];
  if (known !== undefined && !known.includes(field.name) && field.name !== '__type' && field.name !== '__schema') {
    ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${type}'` });
    return null;
  }
  // Scalar fields carried on the object itself (ids, numbers, titles, states).
  if (!field.name.startsWith('_') && Object.prototype.hasOwnProperty.call(obj, field.name)) {
    const carried = obj[field.name];
    if (carried !== undefined && (carried === null || typeof carried !== 'object')) return carried;
  }
  switch (type) {
    case 'Query': {
      if (field.name === 'viewer') return userObj(store);
      if (field.name === 'repository') {
        const owner = String(arg(field, 'owner', ctx.vars) ?? '');
        const name = String(arg(field, 'name', ctx.vars) ?? '');
        const repo = store.repoFor(owner, name);
        return repo === null ? null : repoObj(store, repo);
      }
      if (field.name === 'node') {
        const parsed = parseGid(String(arg(field, 'id', ctx.vars) ?? ''));
        if (parsed === null) return null;
        if (parsed.type === 'Repository') {
          const repo = store.allRepos().find((r) => r.id === parsed.key);
          return repo === undefined ? null : repoObj(store, repo);
        }
        if (parsed.type === 'Issue') {
          const found = findIssue(store, parsed.key);
          return found === null ? null : issueObj(store, found.repo, found.issue);
        }
        if (parsed.type === 'PullRequest') {
          const found = findPull(store, parsed.key);
          return found === null ? null : pullObj(store, found.repo, found.pull);
        }
        if (parsed.type === 'User') return userObj(store);
        return null;
      }
      if (field.name === '__type') {
        const name = String(arg(field, 'name', ctx.vars) ?? '');
        if (SCHEMA_FIELDS[name] !== undefined) return { __type: '__Type', _name: name, _kind: 'OBJECT' };
        if (ENUMS[name] !== undefined) return { __type: '__Type', _name: name, _kind: 'ENUM' };
        return null;
      }
      return null;
    }
    case 'Mutation': return resolveMutation(ctx, field);
    case 'Repository': return repoField(ctx, obj._repo as Repo, field);
    case 'Issue': {
      const issue = obj._issue as Issue;
      const repo = obj._repo as Repo;
      if (field.name === 'author') return userObj(store);
      if (field.name === 'repository') return repoObj(store, repo);
      if (field.name === 'url') return `${ctx.base}/${store.ownerOf(repo)}/${repo.name}/issues/${issue.number}`;
      if (field.name === 'createdAt') return issue.createdAt;
      if (field.name === 'updatedAt') return issue.updatedAt;
      if (field.name === 'closedAt') return issue.state === 'closed' ? issue.updatedAt : null;
      if (field.name === 'labels') {
        return { __type: 'LabelConnection', _conn: { nodes: issue.labels.map((name) => ({ __type: 'Label', id: gid('Label', repo.labels.get(name)?.id ?? 0), name, color: repo.labels.get(name)?.color ?? 'ededed', description: repo.labels.get(name)?.description ?? null })), hasNextPage: false, endCursor: null } };
      }
      if (field.name === 'comments') {
        const nodes = issue.comments.map((c) => ({ __type: 'Comment', id: gid('Comment', c.id), databaseId: c.id, body: c.body, createdAt: c.createdAt, updatedAt: c.updatedAt }));
        return { __type: 'CommentConnection', _conn: { nodes, hasNextPage: false, endCursor: null } };
      }
      if (field.name === 'viewerCanUpdate') return true;
      if (field.name === 'assignees' || field.name === 'participants') return { __type: 'UserConnection', _conn: { nodes: [], hasNextPage: false, endCursor: null } };
      if (field.name === 'reactions') return { __type: 'ReactionConnection', _conn: { nodes: [], hasNextPage: false, endCursor: null } };
      if (field.name === 'milestone') return null;
      return obj[field.name];
    }
    case 'PullRequest': return pullField(ctx, obj._repo as Repo, obj._pull as Pull, field);
    case 'User': return obj[field.name];
    case 'Ref': return obj[field.name];
    case 'Label': return obj[field.name];
    case 'Comment': {
      if (field.name === 'author') return userObj(store);
      return obj[field.name];
    }
    case 'IssueConnection': case 'PullRequestConnection': case 'PullRequestFileConnection': case 'CommentConnection': case 'LabelConnection': case 'UserConnection': case 'ReactionConnection': {
      const conn = obj._conn as Connection;
      if (field.name === 'nodes') return conn.nodes;
      if (field.name === 'pageInfo') return { __type: 'PageInfo', hasNextPage: conn.hasNextPage, hasPreviousPage: false, startCursor: null, endCursor: conn.endCursor };
      if (field.name === 'totalCount') return conn.nodes.length;
      if (field.name === 'edges') return conn.nodes.map((node) => ({ __type: 'Edge', node }));
      return null;
    }
    case 'PageInfo': return obj[field.name];
    case 'PullRequestFile': return obj[field.name];
    case '__Type': {
      const name = obj._name as string;
      if (field.name === 'name') return name;
      if (field.name === 'kind') return obj._kind;
      if (field.name === 'description') return null;
      if (field.name === 'fields') return (SCHEMA_FIELDS[name] ?? []).map((f) => ({ __type: '__Field', name: f, description: null, isDeprecated: false, deprecationReason: null }));
      if (field.name === 'enumValues') return (ENUMS[name] ?? []).map((v) => ({ __type: '__EnumValue', name: v, description: null, isDeprecated: false, deprecationReason: null }));
      if (field.name === 'possibleTypes' || field.name === 'inputFields') return [];
      return null;
    }
    case '__Field': case '__EnumValue': return obj[field.name];
    default:
      return obj[field.name];
  }
}

function resolveMutation(ctx: Ctx, field: FieldNode): unknown {
  const store = ctx.store;
  const input = (arg(field, 'input', ctx.vars) ?? {}) as Record<string, unknown>;
  switch (field.name) {
    case 'createIssue': {
      const parsed = parseGid(String(input.repositoryId ?? ''));
      const repo = parsed === null ? undefined : store.allRepos().find((r) => r.id === parsed.key);
      if (repo === undefined) { ctx.errors.push({ message: 'Repository not found' }); return null; }
      const issue = store.addIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      return { __type: 'CreateIssuePayload', issue: issueObj(store, repo, issue), clientMutationId: input.clientMutationId ?? null };
    }
    case 'closeIssue': case 'reopenIssue': {
      const parsed = parseGid(String(input.issueId ?? ''));
      const found = parsed === null ? null : findIssue(store, parsed.key);
      if (found === null) { ctx.errors.push({ message: 'Issue not found' }); return null; }
      found.issue.state = field.name === 'closeIssue' ? 'closed' : 'open';
      found.issue.updatedAt = store.now();
      const type = field.name === 'closeIssue' ? 'CloseIssuePayload' : 'ReopenIssuePayload';
      return { __type: type, issue: issueObj(store, found.repo, found.issue), clientMutationId: input.clientMutationId ?? null };
    }
    case 'createPullRequest': {
      const parsed = parseGid(String(input.repositoryId ?? ''));
      const repo = parsed === null ? undefined : store.allRepos().find((r) => r.id === parsed.key);
      if (repo === undefined) { ctx.errors.push({ message: 'Repository not found' }); return null; }
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      if (store.branchTip(repo, head) === null || store.branchTip(repo, base) === null) {
        ctx.errors.push({ message: 'Head or base branch does not exist' });
        return null;
      }
      const pull = store.addPull(repo, String(input.title ?? ''), String(input.body ?? ''), head, base);
      return { __type: 'CreatePullRequestPayload', pullRequest: pullObj(store, repo, pull), clientMutationId: input.clientMutationId ?? null };
    }
    case 'mergePullRequest': {
      const parsed = parseGid(String(input.pullRequestId ?? ''));
      const found = parsed === null ? null : findPull(store, parsed.key);
      if (found === null) { ctx.errors.push({ message: 'Pull request not found' }); return null; }
      const reply = mergePull({ store, base: ctx.base, query: new URLSearchParams(), body: { merge_method: 'squash' } }, found.repo, found.pull);
      if (reply.status !== 200) ctx.errors.push({ message: String((reply.body as { message?: string }).message ?? 'Merge failed') });
      return { __type: 'MergePullRequestPayload', pullRequest: pullObj(store, found.repo, found.pull), clientMutationId: input.clientMutationId ?? null };
    }
    case 'addComment': {
      const parsed = parseGid(String(input.subjectId ?? ''));
      const found = parsed === null ? null : findIssue(store, parsed.key);
      if (found === null) { ctx.errors.push({ message: 'Subject not found' }); return null; }
      const comment = store.addComment(found.issue, String(input.body ?? ''));
      const node: Obj = { __type: 'Comment', id: gid('Comment', comment.id), databaseId: comment.id, body: comment.body, createdAt: comment.createdAt, updatedAt: comment.updatedAt };
      return { __type: 'AddCommentPayload', commentEdge: { __type: 'CommentEdge', node, cursor: cursorOf(comment.id) }, subject: issueObj(store, found.repo, found.issue), clientMutationId: input.clientMutationId ?? null };
    }
    default:
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type 'Mutation'` });
      return null;
  }
}

// ---- execution ---------------------------------------------------------------------------

function executeSelectionSet(ctx: Ctx, obj: Obj, selections: Selection[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition === obj.__type) Object.assign(out, executeSelectionSet(ctx, obj, selection.selections));
      continue;
    }
    const { field } = selection;
    const key = field.alias ?? field.name;
    const value = resolveField(ctx, obj, field);
    out[key] = shapeValue(ctx, value, field);
  }
  return out;
}

function shapeValue(ctx: Ctx, value: unknown, field: FieldNode): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => shapeValue(ctx, item, field));
  if (typeof value === 'object' && '__type' in (value as Obj)) {
    if (field.selections.length === 0) return null;
    return executeSelectionSet(ctx, value as Obj, field.selections);
  }
  return value;
}

function executeOperation(store: Store, base: string, query: string, vars: Vars): Record<string, unknown> {
  const ctx: Ctx = { store, base, vars, errors: [] };
  let operation: Operation;
  try {
    operation = new Parser(query).parseOperation();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  const root: Obj = { __type: operation.type === 'mutation' ? 'Mutation' : 'Query' };
  const data = executeSelectionSet(ctx, root, operation.selections);
  const out: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) out.errors = ctx.errors;
  return out;
}

/** POST /api/graphql: one operation, or a batch array answering in order. */
export function handleGraphql(store: Store, rawBody: Buffer, base: string): Reply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { status: 400, body: { message: 'Problems parsing JSON' } };
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => {
      const e = (entry ?? {}) as Record<string, unknown>;
      return executeOperation(store, base, String(e.query ?? ''), (e.variables as Vars) ?? {});
    });
    return { status: 200, body: results };
  }
  const entry = (parsed ?? {}) as Record<string, unknown>;
  const result = executeOperation(store, base, String(entry.query ?? ''), (entry.variables as Vars) ?? {});
  return { status: 200, body: result };
}
