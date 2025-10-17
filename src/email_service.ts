import { EmailMessage } from 'cloudflare:email';
import { Env } from '..'; // Assuming your Env type is in the root index.ts

/**
 * Formats the research results into an HTML email body.
 * @param results - An array of repository analysis results.
 * @returns A string containing the HTML for the email body.
 */
function formatResultsToHtml(results: { repo_url: string; ai_analysis: string | null }[]): string {
  if (results.length === 0) {
    return `
      <h1>GitHub Daily Digest</h1>
      <p>No new interesting repositories found today based on your interests. We'll keep looking!</p>
    `;
  }

  const resultItems = results
    .map(
      (result) => `
    <div style="margin-bottom: 20px; padding: 15px; border: 1px solid #eee; border-radius: 8px;">
      <h3 style="margin-top: 0;"><a href="${result.repo_url}" target="_blank">${result.repo_url.replace('https://github.com/', '')}</a></h3>
      <p><strong>AI Analysis:</strong> ${result.ai_analysis || 'No analysis provided.'}</p>
    </div>
  `
    )
    .join('');

  return `
    <h1>GitHub Daily Digest</h1>
    <p>Here are some new repositories we found based on your interests:</p>
    ${resultItems}
  `;
}

/**
 * Sends a daily digest email with discovered repositories.
 *
 * @param {Env} env - The Cloudflare worker environment.
 * @param {string} recipientEmail - The email address to send the digest to.
 * @param {any[]} results - The research results to include in the email.
 * @throws {Error} If the email fails to send.
 */
export async function sendDailyDigest(
  env: Env,
  recipientEmail: string,
  results: { repo_url: string; ai_analysis: string | null }[],
) {
  // Ensure you have configured a sending address in your Cloudflare dashboard
  const senderEmail = 'gh-bot@yourdomain.com'; // IMPORTANT: Replace with your verified sender address
  const subject = `Your Daily GitHub Discovery Digest - ${new Date().toLocaleDateString()}`;
  const htmlBody = formatResultsToHtml(results);

  const message = new EmailMessage(senderEmail, recipientEmail, subject, htmlBody);
  message.html = htmlBody;

  try {
    await env.SEB.send(message);
    console.log(`Daily digest sent to ${recipientEmail}`);
  } catch (e: any) {
    console.error(`Failed to send email: ${e.message}`);
    throw new Error(`Failed to send email: ${e.message}`);
  }
}
