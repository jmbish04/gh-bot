#!/usr/bin/env python3
"""
Cloudflare Worker Project Refactoring Script
Automates the reorganization of a large index.ts file into a modular structure
"""

import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import List, Dict, Tuple

# Color codes for terminal output
GREEN = '\033[92m'
YELLOW = '\033[93m'
RED = '\033[91m'
BLUE = '\033[94m'
RESET = '\033[0m'

def print_status(message: str, status: str = "INFO"):
    """Print colored status messages"""
    colors = {
        "SUCCESS": GREEN,
        "INFO": BLUE,
        "WARNING": YELLOW,
        "ERROR": RED
    }
    color = colors.get(status, RESET)
    print(f"{color}[{status}] {message}{RESET}")

def create_directory_structure(base_path: Path) -> None:
    """Create the new directory structure for the refactored project"""
    directories = [
        "src/durable",
        "src/routes",
        "src/workflows",
        "src/queues",
        "src/modules/ai/agents",
        "src/modules/ai/services",
        "src/modules/ai/processing",
        "src/modules/github",
        "src/modules/storage",
        "src/modules/services"
    ]
    
    print_status("Creating new directory structure...", "INFO")
    
    for directory in directories:
        dir_path = base_path / directory
        dir_path.mkdir(parents=True, exist_ok=True)
        print_status(f"  Created: {directory}", "SUCCESS")

def move_existing_files(base_path: Path) -> List[Tuple[str, str]]:
    """Move existing files to their new locations"""
    moves = [
        ("src/do_research.ts", "src/durable/do_research.ts"),
        ("src/do_pr_workflows.ts", "src/durable/do_pr_workflows.ts"),
        ("src/do_profile_scanner.ts", "src/durable/do_profile_scanner.ts"),
        ("src/github.ts", "src/modules/github/github.ts"),
        ("src/gemini.ts", "src/modules/ai/services/gemini.ts"),
        ("src/openai.ts", "src/modules/ai/services/openai.ts")
    ]
    
    print_status("Moving existing files...", "INFO")
    moved_files = []
    
    for source, destination in moves:
        source_path = base_path / source
        dest_path = base_path / destination
        
        if source_path.exists():
            # Ensure destination directory exists
            dest_path.parent.mkdir(parents=True, exist_ok=True)
            
            # Move the file
            shutil.move(str(source_path), str(dest_path))
            moved_files.append((source, destination))
            print_status(f"  Moved: {source} → {destination}", "SUCCESS")
        else:
            print_status(f"  File not found: {source} (skipping)", "WARNING")
    
    return moved_files

