import { GraphQLHttpClient } from '../core/client';
import { PAGE_INFO } from '../fragments/page-info.gql';
import { PULL_REQUEST_CORE } from '../fragments/pull-request.gql';

export const GET_PULL_REQUEST = `
  ${PULL_REQUEST_CORE}
  query PullRequestByNumber($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        ...PullRequestCore
        reviews(first: 20) {
          nodes {
            author {
              login
            }
            state
            submittedAt
          }
          pageInfo {
            ...PageInfoFields
          }
        }
      }
    }
  }
  ${PAGE_INFO}
`;

export async function getPullRequest(
  client: GraphQLHttpClient,
  owner: string,
  name: string,
  number: number
): Promise<any> {
  const data = await client.request<{ repository: { pullRequest: any } }>(GET_PULL_REQUEST, { owner, name, number });
  return data.repository?.pullRequest;
}
