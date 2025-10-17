import type { Env } from '..';
import { GitHubClient } from '../github'; // Use the new, consolidated GitHub client
import { getGeminiModel } from '../gemini'; // Assuming you have a Gemini client

/**
 * The main function for running a targeted, multi-step research task.
 * @param db - The D1 database instance.
 * @param ghClient - The GitHub API client.
 * @param aiModel - The AI model for analysis.
 * @param taskId - The unique ID for this research task.
 * @param query - The GitHub search query.
 * @param rounds - The number of search iterations to perform.
 */
export async function runTargetedResearch(
  db: D1Database,
  ghClient: GitHubClient,
  aiModel: any, // Replace with your actual AI model type
  taskId: string,
  query: string,
  rounds: number = 5,
) {
  console.log(`Starting targeted research task ${taskId} for query: "${query}"`);

  await db.prepare('UPDATE research_tasks SET status = ? WHERE id = ?').bind('in_progress', taskId).run();

  try {
    for (let i = 0; i < rounds; i++) {
      console.log(`[Task ${taskId}] Starting search round ${i + 1}/${rounds}`);
      const searchResults = await ghClient.searchCode(`${query} in:readme,description`, {
        per_page: 10, // Limit to 10 results per round to be thorough
        page: i + 1,
      });

      if (searchResults.items.length === 0) {
        console.log(`[Task ${taskId}] No more results found. Ending search.`);
        break;
      }

      for (const item of searchResults.items) {
        const repoUrl = item.repository.html_url;

        // Log every repository we look at for transparency
        const { success } = await db
          .prepare('INSERT INTO research_results (task_id, repo_url, ai_analysis, is_relevant) VALUES (?, ?, ?, ?)')
          .bind(taskId, repoUrl, 'Analysis pending...', false)
          .run();

        if (!success) {
            console.warn(`[Task ${taskId}] Repo ${repoUrl} already processed for this task. Skipping.`);
            continue;
        }

        try {
          const readmeContent = await ghClient.getFileContent(
            item.repository.owner.login,
            item.repository.name,
            'README.md',
          );

          // Use AI to analyze the content
          const prompt = `Analyze the following README from ${repoUrl} to determine if it uses shadcn within a Cloudflare Worker project. Provide a one-sentence summary of your findings. README content: \n\n${readmeContent.substring(0, 4000)}`;

          const aiResponse = await aiModel.generateContent(prompt);
          const aiAnalysis = aiResponse.response.text();
          const isRelevant = aiAnalysis.toLowerCase().includes('yes');

          // Update the database record with the full analysis
          await db
            .prepare('UPDATE research_results SET ai_analysis = ?, is_relevant = ? WHERE task_id = ? AND repo_url = ?')
            .bind(aiAnalysis, isRelevant, taskId, repoUrl)
            .run();

        } catch (e: any) {
             await db
            .prepare('UPDATE research_results SET ai_analysis = ? WHERE task_id = ? AND repo_url = ?')
            .bind(`Failed to analyze: ${e.message}`, taskId, repoUrl)
            .run();
        }
      }
    }
    await db.prepare('UPDATE research_tasks SET status = ? WHERE id = ?').bind('completed', taskId).run();
    console.log(`[Task ${taskId}] Research completed successfully.`);

  } catch (error: any) {
    console.error(`[Task ${taskId}] Research failed: ${error.message}`);
    await db.prepare('UPDATE research_tasks SET status = ?, ai_analysis = ? WHERE id = ?').bind('failed', `Error: ${error.message}`, taskId).run();
  }
}

/**
 * Runs the proactive daily discovery task.
 * @param env - The Cloudflare worker environment.
 */
export async function runDailyDiscovery(env: Env) {
    console.log("Starting daily discovery task...");
    const db = env.DB;
    if (!env.GITHUB_TOKEN) {
        throw new Error("GITHUB_TOKEN is required for daily discovery.");
    }
    const ghClient = new GitHubClient({ personalAccessToken: env.GITHUB_TOKEN });
    const aiModel = getGeminiModel(env);

    // 1. Fetch interests
    const { results: interests } = await db.prepare('SELECT query FROM user_interests').all<{query: string}>();
    if (!interests || interests.length === 0) {
        console.log("No user interests found. Skipping daily discovery.");
        return;
    }

    // 2. Search for each interest
    let allRelevantRepos: { repo_url: string; ai_analysis: string | null }[] = [];
    for (const interest of interests) {
        const searchResults = await ghClient.searchRepositories(interest.query, { sort: 'updated', per_page: 5 });

        for(const repo of searchResults.items) {
             // 3. Check if already sent
            const { results: existing } = await db.prepare('SELECT 1 FROM sent_digests WHERE repo_url = ?').bind(repo.html_url).all();
            if (existing && existing.length > 0) {
                continue; // Skip if already sent
            }

            const analysis = repo.description || "No description available.";
            allRelevantRepos.push({ repo_url: repo.html_url, ai_analysis: analysis });
        }
    }

    // 4. Send email if new repos were found
    const recipientEmail = "your-personal-email@example.com"; // IMPORTANT: Replace with your email
    if (allRelevantRepos.length > 0) {
        await sendDailyDigest(env, recipientEmail, allRelevantRepos);

        // 5. Mark as sent
        const stmt = db.prepare('INSERT INTO sent_digests (repo_url) VALUES (?)');
        const inserts = allRelevantRepos.map(repo => stmt.bind(repo.repo_url));
        await db.batch(inserts);
    } else {
        console.log("No new repositories found for the daily digest.");
        // Optional: send an email saying nothing was found
        // await sendDailyDigest(env, recipientEmail, []);
    }
}
