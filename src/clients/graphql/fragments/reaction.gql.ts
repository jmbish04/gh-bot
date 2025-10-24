export const REACTION_GROUP = `
  fragment ReactionGroup on ReactionGroup {
    content
    users(first: 10) {
      nodes {
        login
      }
    }
    viewerHasReacted
  }
`;
