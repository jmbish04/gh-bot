/// <reference types="@cloudflare/workers-types" />
import { summarizePRWithAI } from "./modules/ai_summary";
import {
  bookmarkSuggestion,
  createColbyCommand,
  createGitHubIssue,
  createOperationProgress,
  gatherConversationContext,
  generateIssueBody,
  generateIssueTitle,
  generateOperationId,
  parseColbyCommand,
  updateColbyCommand,
  updateOperationProgress,
} from "./modules/colby";
import {
  addReactionToComment,
  getInstallationToken,
  ghGraphQL,
  ghREST,
  replyToGitHubComment,
} from "./modules/github_helpers";
import { buildFileChangesFromSuggestions } from "./modules/patcher";

interface GitHubComment {
	id: number;
	body: string;
	path?: string;
	diff_hunk?: string;
	line?: number;
	user?: {
		type: string;
	};
}

interface PREvent {
	kind: string;
	repo: string;
	prNumber: number;
	author: string;
	suggestions?: string[];
	triggers?: string[];
	installationId?: number;
	installation?: { id: number };
	commentId?: number;
	filePath?: string;
	line?: number;
	side?: string;
	diffHunk?: string;
	headRef?: string;
	headSha?: string;
	delivery?: string;
}

interface ColbyCommandArgs {
	assignToCopilot?: boolean;
}

type Env = {
	DB: D1Database;
	PR_WORKFLOWS: DurableObjectNamespace;
	GITHUB_APP_ID: string;
	GITHUB_PRIVATE_KEY: string;
	CF_ACCOUNT_ID: string;
	CF_API_TOKEN: string;
	SUMMARY_CF_MODEL: string;
	AI?: unknown;
};

/**
 * Durable Object class for managing pull request workflows.
 *
 * This class handles events related to pull requests, such as summarizing PRs,
 * applying suggestions, and interacting with GitHub APIs.
 */
