export type SecurityAnalysisInput = {
    repoUrl: string;
    fileList: string[];
};

export type SecurityAnalysisResult = {
    findings: string;
};

export async function analyzeSecurity({ repoUrl, fileList }: SecurityAnalysisInput): Promise<SecurityAnalysisResult> {
    console.log(`Running security scan for ${repoUrl}...`);
    const containsLockfile = fileList.some((file) => file.endsWith("package-lock.json") || file.endsWith("pnpm-lock.yaml"));
    const findings = containsLockfile
        ? "Lockfile present; recommend running npm audit or equivalent."
        : "No lockfile found; consider adding one to ensure reproducible installs.";
    return { findings };
}
