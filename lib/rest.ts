// The REST v3 surface: repositories, branches, commits, contents, labels,
// issues, comments and pull requests, in GitHub's shapes and status codes.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { lineDiff, threeWayMerge } from './gitstore.ts';
import type { Comment, Issue, Label, Pull, Repo, Store } from './store.ts';

export interface Reply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const ok = (status: number, body: unknown, headers?: Record<string, string>): Reply => ({ status, body, headers });
const fail = (status: number, message: string): Reply => ({ status, body: { message } });

export const notFound = (): Reply => fail(404, 'Not Found');

// ---- serializers -------------------------------------------------------------

export function repoJson(store: Store, repo: Repo, base: string): Record<string, unknown> {
  const owner = store.ownerOf(repo);
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: { login: owner, id: 1, type: 'User' },
    private: repo.isPrivate,
    html_url: `${base}/${owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `${base}/api/v3/repos/${owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    clone_url: `${base}/${owner}/${repo.name}.git`,
    default_branch: repo.defaultBranch,
    visibility: repo.isPrivate ? 'private' : 'public',
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { id: label.id, node_id: `LA_${label.id}`, name: label.name, color: label.color, description: label.description, default: false };
}

export function issueJson(store: Store, repo: Repo, issue: Issue, base: string): Record<string, unknown> {
  const owner = store.ownerOf(repo);
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => repo.labels.get(name)).filter((l) => l !== undefined).map(labelJson),
    user: { login: owner, id: 1, type: 'User' },
    assignees: [],
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    html_url: `${base}/${owner}/${repo.name}/issues/${issue.number}`,
    url: `${base}/api/v3/repos/${owner}/${repo.name}/issues/${issue.number}`,
  };
}

