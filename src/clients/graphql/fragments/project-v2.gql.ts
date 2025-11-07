export const PROJECT_V2_CORE = `
  fragment ProjectV2Core on ProjectV2 {
    id
    title
    number
    closed
    url
    fields(first: 20) {
      nodes {
        ... on ProjectV2FieldCommon {
          id
          name
        }
      }
    }
  }
`;