export class PrWorkflow {
	state: DurableObjectState;
	env: Env;
	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
		this.env = env;
	}

	/**
	 * Handles incoming HTTP requests to the Durable Object.
	 *
	 * @param req - The incoming HTTP request.
	 * @returns A Response object indicating the result of the request handling.
	 */
	async fetch(req: Request) {
		const url = new URL(req.url);
		if (url.pathname === "/event" && req.method === "POST") {
			const evt = (await req.json()) as PREvent;
			// serialize per PR
			return await this.state.blockConcurrencyWhile(async () =>
				this.handleEvent(evt),
			);
		}
		return new Response("not found", { status: 404 });
	}

	private async handleEvent(evt: PREvent) {
		const startTime = Date.now();

		console.log("[DO] Event received with full context:", {
			kind: evt.kind,
			repo: evt.repo,
			prNumber: evt.prNumber,
			author: evt.author,
			hasSuggestions:
				Array.isArray(evt.suggestions) && evt.suggestions.length > 0,
			suggestionsCount: evt.suggestions?.length || 0,
			triggers: evt.triggers || [],
			installationId: evt.installationId,
			// Context data for comment targeting
			commentId: evt.commentId,
			filePath: evt.filePath,
			line: evt.line,
			side: evt.side,
			diffHunk: evt.diffHunk ? "present" : "none",
			headRef: evt.headRef,
			headSha: evt.headSha,
		});

		try {
			// Basic validation for anything that touches GitHub
			const [owner, repo] = (evt.repo || "").split("/");
			if (!owner || !repo) {
				console.log("[DO] ERROR: Invalid repo format:", evt.repo);
				return new Response("invalid repo format", { status: 400 });
			}

			const needsAuth = [
				"review_comment",
				"pr_review",
				"issue_comment",
				"pull_request",
			].includes(evt.kind);
			if (needsAuth && !evt.installationId) {
				console.log(
					"[DO] ERROR: Missing installationId for event type:",
					evt.kind,
				);
				return new Response("missing installationId", { status: 400 });
			}

			const hasSuggestions =
				Array.isArray(evt.suggestions) && evt.suggestions.length > 0;
			const triggers = Array.isArray(evt.triggers)
				? evt.triggers.map((t: string) => String(t).toLowerCase())
				: [];

			// Log webhook command details for analysis
			await this.logWebhookCommands(evt, triggers, startTime);

			// ---- Commands first (explicit instructions win) ----
			if (triggers.length) {
				// Provide immediate feedback for any commands
				await this.sendImmediateFeedback(evt, triggers);

				// Handle /colby commands
				const colbyTriggers = triggers.filter((t: string) =>
					String(t).startsWith("/colby"),
				);
				if (colbyTriggers.length > 0) {
					return await this.handleColbyCommands(evt, colbyTriggers);
				}

				// /apply applies suggestions if present; otherwise it tries to harvest from the related review/comment
				if (triggers.some((t: string) => String(t).startsWith("/apply"))) {
					if (!hasSuggestions && evt.kind === "issue_comment") {
						// No suggestions in issue comments; tell user how to use it
						await this.commentOnPR(
							evt,
							`ℹ️ No \`\`\`suggestion\`\`\` blocks found to apply. Add a review comment with a \`\`\`suggestion\`\`\` fence and re-run /apply.`,
						);
						return new Response("no-suggestions", { status: 200 });
					}
					const res = await this.applySuggestionsCommit(evt);
					return new Response(res, { status: 200 });
				}

				if (triggers.some((t: string) => String(t).startsWith("/summarize"))) {
					await this.postPRSummary(evt);
					return new Response("summarized", { status: 200 });
				}

				// TODO: /fix, /lint, /test hooks here
			}

			// ---- Implicit behavior: auto-apply when suggestions exist ----
			if (
				(evt.kind === "review_comment" || evt.kind === "pr_review") &&
				hasSuggestions &&
				evt.suggestions
			) {
				console.log("[DO] Auto-applying suggestions:", {
					kind: evt.kind,
					suggestionsCount: evt.suggestions.length,
					repo: evt.repo,
					prNumber: evt.prNumber,
				});

				// Optional: cap the number to avoid huge commits
				if (evt.suggestions.length > 50) {
					await this.commentOnPR(
						evt,
						`⚠️ Found ${evt.suggestions.length} suggestions; capping at 50. Use multiple /apply runs if needed.`,
					);
					evt.suggestions = evt.suggestions.slice(0, 50);
				}

				try {
					const res = await this.applySuggestionsCommit(evt);
					console.log("[DO] Auto-apply result:", res);
					return new Response(res, { status: 200 });
				} catch (applyError) {
					console.log("[DO] ERROR in auto-apply:", applyError);
					throw applyError;
				}
			}

			// PR lifecycle events (future: label gates, synchronize hooks, etc.)
			if (evt.kind === "pull_request") {
				return new Response("pr-event-ack", { status: 200 });
			}

			return new Response("ok", { status: 200 });
		} catch (err: unknown) {
			console.log("[DO] ERROR in handleEvent:", {
				error: err instanceof Error ? err.message : String(err),
				stack: err instanceof Error ? err.stack : undefined,
				event: {
					kind: evt?.kind,
					repo: evt?.repo,
					prNumber: evt?.prNumber,
					author: evt?.author,
				},
			});

			// Immediate error feedback to user
			const errorMsg = `❌ **Command Failed**: ${err instanceof Error ? err.message : "Unknown error occurred"}`;
			try {
				await this.commentOnPR(evt, errorMsg);
			} catch (commentErr) {
				console.log("Failed to post error comment:", commentErr);
			}

			// Log the command failure
			await this.logCommandFailure(evt, err, startTime);

			// Distinguish race vs. generic error (useful if you add requeue-on-409 later)
			const msg = (err instanceof Error ? err.message : "").toLowerCase();
			const code =
				msg.includes("409") || msg.includes("expectedheadoid") ? 409 : 500;
			return new Response("error", { status: code });
		}
	}

	private async applySuggestionsCommit(evt: PREvent) {
		const [owner, repo] = evt.repo.split("/");
		const installationId = evt.installationId || evt.installation?.id;

		// Validate required fields
		if (!installationId) {
			throw new Error(
				"Missing installationId - cannot authenticate with GitHub",
			);
		}
		if (!evt.headRef) {
			throw new Error("Missing headRef - cannot determine target branch");
		}
		if (!evt.headSha) {
			throw new Error("Missing headSha - cannot create commit safely");
		}

		const token = await getInstallationToken(this.env, installationId);

		// If we have suggestions directly, use them
		let filesMap: Record<string, string> = {};

		if (evt.suggestions && evt.suggestions.length > 0) {
			// 1) Build file changes from suggestions using the file's HEAD content + diff context
			filesMap = await buildFileChangesFromSuggestions({
				token,
				owner,
				repo,
				headSha: evt.headSha,
				filePath: evt.filePath || "",
				diffHunk: evt.diffHunk || "",
				suggestions: evt.suggestions,
			});
		} else {
			// 2) For /apply without suggestions, try to harvest from PR review comments
			filesMap = await this.harvestSuggestionsFromPR(
				token,
				owner,
				repo,
				evt.prNumber,
				evt.headSha,
			);
		}

		if (!filesMap || Object.keys(filesMap).length === 0) {
			return "no-applicable-suggestions";
		}

		// 2) Commit via GraphQL createCommitOnBranch
		const input = {
			branch: { repositoryNameWithOwner: evt.repo, branchName: evt.headRef },
			expectedHeadOid: evt.headSha,
			message: {
				headline: `chore: apply ${Object.keys(filesMap).length} suggestion(s)`,
			},
			fileChanges: {
				additions: Object.entries(filesMap).map(([path, contents]) => ({
					path,
					contents,
				})),
			},
		};

		try {
			const r = await ghGraphQL(
				token,
				`
        mutation Commit($input: CreateCommitOnBranchInput!) {
          createCommitOnBranch(input: $input) { commit { oid url } }
        }`,
				{ input },
			);

			if (!r?.data?.createCommitOnBranch?.commit?.oid) {
				// Check for specific GitHub API errors
				if (r?.errors) {
					const errorMsg = r.errors.map((e: { message: string }) => e.message).join("; ");
					if (
						errorMsg.toLowerCase().includes("expectedheadoid") ||
						errorMsg.toLowerCase().includes("expected head oid")
					) {
						throw new Error(`Head moved: ${errorMsg}`);
					}
					throw new Error(`GitHub API error: ${errorMsg}`);
				}
				throw new Error("createCommitOnBranch failed: " + JSON.stringify(r));
			}

			// 3) Comment back with success
			await ghREST(
				token,
				"POST",
				`/repos/${owner}/${repo}/issues/${evt.prNumber}/comments`,
				{
					body: `✅ Applied ${Object.keys(filesMap).length} suggestion(s). Commit: ${r.data.createCommitOnBranch.commit.url}`,
				},
			);

			return "committed";
		} catch (err: unknown) {
			// Handle specific error types
			const errorMsg = err instanceof Error ? err.message : String(err);
			if (
				errorMsg.toLowerCase().includes("expectedheadoid") ||
				errorMsg.toLowerCase().includes("head moved")
			) {
				// This is a 409-style conflict - head has moved since we started
				throw new Error(`409: ${errorMsg}`);
			}
			throw err;
		}
	}

	private async postPRSummary(evt: PREvent) {
		const [owner, repo] = evt.repo.split("/");
		const installationId = evt.installationId || evt.installation?.id;

		if (!installationId) {
			throw new Error("Missing installationId for PR summary");
		}

		const token = await getInstallationToken(this.env, installationId);

		// Collect PR metadata + changed files
		const pr = await ghREST(
			token,
			"GET",
			`/repos/${owner}/${repo}/pulls/${evt.prNumber}`,
		);
		const files = await ghREST(
			token,
			"GET",
			`/repos/${owner}/${repo}/pulls/${evt.prNumber}/files?per_page=100`,
		);

		const summary = await summarizePRWithAI(this.env, { pr, files });

		await ghREST(
			token,
			"POST",
			`/repos/${owner}/${repo}/issues/${evt.prNumber}/comments`,
			{ body: `🧠 **PR Summary**\n\n${summary}` },
		);
	}

	private async commentOnPR(evt: PREvent, body: string) {
		console.log("[DO] Attempting to comment on PR:", {
			hasEvent: !!evt,
			hasInstallationId: !!evt?.installationId,
			hasRepo: !!evt?.repo,
			hasPrNumber: !!evt?.prNumber,
			repo: evt?.repo,
			prNumber: evt?.prNumber,
			bodyLength: body?.length,
			eventKind: evt?.kind,
			filePath: evt?.filePath,
			line: evt?.line,
			hasCommentId: !!evt?.commentId,
			commentId: evt?.commentId,
		});

		if (!evt || !evt.installationId || !evt.repo || !evt.prNumber) {
			console.log("[DO] ERROR: Missing required fields for commenting");
			return;
		}

		const [owner, repo] = evt.repo.split("/");
		console.log("[DO] Getting token for comment...", {
			owner,
			repo,
			prNumber: evt.prNumber,
		});

		try {
			const token = await getInstallationToken(this.env, evt.installationId);
			console.log("[DO] Token obtained, posting comment...");

			let response: unknown;

			// For review comments with commentId, use the robust reply handler
			if (evt.kind === "review_comment" && evt.commentId) {
				console.log(
					"[DO] Using robust comment reply handler for review comment:",
					evt.commentId,
				);

				try {
					response = await replyToGitHubComment({
						installationToken: token,
						owner,
						repo,
						prNumber: evt.prNumber,
						commentId: evt.commentId,
						body,
					});
					console.log("[DO] Successfully posted reply via robust handler");
				} catch (replyError) {
					console.log(
						"[DO] Robust reply handler failed, falling back to main PR thread:",
						replyError,
					);
					// Final fallback to main PR thread
					response = await ghREST(
						token,
						"POST",
						`/repos/${owner}/${repo}/issues/${evt.prNumber}/comments`,
						{ body },
					);
				}
			} else {
				// For other comment types, post to main PR thread
				console.log("[DO] Posting comment to main PR thread");
				response = await ghREST(
					token,
					"POST",
					`/repos/${owner}/${repo}/issues/${evt.prNumber}/comments`,
					{ body },
				);
			}

			console.log("[DO] Comment posted successfully:", {
				responseKeys: Object.keys(response || {}),
				hasResponse: !!response,
			});
		} catch (error) {
			console.log("[DO] ERROR posting comment:", error);
			throw error;
		}
	}

	private async harvestSuggestionsFromPR(
		token: string,
		owner: string,
		repo: string,
		prNumber: number,
		headSha: string,
	): Promise<Record<string, string>> {
		try {
			// Get all review comments for this PR
			const reviewComments = await ghREST(
				token,
				"GET",
				`/repos/${owner}/${repo}/pulls/${prNumber}/comments`,
			);

			if (!Array.isArray(reviewComments) || reviewComments.length === 0) {
				return {};
			}

			// Group suggestions by file path
			const suggestionsByFile: Record<
				string,
				Array<{ suggestions: string[]; diffHunk: string }>
			> = {};

			for (const comment of reviewComments) {
				if (!comment.body || !comment.path || !comment.diff_hunk) continue;

				const suggestions = this.extractSuggestions(comment.body);
				if (suggestions.length === 0) continue;

				if (!suggestionsByFile[comment.path]) {
					suggestionsByFile[comment.path] = [];
				}

				suggestionsByFile[comment.path].push({
					suggestions,
					diffHunk: comment.diff_hunk,
				});
			}

			// Apply suggestions for each file
			const allFilesMap: Record<string, string> = {};

			for (const [filePath, commentGroups] of Object.entries(
				suggestionsByFile,
			)) {
				for (const group of commentGroups) {
					const fileMap = await buildFileChangesFromSuggestions({
						token,
						owner,
						repo,
						headSha,
						filePath,
						diffHunk: group.diffHunk,
						suggestions: group.suggestions,
					});

					// Merge file changes (later changes override earlier ones for same file)
					Object.assign(allFilesMap, fileMap);
				}
			}

			return allFilesMap;
		} catch (err) {
			// console.error is not available in Workers, use console.log for basic logging
			console.log("Failed to harvest suggestions from PR:", err);
			return {};
		}
	}

	private extractSuggestions(text: string): string[] {
		const out: string[] = [];
		const re = /```suggestion\s*\n([\s\S]*?)```/g;

		let match = re.exec(text);
		while (match !== null) {
			out.push(match[1]);
			match = re.exec(text);
		}
		return out;
	}

	private async handleColbyCommands(evt: PREvent, colbyTriggers: string[]) {
		// Immediately respond with eggplant emoji reaction
		if (evt.commentId && evt.installationId) {
			try {
				const token = await getInstallationToken(this.env, evt.installationId);
				const [owner, repo] = evt.repo.split("/");
				await addReactionToComment({
					installationToken: token,
					owner,
					repo,
					commentId: evt.commentId,
					content: "eggplant",
				});
				console.log("[DO] Added eggplant reaction to comment:", evt.commentId);
			} catch (error) {
				console.log(
					"[DO] Failed to add reaction, falling back to comment:",
					error,
				);
				await this.commentOnPR(evt, "🍆 working on it");
			}
		} else {
			// Fallback if no commentId or installationId
			await this.commentOnPR(evt, "🍆 working on it");
		}

		// Process each colby command
		for (const trigger of colbyTriggers) {
			const { command, args } = parseColbyCommand(trigger);
			const operationId = generateOperationId();

			// Create command record
			const commandId = await createColbyCommand(this.env, {
				deliveryId: evt.delivery || "",
				repo: evt.repo,
				prNumber: evt.prNumber,
				author: evt.author,
				command,
				commandArgs: args,
				status: "working",
			});

			// Create progress tracking
			await createOperationProgress(
				this.env,
				operationId,
				command,
				evt.repo,
				evt.prNumber,
			);

			try {
				switch (command) {
					case "implement":
						await this.handleImplementCommand(
							evt,
							commandId,
							operationId,
							args,
						);
						break;
					case "create_issue":
						await this.handleCreateIssueCommand(
							evt,
							commandId,
							operationId,
							args,
						);
						break;
					case "bookmark_suggestion":
						await this.handleBookmarkSuggestionCommand(
							evt,
							commandId,
							operationId,
							args,
						);
						break;
					case "extract_suggestions":
						await this.handleExtractSuggestionsCommand(
							evt,
							commandId,
							operationId,
							args,
						);
						break;
					case "help":
						await this.handleHelpCommand(evt, commandId, operationId, args);
						break;
					default:
						await this.commentOnPR(evt, `❌ Unknown colby command: ${command}`);
						await updateColbyCommand(this.env, commandId, {
							status: "failed",
							errorMessage: `Unknown command: ${command}`,
						});
				}
			} catch (error: unknown) {
				await this.commentOnPR(
					evt,
					`❌ Error executing ${command}: ${error instanceof Error ? error.message : String(error)}`,
				);
				await updateColbyCommand(this.env, commandId, {
					status: "failed",
					errorMessage: error instanceof Error ? error.message : String(error),
				});
				await updateOperationProgress(this.env, operationId, {
					status: "failed",
					errorMessage: error instanceof Error ? error.message : String(error),
				});
			}
		}

		return new Response("colby-commands-processed", { status: 200 });
	}

	private async handleImplementCommand(
		evt: PREvent,
		commandId: number,
		operationId: string,
		_args: ColbyCommandArgs,
	) {
		await updateOperationProgress(this.env, operationId, {
			currentStep: "Analyzing suggestions...",
			progressPercent: 25,
		});

		// For implement command, we apply suggestions similar to /apply but with enhanced feedback
		const hasSuggestions =
			Array.isArray(evt.suggestions) && evt.suggestions.length > 0;

		if (!hasSuggestions) {
			let helpMessage = "";

			if (evt.kind === "review_comment") {
				helpMessage = `ℹ️ No code suggestions found in this review comment. To use \`/colby implement\`:

1. **Add suggestions in your comment** using \`\`\`suggestion\` blocks:
   \`\`\`suggestion
   // Your improved code here
   \`\`\`

2. **Or try other commands**:
   - \`/colby help\` - See all available commands
   - \`/colby create issue\` - Create an issue from this comment`;
			} else {
				helpMessage = `ℹ️ No code suggestions found. To use \`/colby implement\`:

1. **Comment on a specific line** with \`\`\`suggestion\` blocks
2. **Use \`/colby help\`** to see all available commands`;
			}

			await this.commentOnPR(evt, helpMessage);
			await updateColbyCommand(this.env, commandId, {
				status: "completed",
				resultData: { message: "No suggestions to implement" },
			});
			await updateOperationProgress(this.env, operationId, {
				status: "completed",
				progressPercent: 100,
				currentStep: "No suggestions found",
			});
			return;
		}

		await updateOperationProgress(this.env, operationId, {
			currentStep: "Applying suggestions...",
			progressPercent: 50,
		});

		const result = await this.applySuggestionsCommit(evt);

		const suggestionsCount = evt.suggestions?.length || 0;
		await updateColbyCommand(this.env, commandId, {
			status: "completed",
			resultData: { implementResult: result, suggestionsCount },
		});

		await updateOperationProgress(this.env, operationId, {
			status: "completed",
			progressPercent: 100,
			currentStep: `Applied ${suggestionsCount} suggestion(s)`,
			resultData: { result },
		});
	}

	private async handleCreateIssueCommand(
		evt: PREvent,
		commandId: number,
		operationId: string,
		args: ColbyCommandArgs,
	) {
		const [owner, repo] = evt.repo.split("/");
		if (!evt.installationId) {
			throw new Error("Missing installationId for create issue command");
		}
		const token = await getInstallationToken(this.env, evt.installationId);

		await updateOperationProgress(this.env, operationId, {
			currentStep: "Gathering conversation context...",
			progressPercent: 15,
		});

		// Gather rich conversation context
		let conversationContext = "";
		if (evt.commentId) {
			conversationContext = await gatherConversationContext(
				this.env,
				token,
				evt.repo,
				evt.commentId,
				evt.kind,
			);
		}

		await updateOperationProgress(this.env, operationId, {
			currentStep: "Analyzing content and generating title...",
			progressPercent: 35,
		});

		// Get PR details for context
		const pr = await ghREST(
			token,
			"GET",
			`/repos/${owner}/${repo}/pulls/${evt.prNumber}`,
		);

		// Get the current comment body or suggestions
		const commentBody =
			evt.kind === "issue_comment" || evt.kind === "review_comment"
				? Array.isArray(evt.suggestions) && evt.suggestions.length > 0
					? evt.suggestions.join("\n\n")
					: "From code review comment"
				: "From PR review";

		// Enhanced title generation with rich context
		const title = await generateIssueTitle(this.env, {
			repo: evt.repo,
			prTitle: (pr as { title?: string })?.title,
			prBody: (pr as { body?: string })?.body,
			commentBody,
			filePath: evt.filePath,
			line: evt.line,
			suggestions: evt.suggestions,
			conversationContext,
		});

		await updateOperationProgress(this.env, operationId, {
			currentStep: "Creating comprehensive issue description...",
			progressPercent: 60,
		});

		// Generate rich issue body with AI
		const issueBody = await generateIssueBody(this.env, {
			repo: evt.repo,
			prNumber: evt.prNumber,
			prTitle: (pr as { title?: string })?.title,
			prBody: (pr as { body?: string })?.body,
			author: evt.author,
			commentBody,
			filePath: evt.filePath,
			line: evt.line,
			diffHunk: evt.diffHunk,
			suggestions: evt.suggestions,
			conversationContext,
		});

		await updateOperationProgress(this.env, operationId, {
			currentStep: "Creating GitHub issue...",
			progressPercent: 80,
		});

		const assignee = args.assignToCopilot ? "copilot" : undefined;
		const labels = ["enhancement", "from-review"];

		// Add smart labels based on context
		if (evt.filePath) {
			const fileExt = evt.filePath.split(".").pop()?.toLowerCase();
			if (fileExt === "ts" || fileExt === "js")
				labels.push("typescript", "javascript");
			if (fileExt === "py") labels.push("python");
			if (fileExt === "md") labels.push("documentation");
			if (evt.filePath.includes("test")) labels.push("testing");
		}

		if (evt.suggestions && evt.suggestions.length > 0) {
			labels.push("code-suggestion");
		}

		const issue = await createGitHubIssue(
			this.env,
			token,
			evt.repo,
			title,
			issueBody,
			assignee,
			labels,
		);

		await updateOperationProgress(this.env, operationId, {
			currentStep: "Saving issue record...",
			progressPercent: 90,
		});

		// Save to colby_issues table
		try {
			await this.env.DB.prepare(`
        INSERT INTO colby_issues (colby_command_id, repo, issue_number, github_issue_id, title, body, assignee, labels)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
				.bind(
					commandId,
					evt.repo,
					issue.issueNumber,
					issue.issueId,
					title,
					issueBody,
					assignee || null,
					JSON.stringify(labels),
				)
				.run();
		} catch (error) {
			console.log(
				"Failed to save issue to database (table may not exist):",
				error,
			);
		}

		await updateColbyCommand(this.env, commandId, {
			status: "completed",
			resultData: {
				issueNumber: issue.issueNumber,
				issueUrl: issue.url,
				title,
				contextGathered: !!conversationContext,
				labelsApplied: labels,
			},
		});

		await updateOperationProgress(this.env, operationId, {
			status: "completed",
			progressPercent: 100,
			currentStep: "Issue created successfully",
			resultData: {
				issueNumber: issue.issueNumber,
				issueUrl: issue.url,
				title: title,
				hasContext: !!conversationContext,
			},
		});

		const assigneeText = args.assignToCopilot
			? " and assigned to @copilot"
			: "";
		const contextText = conversationContext ? " with conversation context" : "";
		await this.commentOnPR(
			evt,
			`✅ Created issue [#${issue.issueNumber}](${issue.url})${assigneeText}${contextText}

**Title:** ${title}`,
		);
	}

	private async handleBookmarkSuggestionCommand(
		evt: PREvent,
		commandId: number,
		operationId: string,
		_args: ColbyCommandArgs,
	) {
		await updateOperationProgress(this.env, operationId, {
			currentStep: "Extracting suggestions...",
			progressPercent: 25,
		});

		const hasSuggestions =
			Array.isArray(evt.suggestions) && evt.suggestions.length > 0;

		if (!hasSuggestions) {
			await this.commentOnPR(
				evt,
				`ℹ️ No code suggestions found to bookmark. Please add \`\`\`suggestion\`\`\` blocks with the practices you'd like to save.`,
			);
			await updateColbyCommand(this.env, commandId, {
				status: "completed",
				resultData: { message: "No suggestions to bookmark" },
			});
			await updateOperationProgress(this.env, operationId, {
				status: "completed",
				progressPercent: 100,
				currentStep: "No suggestions found",
			});
			return;
		}

		await updateOperationProgress(this.env, operationId, {
			currentStep: "Analyzing and categorizing suggestions...",
			progressPercent: 50,
		});

		const bookmarkIds: number[] = [];
		const suggestions = evt.suggestions || [];

		for (const suggestion of suggestions) {
			const bookmarkId = await bookmarkSuggestion(this.env, {
				text: suggestion,
				contextRepo: evt.repo,
				contextPr: evt.prNumber,
				contextFile: evt.filePath,
				bookmarkedBy: evt.author,
			});
			bookmarkIds.push(bookmarkId);
		}

		await updateColbyCommand(this.env, commandId, {
			status: "completed",
			resultData: {
				bookmarkIds,
				suggestionsCount: suggestions.length,
			},
		});

		await updateOperationProgress(this.env, operationId, {
			status: "completed",
			progressPercent: 100,
			currentStep: `Bookmarked ${suggestions.length} suggestion(s)`,
			resultData: { bookmarkIds, count: suggestions.length },
		});

		await this.commentOnPR(
			evt,
			`✅ Bookmarked ${suggestions.length} suggestion(s) as best practice(s). They've been categorized and added to the knowledge base.`,
		);
	}

	private async handleExtractSuggestionsCommand(
		evt: PREvent,
		commandId: number,
		operationId: string,
		_args: ColbyCommandArgs,
	) {
		const [owner, repo] = evt.repo.split("/");
		if (!evt.installationId) {
			throw new Error("Missing installationId for extract suggestions command");
		}
		const token = await getInstallationToken(this.env, evt.installationId);

		await updateOperationProgress(this.env, operationId, {
			currentStep: "Fetching PR review comments...",
			progressPercent: 20,
		});

		// Get all review comments for this PR
		const reviewComments = await ghREST(
			token,
			"GET",
			`/repos/${owner}/${repo}/pulls/${evt.prNumber}/comments`,
		);

		if (!Array.isArray(reviewComments)) {
			throw new Error("Failed to fetch review comments");
		}

		await updateOperationProgress(this.env, operationId, {
			currentStep: "Analyzing comments for suggestions...",
			progressPercent: 40,
		});

		const extractedSuggestions: Array<{
			id: number;
			suggestion: string;
			file: string | null;
			codexPrompt: string;
		}> = [];

		// Look for Gemini/AI-generated comments (typically have specific patterns)
		for (const comment of reviewComments) {
			if (!comment.body || comment.user?.type !== "Bot") continue;

			// Extract suggestion blocks or actionable feedback
			const suggestions = this.extractSuggestions(comment.body);

			if (suggestions.length > 0) {
				for (const suggestion of suggestions) {
					// Generate codex prompt for this suggestion
					const codexPrompt = await this.generateCodexPrompt(
						evt.repo,
						comment,
						suggestion,
					);

					try {
						const result = await this.env.DB.prepare(`
              INSERT INTO extracted_suggestions
              (repo, pr_number, extraction_command_id, gemini_comment_id, suggestion_text, target_file, codex_prompt)
              VALUES (?, ?, ?, ?, ?, ?, ?)
            `)
							.bind(
								evt.repo,
								evt.prNumber,
								commandId,
								comment.id?.toString() || null,
								suggestion,
								comment.path || null,
								codexPrompt,
							)
							.run();

						extractedSuggestions.push({
							id: result.meta?.last_row_id,
							suggestion,
							file: comment.path,
							codexPrompt,
						});
					} catch (error) {
						console.log(
							"Failed to save extracted suggestion (table may not exist):",
							error,
						);
						// Still add to extractedSuggestions with dummy ID for processing
						extractedSuggestions.push({
							id: Date.now(),
							suggestion,
							file: comment.path,
							codexPrompt,
						});
					}
				}
			}
		}

		await updateOperationProgress(this.env, operationId, {
			currentStep: "Generating codex prompts...",
			progressPercent: 80,
		});

		// TODO: Submit to codex if available
		// For now, we just save the prompts for manual review

		await updateColbyCommand(this.env, commandId, {
			status: "completed",
			resultData: {
				extractedCount: extractedSuggestions.length,
				suggestions: extractedSuggestions,
			},
		});

		await updateOperationProgress(this.env, operationId, {
			status: "completed",
			progressPercent: 100,
			currentStep: `Extracted ${extractedSuggestions.length} suggestion(s)`,
			resultData: { count: extractedSuggestions.length },
		});

		await this.commentOnPR(
			evt,
			`✅ Extracted ${extractedSuggestions.length} suggestion(s) from review comments. Codex prompts have been generated and saved for processing.`,
		);
	}

	private async handleHelpCommand(
		evt: PREvent,
		commandId: number,
		operationId: string,
		_args: ColbyCommandArgs,
	) {
		const helpText = `## 🤖 Colby Commands

### PR Comment Commands
- \`/colby implement\` - Apply code suggestions from review comments
- \`/colby create issue\` - Create a GitHub issue from this comment
- \`/colby create issue and assign to copilot\` - Create issue and assign to @copilot
- \`/colby bookmark this suggestion\` - Save suggestions as best practices

### PR-Level Commands
- \`/colby extract suggestions\` - Extract all suggestions from Gemini reviews

### Global Commands
- \`/colby help\` - Show this help message

### Legacy Commands (still supported)
- \`/apply\` - Apply code suggestions
- \`/summarize\` - Generate PR summary
- \`/fix\`, \`/lint\`, \`/test\` - Coming soon

---
📖 [Full Documentation](https://gh-bot.hacolby.workers.dev/help) | 🌐 [Dashboard](https://gh-bot.hacolby.workers.dev/)`;

		await this.commentOnPR(evt, helpText);

		await updateColbyCommand(this.env, commandId, {
			status: "completed",
			resultData: { message: "Help displayed" },
		});

		await updateOperationProgress(this.env, operationId, {
			status: "completed",
			progressPercent: 100,
			currentStep: "Help displayed",
		});
	}

	private async generateCodexPrompt(
		repo: string,
		comment: GitHubComment,
		suggestion: string,
	): Promise<string> {
		return `Repository: ${repo}
File: ${comment.path || "unknown"}
Line: ${comment.line || "unknown"}

Original Comment Context:
${comment.body?.slice(0, 500)}

Specific Suggestion:
${suggestion}

Task: Implement this suggestion in the codebase. Analyze the context and provide the necessary code changes.`;
	}

	private async logWebhookCommands(
		evt: PREvent,
		triggers: string[],
		startTime: number,
	) {
		if (triggers.length === 0) return;

		try {
			for (const trigger of triggers) {
				await this.env.DB.prepare(`
          INSERT INTO webhook_command_log
          (delivery_id, command_text, command_type, execution_status, started_at)
          VALUES (?, ?, ?, 'started', ?)
        `)
					.bind(
						evt.delivery,
						trigger,
						trigger.startsWith("/colby") ? "colby_command" : "legacy_command",
						startTime,
					)
					.run();
			}
		} catch (error) {
			console.log(
				"Failed to log webhook commands (table may not exist):",
				error,
			);
		}
	}

	private async sendImmediateFeedback(evt: PREvent, triggers: string[]) {
		if (triggers.length === 0) return;

		try {
			const commandList = triggers.map((t) => `\`${t}\``).join(", ");
			const feedbackMsg = `🔄 **Received**: ${commandList}\n\nProcessing your request...`;

			// Send immediate acknowledgment
			await this.commentOnPR(evt, feedbackMsg);
		} catch (error) {
			console.log("Failed to send immediate feedback:", error);
		}
	}

	private async logCommandFailure(evt: PREvent, error: unknown, _startTime: number) {
		try {
			const errorDetails = error instanceof Error ? error.message : String(error);

			await this.env.DB.prepare(`
        UPDATE webhook_command_log
        SET execution_status = 'failed', execution_result = ?, completed_at = ?
        WHERE delivery_id = ?
      `)
				.bind(errorDetails, Date.now(), evt.delivery)
				.run();
		} catch (dbError) {
			console.log(
				"Failed to log command failure (table may not exist):",
				dbError,
			);
		}
	}
}
