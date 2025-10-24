export const PULL_REQUEST_CORE = `
  fragment PullRequestCore on PullRequest {
    id
    number
    title
    state
    merged
    baseRefName
    headRefName
    baseRefOid
    headRefOid
    url
  }
`;
