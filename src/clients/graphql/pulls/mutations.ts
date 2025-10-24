import { GraphQLHttpClient } from '../core/client';

export const MERGE_PULL_REQUEST = `
  mutation MergePullRequest($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod) {
    mergePullRequest(input: { pullRequestId: $pullRequestId, mergeMethod: $mergeMethod }) {
      pullRequest {
        id
        merged
        mergeCommit {
          oid
        }
      }
    }
  }
`;

export async function mergePullRequest(
  client: GraphQLHttpClient,
  pullRequestId: string,
  mergeMethod?: string
): Promise<{ id: string; merged: boolean; mergeCommit: { oid: string } } | undefined> {
  const data = await client.request<{ mergePullRequest: any }>(MERGE_PULL_REQUEST, {
    pullRequestId,
    mergeMethod,
  });
  return data.mergePullRequest?.pullRequest;
}