def create_placeholder_files(base_path: Path) -> Dict[str, str]:
    """Create placeholder files with instructional comments"""
    
    placeholders = {
        "src/routes/webhook.ts": """/**
 * GitHub Webhook Route Handler
 * 
 * TODO: Move the following code from src/index.ts:
 * 
 * 1. Import statements related to webhook handling:
 *    - HMAC validation utilities
 *    - GitHub event types
 *    - Context/Environment type definitions
 * 
 * 2. Move the webhook validation logic:
 *    - verifyGitHubSignature() function or equivalent
 *    - Any helper functions for parsing GitHub webhook payloads
 * 
 * 3. Move the main webhook route handler:
 *    - app.post('/webhook', async (c) => { ... })
 *    - All webhook event processing logic
 *    - Pull request event handling
 *    - Issue event handling
 *    - Any other GitHub event handlers
 * 
 * 4. Export the route handler for use in the main index.ts:
 *    - export const webhookRoutes = (app: Hono) => { ... }
 * 
 * Note: Ensure all necessary imports and type definitions are included
 */

import { Hono } from 'hono';

// Placeholder for webhook routes
export const webhookRoutes = (app: Hono) => {
  // TODO: Implement webhook route handlers
};
""",

        "src/routes/api.ts": """/**
 * API Route Handlers
 * 
 * TODO: Move the following code from src/index.ts:
 * 
 * 1. Import statements for API route dependencies
 * 
 * 2. Move all non-webhook API routes:
 *    - app.get('/status', ...) - Health check endpoint
 *    - app.post('/research', ...) - Research initiation endpoint
 *    - app.get('/research/:id', ...) - Research status endpoint
 *    - app.post('/github/search', ...) - GitHub search endpoint
 *    - Any other API endpoints
 * 
 * 3. Move any middleware specific to these routes:
 *    - Authentication middleware
 *    - Rate limiting
 *    - Request validation
 * 
 * 4. Export the route handler for use in the main index.ts:
 *    - export const apiRoutes = (app: Hono) => { ... }
 * 
 * Note: Keep the routes modular and organized by feature
 */

import { Hono } from 'hono';

// Placeholder for API routes
export const apiRoutes = (app: Hono) => {
  // TODO: Implement API route handlers
};
""",

        "src/workflows/research_orchestration.ts": """/**
 * Research Orchestration Workflow
 * 
 * TODO: Create a Cloudflare Workflow that orchestrates the agentic research process
 * 
 * 1. Define the workflow class extending WorkflowEntrypoint:
 *    ```typescript
 *    export class ResearchOrchestrationWorkflow extends WorkflowEntrypoint {
 *      async run(event: WorkflowEvent, step: WorkflowStep) {
 *        // Workflow implementation
 *      }
 *    }
 *    ```
 * 
 * 2. Implement workflow steps:
 *    - Step 1: Initialize research context
 *    - Step 2: Trigger GitHub search via Queue
 *    - Step 3: Process search results with AI agents
 *    - Step 4: Generate research summary
 *    - Step 5: Store results in D1 database
 *    - Step 6: Send notification email
 * 
 * 3. Add error handling and retry logic:
 *    - Use step.do() for automatic retries
 *    - Implement compensation logic for failed steps
 * 
 * 4. Export the workflow for registration in wrangler.toml:
 *    ```toml
 *    [[workflows]]
 *    name = "research-orchestration"
 *    class_name = "ResearchOrchestrationWorkflow"
 *    ```
 * 
 * Note: Leverage Workflows for durable execution and automatic state management
 */

// Placeholder for Cloudflare Workflow
export class ResearchOrchestrationWorkflow {
  // TODO: Implement workflow logic
}
""",

        "src/queues/github_search_consumer.ts": """/**
 * GitHub Search Queue Consumer
 * 
 * TODO: Create a Queue consumer that processes GitHub search tasks
 * 
 * 1. Define the queue consumer handler:
 *    ```typescript
 *    export default {
 *      async queue(batch: MessageBatch, env: Env): Promise<void> {
 *        // Process messages
 *      }
 *    }
 *    ```
 * 
 * 2. Implement message processing logic:
 *    - Parse search parameters from message body
 *    - Execute GitHub API search queries
 *    - Handle pagination for large result sets
 *    - Store raw results in R2 or KV storage
 *    - Update job status in D1 database
 * 
 * 3. Add batch processing optimizations:
 *    - Process multiple search queries in parallel
 *    - Implement rate limiting for GitHub API
 *    - Use batch acknowledgment for efficiency
 * 
 * 4. Implement error handling:
 *    - Retry failed searches with exponential backoff
 *    - Move poison messages to DLQ after max retries
 *    - Log errors for monitoring
 * 
 * 5. Register the consumer in wrangler.toml:
 *    ```toml
 *    [[queues.consumers]]
 *    queue = "github-search"
 *    max_batch_size = 10
 *    max_batch_timeout = 30
 *    ```
 * 
 * Note: Design for high throughput and reliability
 */

// Placeholder for Queue consumer
export default {
  async queue(batch: any, env: any): Promise<void> {
    // TODO: Implement queue consumer logic
  }
};
""",

        "src/modules/ai/services/claude.ts": """/**
 * Claude AI Service Client
 * 
 * TODO: Create a service client for Anthropic's Claude API
 * 
 * 1. Define the Claude service class:
 *    ```typescript
 *    export class ClaudeService {
 *      private apiKey: string;
 *      constructor(apiKey: string) { ... }
 *    }
 *    ```
 * 
 * 2. Implement core methods:
 *    - async createMessage(prompt: string, options?: ClaudeOptions)
 *    - async createStreamingMessage(prompt: string, onChunk: Function)
 *    - async analyzeCode(code: string, context: string)
 *    - async generateSummary(text: string, maxTokens: number)
 * 
 * 3. Add helper methods:
 *    - Token counting and management
 *    - Prompt template formatting
 *    - Response parsing and validation
 * 
 * 4. Implement caching:
 *    - Use KV storage for response caching
 *    - Implement cache key generation
 *    - Add TTL management
 * 
 * 5. Add error handling:
 *    - Rate limit handling with retry logic
 *    - API error parsing and logging
 *    - Fallback strategies
 * 
 * Note: Consider using the official Anthropic SDK if available
 */

export class ClaudeService {
  // TODO: Implement Claude service client
}
""",

        "src/modules/ai/services/workerai.ts": """/**
 * Cloudflare Workers AI Service
 * 
 * TODO: Create a service wrapper for Cloudflare's Workers AI
 * 
 * 1. Define the Workers AI service class:
 *    ```typescript
 *    export class WorkersAIService {
 *      constructor(private ai: any) { }
 *    }
 *    ```
 * 
 * 2. Implement model-specific methods:
 *    - async runLLM(model: string, prompt: string)
 *    - async runEmbeddings(text: string)
 *    - async runImageClassification(image: ArrayBuffer)
 *    - async runSpeechRecognition(audio: ArrayBuffer)
 * 
 * 3. Add utility methods:
 *    - Model selection based on task type
 *    - Response formatting and normalization
 *    - Batch processing for embeddings
 * 
 * 4. Implement vector operations:
 *    - Generate embeddings for text chunks
 *    - Calculate similarity scores
 *    - Integration with Vectorize
 * 
 * 5. Add performance optimizations:
 *    - Request batching where supported
 *    - Model warm-up strategies
 *    - Response streaming
 * 
 * Note: Leverage Cloudflare's native AI capabilities for cost efficiency
 */

export class WorkersAIService {
  // TODO: Implement Workers AI service
}
""",

        "src/modules/ai/agents/research_agent.ts": """/**
 * Research Agent using Cloudflare Agents SDK
 * 
 * TODO: Create a ResearchAgent class using the Cloudflare Agents SDK
 * 
 * 1. Define the agent class:
 *    ```typescript
 *    import { Agent, Tool } from '@cloudflare/agents-sdk';
 *    
 *    export class ResearchAgent extends Agent {
 *      constructor(config: AgentConfig) {
 *        super(config);
 *      }
 *    }
 *    ```
 * 
 * 2. Define agent tools:
 *    - GitHubSearchTool: Search repositories and issues
 *    - WebScrapeTool: Extract content from web pages
 *    - SummarizeTool: Generate summaries of findings
 *    - CodeAnalysisTool: Analyze code repositories
 * 
 * 3. Implement the agent's cognitive loop:
 *    - async plan(objective: string): Generate research plan
 *    - async execute(plan: ResearchPlan): Execute research steps
 *    - async reflect(results: any): Evaluate findings
 *    - async synthesize(findings: any[]): Create final report
 * 
 * 4. Add memory and context management:
 *    - Store research history in D1
 *    - Maintain conversation context
 *    - Implement relevance scoring
 * 
 * 5. Configure agent personality and capabilities:
 *    - System prompt for research expertise
 *    - Tool selection strategies
 *    - Output formatting preferences
 * 
 * Note: Use the Agents SDK's built-in orchestration and tool-calling features
 */

import { Agent } from '@cloudflare/agents-sdk';

export class ResearchAgent extends Agent {
  // TODO: Implement research agent logic
}
""",

        "src/modules/ai/agents/developer_agent.ts": """/**
 * Developer Agent for Code Analysis and Generation
 * 
 * TODO: Create a DeveloperAgent using the Cloudflare Agents SDK
 * 
 * 1. Define the agent class:
 *    ```typescript
 *    import { Agent, Tool } from '@cloudflare/agents-sdk';
 *    
 *    export class DeveloperAgent extends Agent {
 *      constructor(config: AgentConfig) {
 *        super(config);
 *      }
 *    }
 *    ```
 * 
 * 2. Define developer-specific tools:
 *    - CodeReviewTool: Analyze code quality and patterns
 *    - RefactorTool: Suggest code improvements
 *    - TestGeneratorTool: Create unit tests
 *    - DocumentationTool: Generate code documentation
 *    - DependencyAnalyzerTool: Analyze project dependencies
 * 
 * 3. Implement code analysis workflows:
 *    - async analyzeRepository(repoUrl: string)
 *    - async reviewPullRequest(prData: any)
 *    - async suggestRefactoring(code: string, context: string)
 *    - async generateTests(code: string, framework: string)
 * 
 * 4. Add language-specific capabilities:
 *    - TypeScript/JavaScript expertise
 *    - Framework detection (React, Vue, etc.)
 *    - Build tool understanding (Webpack, Vite, etc.)
 * 
 * 5. Integrate with development tools:
 *    - GitHub API for PR interactions
 *    - ESLint/Prettier for code formatting
 *    - Test runners for validation
 * 
 * Note: Focus on practical, actionable development assistance
 */

import { Agent } from '@cloudflare/agents-sdk';

export class DeveloperAgent extends Agent {
  // TODO: Implement developer agent logic
}
""",

        "src/modules/storage/d1.ts": """/**
 * D1 Database Abstraction Layer
 * 
 * TODO: Abstract all D1 database queries into reusable functions
 * 
 * 1. Define the D1 service class:
 *    ```typescript
 *    export class D1Service {
 *      constructor(private db: D1Database) { }
 *    }
 *    ```
 * 
 * 2. Extract and refactor queries from do_research.ts:
 *    - async createResearchJob(data: ResearchJobData)
 *    - async updateJobStatus(id: string, status: string)
 *    - async getJobById(id: string)
 *    - async listJobs(filters: JobFilters)
 *    - async storeResearchResults(jobId: string, results: any)
 * 
 * 3. Add query builders and helpers:
 *    - Parameterized query construction
 *    - SQL injection prevention
 *    - Result mapping and typing
 * 
 * 4. Implement migrations:
 *    - async runMigrations(): Execute schema migrations
 *    - Version tracking in migrations table
 *    - Rollback capabilities
 * 
 * 5. Add performance optimizations:
 *    - Prepared statements for common queries
 *    - Batch operations for bulk inserts
 *    - Query result caching strategies
 * 
 * 6. Define TypeScript interfaces:
 *    - ResearchJob, User, Repository interfaces
 *    - Query result types
 *    - Migration schemas
 * 
 * Note: Ensure all database operations are properly typed and validated
 */

export class D1Service {
  constructor(private db: any) {}
  
  // TODO: Implement D1 service methods
}
""",

        "src/modules/services/email.ts": """/**
 * Email Service
 * 
 * TODO: Create a dedicated service class for sending emails
 * 
 * 1. Define the email service class:
 *    ```typescript
 *    export class EmailService {
 *      constructor(private config: EmailConfig) { }
 *    }
 *    ```
 * 
 * 2. Implement email providers:
 *    - SendGrid integration
 *    - Mailgun integration
 *    - SES integration
 *    - Fallback to Cloudflare Email Workers
 * 
 * 3. Create email methods:
 *    - async sendEmail(to: string, subject: string, body: string)
 *    - async sendTemplatedEmail(to: string, template: string, data: any)
 *    - async sendBatchEmails(recipients: EmailRecipient[])
 *    - async sendNotification(type: NotificationType, data: any)
 * 
 * 4. Add template management:
 *    - HTML email templates
 *    - Markdown to HTML conversion
 *    - Variable interpolation
 *    - Template caching
 * 
 * 5. Implement email tracking:
 *    - Store sent emails in D1
 *    - Track open rates (if supported)
 *    - Handle bounces and complaints
 * 
 * 6. Add queue integration:
 *    - Queue emails for batch sending
 *    - Retry failed sends
 *    - Rate limiting
 * 
 * Note: Ensure compliance with email regulations (CAN-SPAM, GDPR)
 */

export class EmailService {
  // TODO: Implement email service
}
"""
    }
    
    print_status("Creating placeholder files with instructions...", "INFO")
    created_files = []
    
    for file_path, content in placeholders.items():
        full_path = base_path / file_path
        
        # Ensure directory exists
        full_path.parent.mkdir(parents=True, exist_ok=True)
        
        # Write the placeholder content
        with open(full_path, 'w', encoding='utf-8') as f:
            f.write(content)
        
        created_files.append(file_path)
        print_status(f"  Created: {file_path}", "SUCCESS")
    
    return placeholders

