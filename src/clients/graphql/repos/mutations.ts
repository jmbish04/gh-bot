import { GraphQLHttpClient } from '../core/client';

export const UPDATE_TOPICS = `
  mutation UpdateRepositoryTopics($repositoryId: ID!, $topics: [String!]!) {
    updateTopics(input: { repositoryId: $repositoryId, topicNames: $topics }) {
      repository {
        id
        repositoryTopics(first: 20) {
          nodes {
            topic {
              name
            }
          }
        }
      }
    }
  }
`;

export async function updateRepositoryTopics(
  client: GraphQLHttpClient,
  repositoryId: string,
  topics: string[]
): Promise<any> {
  const data = await client.request<{ updateTopics: any }>(UPDATE_TOPICS, { repositoryId, topics });
  return data.updateTopics?.repository;
}
