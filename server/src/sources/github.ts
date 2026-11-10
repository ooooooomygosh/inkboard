// GitHub: one or more fine-grained tokens (e.g. personal + an organisation). Fine-grained tokens hide
// org repos from GraphQL's viewer.repositories, so repos are listed over REST and their status is then
// read in one aliased GraphQL query per token.
import { fetchJson } from '../util';

const GH = (token: string) => ({ Authorization: `Bearer ${token}`, 'User-Agent': 'InkBoard', Accept: 'application/vnd.github+json' });

export interface RepoState { repo: string; private: boolean; pushedAt: string; issues: number; prs: number; ci: string | null; account: string }

const PRS = `viewer {
    login
    pullRequests(first: 8, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes { title number url isDraft reviewDecision repository { nameWithOwner }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } }
    }
  }
  review: search(query: "is:open is:pr review-requested:@me archived:false", type: ISSUE, first: 8) {
    issueCount
    nodes { ... on PullRequest { title number url repository { nameWithOwner } author { login } } }
  }`;

const REPO_FIELDS = 'nameWithOwner isPrivate pushedAt issues(states: OPEN) { totalCount } pullRequests(states: OPEN) { totalCount } defaultBranchRef { target { ... on Commit { statusCheckRollup { state } } } }';

async function oneToken(token: string, account: string, skip: Set<string>) {
  const listed = await fetchJson<any[]>('https://api.github.com/user/repos?sort=pushed&per_page=15', { headers: GH(token) });
  const since = Date.now() - 60 * 86400_000;
  const mine = (listed || []).filter((r) => !r.archived && Date.parse(r.pushed_at) > since && !skip.has(r.full_name)).slice(0, 8);
  const alias = mine.map((r, i) => `r${i}: repository(owner: ${JSON.stringify(r.owner.login)}, name: ${JSON.stringify(r.name)}) { ${REPO_FIELDS} }`).join('\n');
  const q = await fetchJson<any>('https://api.github.com/graphql', {
    method: 'POST', headers: { ...GH(token), 'Content-Type': 'application/json' }, body: JSON.stringify({ query: `query {\n${PRS}\n${alias}\n}` }),
  });
  if (q.errors && !q.data) throw new Error(q.errors[0]?.message || 'graphql error');
  const d = q.data || {};
  const repos: RepoState[] = mine.map((_, i) => d[`r${i}`]).filter(Boolean).map((r: any) => ({
    repo: r.nameWithOwner, private: r.isPrivate, pushedAt: r.pushedAt, issues: r.issues.totalCount, prs: r.pullRequests.totalCount,
    ci: r.defaultBranchRef?.target?.statusCheckRollup?.state || null, account,
  }));
  return {
    login: d.viewer?.login as string,
    repos,
    reviewCount: d.review?.issueCount || 0,
    reviews: (d.review?.nodes || []).map((n: any) => ({ title: n.title, repo: n.repository.nameWithOwner, number: n.number, author: n.author?.login, url: n.url })),
    mine: (d.viewer?.pullRequests?.nodes || []).map((n: any) => ({
      title: n.title, repo: n.repository.nameWithOwner, number: n.number, draft: n.isDraft, review: n.reviewDecision,
      ci: n.commits.nodes[0]?.commit?.statusCheckRollup?.state || null,
    })),
  };
}

export const githubSource = {
  key: () => 'github',
  ttlSec: 10 * 60,
  /** tokens: [{ token, account: 'personal' | 'org' }]; the org token goes first so org repos are labelled org. */
  async fetch(tokens: { token: string; account: string }[]) {
    const seen = new Set<string>();
    const parts: Awaited<ReturnType<typeof oneToken>>[] = [];
    for (const t of tokens) {
      const p = await oneToken(t.token, t.account, seen);
      p.repos.forEach((r) => seen.add(r.repo));
      parts.push(p);
    }
    const uniq = <T,>(xs: T[], k: (x: T) => string) => xs.filter((x, i) => xs.findIndex((y) => k(y) === k(x)) === i);
    const reviews = uniq(parts.flatMap((p) => p.reviews), (x: any) => `${x.repo}#${x.number}`);
    return {
      login: parts.map((p) => p.login).filter(Boolean)[0] || '',
      repos: parts.flatMap((p) => p.repos).sort((a, b) => b.pushedAt.localeCompare(a.pushedAt)).slice(0, 10),
      reviewCount: reviews.length,
      reviews,
      mine: uniq(parts.flatMap((p) => p.mine), (x: any) => `${x.repo}#${x.number}`),
    };
  },
};

/** Tokens configured in the editor: github_token_org first, then github_token. */
export const githubTokens = (s: Record<string, string>) =>
  [s.github_token_org && { token: s.github_token_org, account: 'org' }, s.github_token && { token: s.github_token, account: 'personal' }].filter(Boolean) as { token: string; account: string }[];
