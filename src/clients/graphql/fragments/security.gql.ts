export const SECURITY_ADVISORY = `
  fragment SecurityAdvisoryCore on SecurityAdvisory {
    ghsaId
    summary
    description
    severity
    references {
      url
    }
  }
`;