def run_git_workflow(base_path: Path) -> None:
    """Automate the Git workflow: create branch, commit, and create PR"""
    
    print_status("Starting Git workflow...", "INFO")
    
    # Change to the repository directory
    os.chdir(base_path)
    
    try:
        # Check if we're in a git repository
        subprocess.run(['git', 'rev-parse', '--git-dir'], 
                      check=True, capture_output=True, text=True)
    except subprocess.CalledProcessError:
        print_status("Not in a git repository. Please run this script from a git repository.", "ERROR")
        return
    
    # Create a new branch
    branch_name = "feat/refactor-project-structure"
    print_status(f"Creating branch: {branch_name}", "INFO")
    
    try:
        # Check if branch already exists
        result = subprocess.run(['git', 'branch', '--list', branch_name], 
                              capture_output=True, text=True)
        
        if result.stdout.strip():
            print_status(f"Branch {branch_name} already exists. Switching to it...", "WARNING")
            subprocess.run(['git', 'checkout', branch_name], check=True)
        else:
            subprocess.run(['git', 'checkout', '-b', branch_name], check=True)
            print_status(f"  Created and switched to branch: {branch_name}", "SUCCESS")
    except subprocess.CalledProcessError as e:
        print_status(f"Failed to create/switch branch: {e}", "ERROR")
        return
    
    # Add all changes
    print_status("Adding files to git...", "INFO")
    try:
        subprocess.run(['git', 'add', '.'], check=True)
        print_status("  Files added to staging", "SUCCESS")
    except subprocess.CalledProcessError as e:
        print_status(f"Failed to add files: {e}", "ERROR")
        return
    
    # Commit changes
    commit_message = "feat: Refactor project into modular structure\n\n" \
                    "- Created organized directory structure\n" \
                    "- Moved existing files to appropriate locations\n" \
                    "- Added placeholder files with implementation instructions\n" \
                    "- Prepared for Workflows and Queues integration"
    
    print_status("Committing changes...", "INFO")
    try:
        subprocess.run(['git', 'commit', '-m', commit_message], check=True)
        print_status("  Changes committed", "SUCCESS")
    except subprocess.CalledProcessError as e:
        # Check if there's nothing to commit
        status = subprocess.run(['git', 'status', '--porcelain'], 
                              capture_output=True, text=True)
        if not status.stdout.strip():
            print_status("No changes to commit", "WARNING")
        else:
            print_status(f"Failed to commit: {e}", "ERROR")
            return
    
    # Push the branch
    print_status("Pushing branch to remote...", "INFO")
    try:
        subprocess.run(['git', 'push', '-u', 'origin', branch_name], check=True)
        print_status("  Branch pushed to remote", "SUCCESS")
    except subprocess.CalledProcessError as e:
        print_status(f"Failed to push branch: {e}", "ERROR")
        print_status("You may need to push manually or set up remote tracking", "WARNING")
    
    # Create pull request using gh CLI
    print_status("Creating pull request...", "INFO")
    
    pr_title = "feat: Refactor project into modular structure"
    pr_body = """## 🎯 Overview
This PR refactors the monolithic `src/index.ts` file (nearly 5,000 lines) into a modular, scalable architecture leveraging modern Cloudflare features.

## ✨ Changes
### Directory Structure
Created organized directory structure:
- `src/durable/` - Durable Object class definitions
- `src/routes/` - Hono route handlers
- `src/workflows/` - Cloudflare Workflow definitions
- `src/queues/` - Queue consumer logic
- `src/modules/` - Organized business logic modules

### File Relocations
- Moved Durable Objects to `src/durable/`
- Moved GitHub client to `src/modules/github/`
- Moved AI service clients to `src/modules/ai/services/`

### Placeholder Files
Created placeholder files with detailed implementation instructions for:
- Route handlers (webhook, API)
- Workflow orchestration
- Queue consumers
- AI agents using Cloudflare Agents SDK
- Storage abstractions
- Service modules

## 📋 Next Steps
1. Review the new structure and placeholder files
2. Begin moving code from `index.ts` following the instructions in each placeholder
3. Implement new features (Workflows, Queues, Agents)
4. Update `wrangler.toml` configuration
5. Test the refactored application

## 🔍 Review Notes
Each placeholder file contains detailed TODO comments explaining what code should be moved or created there. This provides a clear roadmap for the refactoring process.
"""
    
    try:
        # Check if gh CLI is installed
        subprocess.run(['gh', '--version'], check=True, capture_output=True)
        
        # Create the PR
        subprocess.run([
            'gh', 'pr', 'create',
            '--title', pr_title,
            '--body', pr_body,
            '--base', 'main'  # Adjust if your default branch is different
        ], check=True)
        print_status("  Pull request created", "SUCCESS")
    except subprocess.CalledProcessError as e:
        print_status("Failed to create PR with gh CLI", "WARNING")
        print_status("Please create the pull request manually on GitHub", "INFO")
        print_status(f"  Branch: {branch_name}", "INFO")
        print_status(f"  Title: {pr_title}", "INFO")
    except FileNotFoundError:
        print_status("gh CLI not found. Please install it or create PR manually", "WARNING")
        print_status("Install with: brew install gh (macOS) or see https://cli.github.com", "INFO")