function commentJson(store: Store, repo: Repo, comment: Comment, base: string): Record<string, unknown> {
  const owner = store.ownerOf(repo);
  return {
    id: comment.id,
    node_id: `IC_${comment.id}`,
    body: comment.body,
    user: { login: owner, id: 1, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: `${base}/${owner}/${repo.name}#issuecomment-${comment.id}`,
  };
}

export function pullJson(store: Store, repo: Repo, pull: Pull, base: string): Record<string, unknown> {
  const owner = store.ownerOf(repo);
  const side = (ref: string): Record<string, unknown> => ({
    label: `${owner}:${ref}`,
    ref,
    sha: store.branchTip(repo, ref) ?? '',
    user: { login: owner, id: 1, type: 'User' },
    repo: repoJson(store, repo, base),
  });
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: { login: owner, id: 1, type: 'User' },
    labels: [],
    head: side(pull.headRef),
    base: side(pull.baseRef),
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    draft: false,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    html_url: `${base}/${owner}/${repo.name}/pull/${pull.number}`,
    url: `${base}/api/v3/repos/${owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function commitJson(store: Store, sha: string, base: string, owner: string, repoName: string): Record<string, unknown> {
  const commit = store.git.readCommit(sha);
  const person = (line: string): Record<string, unknown> => {
    const match = /^(.*) <(.*)> (\d+) /.exec(line);
    return {
      name: match?.[1] ?? '',
      email: match?.[2] ?? '',
      date: new Date(Number(match?.[3] ?? 0) * 1000).toISOString(),
    };
  };
  return {
    sha,
    node_id: `C_${sha}`,
    commit: {
      author: person(commit?.author ?? ''),
      committer: person(commit?.committer ?? ''),
      message: commit?.message ?? '',
      tree: { sha: commit?.tree ?? '' },
      comment_count: 0,
    },
    author: { login: owner, id: 1, type: 'User' },
    committer: { login: owner, id: 1, type: 'User' },
    parents: (commit?.parents ?? []).map((parent) => ({ sha: parent, url: `${base}/api/v3/repos/${owner}/${repoName}/commits/${parent}` })),
    html_url: `${base}/${owner}/${repoName}/commit/${sha}`,
    url: `${base}/api/v3/repos/${owner}/${repoName}/commits/${sha}`,
  };
}

// ---- request helpers -----------------------------------------------------------

export interface Ctx {
  store: Store;
  base: string; // http://host of this request
  query: URLSearchParams;
  body: Record<string, unknown> | null;
}

function str(body: Record<string, unknown> | null, key: string): string | null {
  const value = body?.[key];
  return typeof value === 'string' ? value : null;
}

function paginate<T>(ctx: Ctx, items: T[], path: string): { page: T[]; headers: Record<string, string> } {
  const perPage = Math.min(100, Math.max(1, Number(ctx.query.get('per_page') ?? '30') || 30));
  const pageNo = Math.max(1, Number(ctx.query.get('page') ?? '1') || 1);
  const start = (pageNo - 1) * perPage;
  const page = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const params = new URLSearchParams(ctx.query);
    params.set('per_page', String(perPage));
    params.set('page', String(pageNo + 1));
    const last = new URLSearchParams(ctx.query);
    last.set('per_page', String(perPage));
    last.set('page', String(Math.ceil(items.length / perPage)));
    headers.link = `<${ctx.base}${path}?${params}>; rel="next", <${ctx.base}${path}?${last}>; rel="last"`;
  }
  return { page, headers };
}

// ---- handlers -------------------------------------------------------------------

export function handleRest(ctx: Ctx, method: string, segments: string[]): Reply {
  const { store } = ctx;
  // segments are the decoded path parts after /api/v3
  if (segments.length === 0) {
    if (method !== 'GET') return notFound();
    return ok(200, {
      current_user_url: `${ctx.base}/api/v3/user`,
      repository_url: `${ctx.base}/api/v3/repos/{owner}/{repo}`,
      issue_search_url: `${ctx.base}/api/v3/search/issues?q={query}`,
    });
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') return notFound();
    return ok(200, { verifiable_password_authentication: false, installed_version: '3.16.0' });
  }
  if (segments[0] === 'user' && segments.length === 1) {
    if (method !== 'GET') return notFound();
    return ok(200, { login: store.viewerName(), id: 1, type: 'User', site_admin: false });
  }
  if (segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') {
      const all = store.allRepos().map((repo) => repoJson(store, repo, ctx.base));
      const { page, headers } = paginate(ctx, all, '/api/v3/user/repos');
      return ok(200, page, headers);
    }
    if (method === 'POST') {
      const name = str(ctx.body, 'name');
      if (name === null || name === '') return fail(422, 'Repository creation failed: name is required');
      if (store.repoByName(name) !== null) return fail(422, 'Repository creation failed: name already exists on this account');
      const isPrivate = ctx.body?.private !== false;
      const description = str(ctx.body, 'description');
      const defaultBranch = str(ctx.body, 'default_branch') ?? 'main';
      const repo = store.createRepo(name, isPrivate, description, defaultBranch);
      if (repo === null) return fail(422, 'Repository creation failed: name already exists on this account');
      return ok(201, repoJson(store, repo, ctx.base));
    }
    return notFound();
  }
  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = segments[1]!;
    const repo = store.repoFor(owner, segments[2]!);
    if (repo === null) return notFound();
    return handleRepo(ctx, method, repo, segments.slice(3));
  }
  return notFound();
}

function handleRepo(ctx: Ctx, method: string, repo: Repo, rest: string[]): Reply {
  const { store } = ctx;
  const owner = store.ownerOf(repo);
  const repoPath = `/api/v3/repos/${owner}/${repo.name}`;

  if (rest.length === 0) {
    if (method === 'GET') return ok(200, repoJson(store, repo, ctx.base));
    if (method === 'PATCH') {
      if (ctx.body !== null && 'description' in ctx.body) repo.description = str(ctx.body, 'description');
      if (ctx.body !== null && typeof ctx.body.private === 'boolean') repo.isPrivate = ctx.body.private;
      if (ctx.body !== null && typeof ctx.body.name === 'string' && ctx.body.name !== '') repo.name = ctx.body.name;
      repo.updatedAt = store.now();
      return ok(200, repoJson(store, repo, ctx.base));
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo);
      return { status: 204, body: null };
    }
    return notFound();
  }

  if (rest[0] === 'branches' && rest.length === 1 && method === 'GET') {
    const branches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, sha]) => ({
      name: ref.slice('refs/heads/'.length),
      commit: { sha, url: `${ctx.base}${repoPath}/commits/${sha}` },
      protected: false,
    }));
    const { page, headers } = paginate(ctx, branches, `${repoPath}/branches`);
    return ok(200, page, headers);
  }

  if (rest[0] === 'branches' && rest.length >= 2 && method === 'GET') {
    const name = rest.slice(1).join('/');
    const sha = repo.refs.get(`refs/heads/${name}`);
    if (sha === undefined) return notFound();
    return ok(200, { name, commit: { sha, url: `${ctx.base}${repoPath}/commits/${sha}` }, protected: false });
  }

  if (rest[0] === 'git' && rest[1] === 'refs' && method === 'GET' && rest.length >= 3) {
    const ref = rest.slice(2).join('/');
    const full = ref.startsWith('refs/') ? ref : `refs/${ref}`;
    const sha = repo.refs.get(full);
    if (sha === undefined) return notFound();
    return ok(200, { ref: full, node_id: '', object: { sha, type: 'commit', url: `${ctx.base}${repoPath}/git/commits/${sha}` } });
  }

  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    const ref = ctx.query.get('sha') ?? repo.defaultBranch;
    const tip = store.branchTip(repo, ref) ?? (store.git.has(ref) ? ref : null);
    if (tip === null) return ok(200, []);
    const history = store.git.history(tip, 10000);
    const all = history.map((sha) => commitJson(store, sha, ctx.base, owner, repo.name));
    const { page, headers } = paginate(ctx, all, `${repoPath}/commits`);
    return ok(200, page, headers);
  }

  if (rest[0] === 'git' && rest[1] === 'refs' && method === 'POST') {
    const ref = str(ctx.body, 'ref');
    const sha = str(ctx.body, 'sha');
    if (ref === null || sha === null || !ref.startsWith('refs/heads/')) return fail(422, 'Invalid ref or sha');
    const branch = ref.slice('refs/heads/'.length);
    if (store.branchTip(repo, branch) !== null) return fail(422, 'Reference already exists');
    if (store.git.readCommit(sha) === null) return fail(422, 'Invalid sha');
    store.setBranch(repo, branch, sha);
    return ok(201, { ref, node_id: `REF_${ref}`, url: `${ctx.base}${repoPath}/git/${ref}`, object: { type: 'commit', sha } });
  }

  if (rest[0] === 'contents') return handleContents(ctx, method, repo, rest.slice(1).join('/'));
  if (rest[0] === 'labels') return handleLabels(ctx, method, repo, rest.slice(1));
  if (rest[0] === 'issues') return handleIssues(ctx, method, repo, rest.slice(1));
  if (rest[0] === 'pulls') return handlePulls(ctx, method, repo, rest.slice(1));
  return notFound();
}

function handleContents(ctx: Ctx, method: string, repo: Repo, path: string): Reply {
  const { store } = ctx;
  const owner = store.ownerOf(repo);
  if (method === 'GET') {
    const ref = ctx.query.get('ref') ?? repo.defaultBranch;
    const tree = store.treeAt(repo, ref);
    if (tree === null) return notFound();
    if (path === '') {
      return ok(200, dirListing(store, repo, tree, '', ctx.base));
    }
    const found = store.git.lookup(tree, path);
    if (found === null) return notFound();
    if (found.mode === '40000') return ok(200, dirListing(store, repo, found.sha, path, ctx.base));
    const data = store.git.blobData(found.sha);
    if (data === null) return notFound();
    return ok(200, {
      type: 'file',
      encoding: 'base64',
      size: data.length,
      name: path.split('/').pop(),
      path,
      sha: found.sha,
      content: data.toString('base64'),
      url: `${ctx.base}/api/v3/repos/${owner}/${repo.name}/contents/${path}`,
      html_url: `${ctx.base}/${owner}/${repo.name}/blob/${ref}/${path}`,
      download_url: `${ctx.base}/${owner}/${repo.name}/raw/${ref}/${path}`,
    });
  }
  if (method === 'PUT') {
    const message = str(ctx.body, 'message');
    const content = str(ctx.body, 'content');
    if (message === null || content === null) return fail(422, 'Invalid request: message and content are required');
    const branch = str(ctx.body, 'branch') ?? repo.defaultBranch;
    const files = store.filesAt(repo, branch);
    const existing = files.get(path);
    const givenSha = str(ctx.body, 'sha');
    if (existing !== undefined) {
      if (givenSha === null) return fail(422, 'Invalid request: sha is required when updating a file');
      if (givenSha !== existing) return fail(409, 'Conflict: the file has changed since the sha was read');
    }
    const blobSha = store.git.putBlob(Buffer.from(content.replace(/\s+/g, ''), 'base64'));
    files.set(path, blobSha);
    const commitSha = store.commitFiles(repo, branch, files, message);
    const data = store.git.blobData(blobSha)!;
    return ok(existing === undefined ? 201 : 200, {
      content: {
        type: 'file',
        encoding: 'base64',
        size: data.length,
        name: path.split('/').pop(),
        path,
        sha: blobSha,
        url: `${ctx.base}/api/v3/repos/${owner}/${repo.name}/contents/${path}`,
        html_url: `${ctx.base}/${owner}/${repo.name}/blob/${branch}/${path}`,
        download_url: `${ctx.base}/${owner}/${repo.name}/raw/${branch}/${path}`,
      },
      commit: commitJson(store, commitSha, ctx.base, owner, repo.name),
    });
  }
  if (method === 'DELETE') {
    const message = str(ctx.body, 'message');
    const givenSha = str(ctx.body, 'sha');
    if (message === null || givenSha === null) return fail(422, 'Invalid request: message and sha are required');
    const branch = str(ctx.body, 'branch') ?? repo.defaultBranch;
    const files = store.filesAt(repo, branch);
    const existing = files.get(path);
    if (existing === undefined) return notFound();
    if (givenSha !== existing) return fail(409, 'Conflict: the file has changed since the sha was read');
    files.delete(path);
    const commitSha = store.commitFiles(repo, branch, files, message);
    return ok(200, { content: null, commit: commitJson(store, commitSha, ctx.base, owner, repo.name) });
  }
  return notFound();
}

function dirListing(store: Store, repo: Repo, treeSha: string, prefix: string, base: string): Record<string, unknown>[] {
  const owner = store.ownerOf(repo);
  return store.git.readTree(treeSha).map((entry) => ({
    type: entry.mode === '40000' ? 'dir' : 'file',
    size: entry.mode === '40000' ? 0 : (store.git.blobData(entry.sha)?.length ?? 0),
    name: entry.name,
    path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
    sha: entry.sha,
    url: `${base}/api/v3/repos/${owner}/${repo.name}/contents/${prefix === '' ? entry.name : `${prefix}/${entry.name}`}`,
    html_url: `${base}/${owner}/${repo.name}/tree/main/${prefix === '' ? entry.name : `${prefix}/${entry.name}`}`,
    download_url: null,
  }));
}

function handleLabels(ctx: Ctx, method: string, repo: Repo, rest: string[]): Reply {
  const { store } = ctx;
  if (rest.length === 0) {
    if (method === 'POST') {
      const name = str(ctx.body, 'name');
      if (name === null || name === '') return fail(422, 'Validation Failed: name is required');
      const label = store.addLabel(repo, name, str(ctx.body, 'color') ?? 'ededed', str(ctx.body, 'description'));
      if (label === null) return fail(422, 'Validation Failed: label already exists');
      return ok(201, labelJson(label));
    }
    if (method === 'GET') {
      const all = [...repo.labels.values()].map(labelJson);
      const { page, headers } = paginate(ctx, all, `/api/v3/repos/${store.ownerOf(repo)}/${repo.name}/labels`);
      return ok(200, page, headers);
    }
  }
  return notFound();
}

function handleIssues(ctx: Ctx, method: string, repo: Repo, rest: string[]): Reply {
  const { store } = ctx;
  const owner = store.ownerOf(repo);
  const repoPath = `/api/v3/repos/${owner}/${repo.name}`;
  if (rest.length === 0) {
    if (method === 'POST') {
      const title = str(ctx.body, 'title');
      if (title === null) return fail(422, 'Validation Failed: title is required');
      const labels = Array.isArray(ctx.body?.labels) ? (ctx.body!.labels as unknown[]).filter((l): l is string => typeof l === 'string') : [];
      for (const name of labels) {
        if (!repo.labels.has(name)) return fail(422, 'Validation Failed: label does not exist');
      }
      const issue = store.addIssue(repo, title, str(ctx.body, 'body') ?? '', labels);
      return ok(201, issueJson(store, repo, issue, ctx.base));
    }
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      let list = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') list = list.filter((i) => i.state === state);
      const direction = ctx.query.get('direction') ?? 'desc';
      list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const all = list.map((i) => issueJson(store, repo, i, ctx.base));
      const { page, headers } = paginate(ctx, all, `${repoPath}/issues`);
      return ok(200, page, headers);
    }
    return notFound();
  }
  const number = Number(rest[0]);
  const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
  if (rest.length === 1) {
    if (issue === undefined) return notFound();
    if (method === 'GET') return ok(200, issueJson(store, repo, issue, ctx.base));
    if (method === 'PATCH') {
      if (ctx.body !== null) {
        if (typeof ctx.body.title === 'string') issue.title = ctx.body.title;
        if (typeof ctx.body.body === 'string') issue.body = ctx.body.body;
        if (ctx.body.state === 'open' || ctx.body.state === 'closed') issue.state = ctx.body.state;
        if (Array.isArray(ctx.body.labels)) {
          const labels = (ctx.body.labels as unknown[]).filter((l): l is string => typeof l === 'string');
          for (const name of labels) if (!repo.labels.has(name)) return fail(422, 'Validation Failed: label does not exist');
          issue.labels = labels;
        }
      }
      issue.updatedAt = store.now();
      return ok(200, issueJson(store, repo, issue, ctx.base));
    }
    return notFound();
  }
  if (rest.length === 2 && rest[1] === 'comments') {
    if (issue === undefined) return notFound();
    if (method === 'POST') {
      const body = str(ctx.body, 'body');
      if (body === null) return fail(422, 'Validation Failed: body is required');
      const comment = store.addComment(issue, body);
      return ok(201, commentJson(store, repo, comment, ctx.base));
    }
    if (method === 'GET') {
      const all = issue.comments.map((c) => commentJson(store, repo, c, ctx.base));
      const { page, headers } = paginate(ctx, all, `${repoPath}/issues/${number}/comments`);
      return ok(200, page, headers);
    }
  }
  return notFound();
}

function handlePulls(ctx: Ctx, method: string, repo: Repo, rest: string[]): Reply {
  const { store } = ctx;
  const owner = store.ownerOf(repo);
  const repoPath = `/api/v3/repos/${owner}/${repo.name}`;
  if (rest.length === 0) {
    if (method === 'POST') {
      const title = str(ctx.body, 'title');
      const headRaw = str(ctx.body, 'head');
      const baseRaw = str(ctx.body, 'base');
      if (title === null || headRaw === null || baseRaw === null) return fail(422, 'Validation Failed: title, head and base are required');
      const head = headRaw.includes(':') ? headRaw.split(':').pop()! : headRaw;
      const base = baseRaw.includes(':') ? baseRaw.split(':').pop()! : baseRaw;
      if (store.branchTip(repo, head) === null || store.branchTip(repo, base) === null) return fail(422, 'Validation Failed: head or base branch does not exist');
      const pull = store.addPull(repo, title, str(ctx.body, 'body') ?? '', head, base);
      return ok(201, pullJson(store, repo, pull, ctx.base));
    }
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      let list = [...repo.pulls.values()];
      if (state === 'open' || state === 'closed') list = list.filter((p) => p.state === state);
      list.sort((a, b) => b.number - a.number);
      const all = list.map((p) => pullJson(store, repo, p, ctx.base));
      const { page, headers } = paginate(ctx, all, `${repoPath}/pulls`);
      return ok(200, page, headers);
    }
    return notFound();
  }
  const number = Number(rest[0]);
  const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
  if (rest.length === 1) {
    if (pull === undefined) return notFound();
    if (method === 'GET') return ok(200, pullJson(store, repo, pull, ctx.base));
    if (method === 'PATCH') {
      if (ctx.body !== null) {
        if (typeof ctx.body.title === 'string') pull.title = ctx.body.title;
        if (typeof ctx.body.body === 'string') pull.body = ctx.body.body;
        if (ctx.body.state === 'open' || ctx.body.state === 'closed') pull.state = ctx.body.state;
      }
      pull.updatedAt = store.now();
      return ok(200, pullJson(store, repo, pull, ctx.base));
    }
    return notFound();
  }
  if (pull === undefined) return notFound();
  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    const files = pullFiles(store, repo, pull);
    const { page, headers } = paginate(ctx, files, `${repoPath}/pulls/${number}/files`);
    return ok(200, page, headers);
  }
  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    return mergePull(ctx, repo, pull);
  }
  return notFound();
}

/** The changed-file list between a pull's merge base and its head tip. */
export function pullFiles(store: Store, repo: Repo, pull: Pull): Record<string, unknown>[] {
  const headTip = store.branchTip(repo, pull.headRef);
  const baseTip = store.branchTip(repo, pull.baseRef);
  if (headTip === null || baseTip === null) return [];
  const mergeBase = store.git.mergeBase(baseTip, headTip) ?? baseTip;
  const baseFiles = store.filesAt(repo, mergeBase);
  const headFiles = store.filesAt(repo, headTip);
  const out: Record<string, unknown>[] = [];
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const before = baseFiles.get(path);
    const after = headFiles.get(path);
    if (before === after) continue;
    const { additions, deletions } = lineDiff(
      before === undefined ? null : store.git.blobData(before),
      after === undefined ? null : store.git.blobData(after),
    );
    out.push({
      sha: after ?? before ?? '',
      filename: path,
      status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
      patch: '',
    });
  }
  return out;
}

/** Squash-merge (or merge) a pull request onto its base branch. */
export function mergePull(ctx: Ctx, repo: Repo, pull: Pull): Reply {
  const { store } = ctx;
  if (pull.merged) return fail(405, 'Pull Request is not mergeable: it has already been merged');
  if (pull.state !== 'open') return fail(405, 'Pull Request is not mergeable: it is closed');
  const headTip = store.branchTip(repo, pull.headRef);
  const baseTip = store.branchTip(repo, pull.baseRef);
  if (headTip === null || baseTip === null) return fail(405, 'Pull Request is not mergeable: a branch is missing');
  const mergeBase = store.git.mergeBase(baseTip, headTip);
  const baseFiles = store.filesAt(repo, mergeBase);
  const oursFiles = store.filesAt(repo, baseTip);
  const theirsFiles = store.filesAt(repo, headTip);
  const merged = threeWayMerge(baseFiles, oursFiles, theirsFiles);
  if (merged === null) return fail(405, 'Pull Request is not mergeable: it has conflicts');
  const method = str(ctx.body, 'merge_method') ?? 'merge';
  let sha: string;
  if (method === 'squash') {
    const tree = store.git.buildTree(merged);
    sha = store.git.putCommit(tree, [baseTip], `${pull.title} (#${pull.number})`);
    store.setBranch(repo, pull.baseRef, sha);
  } else {
    const tree = store.git.buildTree(merged);
    sha = store.git.putCommit(tree, [baseTip, headTip], `Merge pull request #${pull.number}: ${pull.title}`);
    store.setBranch(repo, pull.baseRef, sha);
  }
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = store.now();
  pull.mergeCommitSha = sha;
  pull.updatedAt = pull.mergedAt;
  return ok(200, { sha, merged: true, message: 'Pull Request successfully merged' });
}

/** Serialize and send a Reply; used by app.ts for every JSON surface. */
export function sendReply(res: ServerResponse, reply: Reply, extraHeaders: Record<string, string>): void {
  if (reply.status === 204 || reply.body === null) {
    res.writeHead(reply.status, { ...extraHeaders, ...(reply.headers ?? {}) });
    res.end();
    return;
  }
  const text = `${JSON.stringify(reply.body)}\n`;
  res.writeHead(reply.status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    ...extraHeaders,
    ...(reply.headers ?? {}),
  });
  res.end(text);
}

export type { IncomingMessage };
