export const ISSUE_CORE = `
  fragment IssueCore on Issue {
    id
    number
    title
    state
    url
    author {
      login
    }
  }
`;
