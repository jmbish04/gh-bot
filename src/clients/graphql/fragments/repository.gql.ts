export const REPOSITORY_CORE = `
  fragment RepositoryCore on Repository {
    id
    name
    nameWithOwner
    defaultBranchRef {
      name
    }
    owner {
      login
    }
    isPrivate
    visibility
    description
    url
  }
`;