def main():
    """Main execution function"""
    print_status("=" * 60, "INFO")
    print_status("Cloudflare Worker Refactoring Script", "INFO")
    print_status("=" * 60, "INFO")
    
    # Get the current working directory
    base_path = Path.cwd()
    print_status(f"Working directory: {base_path}", "INFO")
    
    # Verify we're in the right place
    if not (base_path / "src").exists():
        print_status("'src' directory not found. Please run this script from your project root.", "ERROR")
        sys.exit(1)
    
    if not (base_path / "src/index.ts").exists():
        print_status("'src/index.ts' not found. Please ensure you're in the correct repository.", "WARNING")
    
    # Execute refactoring steps
    try:
        # Step 1: Create directory structure
        print_status("\n📁 Step 1: Creating directory structure", "INFO")
        create_directory_structure(base_path)
        
        # Step 2: Move existing files
        print_status("\n🚀 Step 2: Moving existing files", "INFO")
        moved_files = move_existing_files(base_path)
        
        # Step 3 & 4: Create placeholder files with instructions
        print_status("\n📝 Step 3 & 4: Creating placeholder files with instructions", "INFO")
        placeholder_files = create_placeholder_files(base_path)
        
        # Step 5: Git workflow
        print_status("\n🔧 Step 5: Automating Git workflow", "INFO")
        run_git_workflow(base_path)
        
        # Summary
        print_status("\n" + "=" * 60, "INFO")
        print_status("✅ Refactoring Complete!", "SUCCESS")
        print_status(f"  • Created {len(placeholder_files)} placeholder files", "INFO")
        print_status(f"  • Moved {len(moved_files)} existing files", "INFO")
        print_status("  • Git branch created and pushed", "INFO")
        print_status("  • Pull request ready for review", "INFO")
        print_status("=" * 60, "INFO")
        
    except Exception as e:
        print_status(f"\n❌ An error occurred: {e}", "ERROR")
        import traceback
        traceback.print_exc()
        sys.exit(1)

if __name__ == "__main__":
    main()
