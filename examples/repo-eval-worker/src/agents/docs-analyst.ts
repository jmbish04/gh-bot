export type DocsAnalysisInput = {
    repoUrl: string;
    readme: string;
};

export type DocsAnalysisResult = {
    qualityNotes: string;
};

export async function analyzeDocumentation({ repoUrl, readme }: DocsAnalysisInput): Promise<DocsAnalysisResult> {
    console.log(`Reviewing documentation for ${repoUrl}...`);
    const hasUsageSection = /##\s+Usage/i.test(readme);
    const qualityNotes = hasUsageSection
        ? "README includes a Usage section; consider adding troubleshooting guidance."
        : "README lacks a Usage section; add setup and usage instructions.";
    return { qualityNotes };
}
