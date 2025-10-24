import { GraphQLHttpClient } from '../core/client';
import { REPOSITORY_CORE } from '../fragments/repository.gql';

export const GET_REPOSITORY = `
  ${REPOSITORY_CORE}
  query RepositoryByName($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      ...RepositoryCore
    }
  }
`;

export async function getRepository(
  client: GraphQLHttpClient,
  owner: string,
  name: string
): Promise<any> {
  const data = await client.request<{ repository: any }>(GET_REPOSITORY, { owner, name });
  return data.repository;
}
