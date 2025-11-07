export const COMMIT_CORE = `
  fragment CommitCore on Commit {
    oid
    messageHeadline
    committedDate
    authoredDate
    author {
      name
      email
      user {
        login
      }
    }
    url
  }
`;
