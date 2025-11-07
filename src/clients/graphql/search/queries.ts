import { GraphQLHttpClient } from '../core/client';
import { PAGE_INFO } from '../fragments/page-info.gql';

export const SEARCH_REPOSITORIES = `
  ${PAGE_INFO}
  query SearchRepositories($query: String!, $after: String) {
    search(type: REPOSITORY, query: $query, first: 20, after: $after) {
      repositoryCount
      pageInfo {
        ...PageInfoFields
      }
      nodes {
        ... on Repository {
          nameWithOwner
          url
          stargazerCount
        }
      }
    }
  }
`;

export async function searchRepositories(client: GraphQLHttpClient, query: string, after?: string): Promise<any> {
  const data = await client.request<{ search: any }>(SEARCH_REPOSITORIES, { query, after });
  return data.search;
}
