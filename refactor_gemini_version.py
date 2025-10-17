#!/usr/bin/env python3
"""
Cloudflare Worker Project Refactoring Script

This script automates the reorganization of a large Cloudflare Worker project
into a more modular and scalable structure. It creates new directories,
moves existing files, generates placeholder files with instructional comments,
and automates the Git workflow to create a new pull request.
"""

import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Dict

# --- Configuration ---

# Color codes for terminal output for better readability
class Colors:
    """Terminal color codes for formatted output."""
    GREEN = '\033[92m'
    YELLOW = '\033[93m'
    RED = '\033[91m'
    BLUE = '\033[94m'
    RESET = '\033[0m'

# --- Helper Functions ---

def print_status(message: str, status: str = "INFO"):
    """Prints a formatted and colored status message to the console."""
    color_map = {
        "SUCCESS": Colors.GREEN,
        "INFO": Colors.BLUE,
        "WARNING": Colors.YELLOW,
        "ERROR": Colors.RED
    }
    color = color_map.get(status, Colors.RESET)
    print(f"{color}[{status.ljust(7)}] {message}{Colors.RESET}")

def run_command(command: list[str], cwd: Path):
    """Executes a shell command and handles errors."""
    try:
        # Using text=True for Python 3.7+ to handle stdout/stderr as strings
        result = subprocess.run(
            command,
            check=True,
            capture_output=True,
            text=True,
            cwd=cwd
        )
        return result
    except FileNotFoundError:
        print_status(f"Command not found: '{command[0]}'. Please ensure it's installed and in your PATH.", "ERROR")
        sys.exit(1)
    except subprocess.CalledProcessError as e:
        print_status(f"Command failed: {' '.join(command)}", "ERROR")
        print(f"         STDOUT: {e.stdout.strip()}")
        print(f"         STDERR: {e.stderr.strip()}")
        raise

# --- Core Refactoring Logic ---

def create_directory_structure(base_path: Path):
    """Creates the new target directory structure within the 'src' folder."""
    directories = [
        "durable",
        "routes",
        "workflows",
        "queues",
        "modules/ai/agents",
        "modules/ai/services",
        "modules/ai/processing",
        "modules/github",
        "modules/storage",
        "modules/services"
    ]

    print_status("Creating new directory structure...", "INFO")
    src_path = base_path / "src"

    for directory in directories:
        dir_path = src_path / directory
        dir_path.mkdir(parents=True, exist_ok=True)
        print_status(f"Created: {dir_path.relative_to(base_path)}", "SUCCESS")

def move_existing_files(base_path: Path):
    """Moves existing source files to their new, organized locations."""
    moves = {
        "src/do_research.ts": "src/durable/do_research.ts",
        "src/do_pr_workflows.ts": "src/durable/do_pr_workflows.ts",
        "src/do_profile_scanner.ts": "src/durable/do_profile_scanner.ts",
        "src/github.ts": "src/modules/github/github.ts",
        "src/gemini.ts": "src/modules/ai/services/gemini.ts",
        "src/openai.ts": "src/modules/ai/services/openai.ts"
    }

    print_status("Moving existing files to new locations...", "INFO")

    for source, destination in moves.items():
        source_path = base_path / source
        dest_path = base_path / destination

        if source_path.exists():
            dest_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(source_path), str(dest_path))
            print_status(f"Moved: {source} -> {destination}", "SUCCESS")
        else:
            print_status(f"File not found, skipping: {source}", "WARNING")

def get_placeholder_content() -> Dict[str, str]:
    """Returns a dictionary of placeholder file paths and their content."""
    return {
        "src/routes/webhook.ts": """/**
 * @fileoverview Handles GitHub webhook events.
 * * TODO FOR REFACTORING AGENT:
 * 1.  Migrate the Hono middleware for GitHub webhook signature validation from `src/index.ts`.
 * 2.  Move the `app.post('/webhook', ...)` route handler and all its internal logic from `src/index.ts` here.
 * 3.  Organize the event handling logic (e.g., for `pull_request`, `issue_comment`) into separate helper functions within this file.
 * 4.  Export a single function that accepts a Hono instance and registers the webhook route.
 */
""",
        "src/routes/api.ts": """/**
 * @fileoverview Defines general API routes for the worker.
 * * TODO FOR REFACTORING AGENT:
 * 1.  Migrate all non-webhook Hono routes from `src/index.ts`. This includes:
 * - `app.get('/status', ...)`
 * - `app.post('/research', ...)`
 * - Any other custom API endpoints.
 * 2.  Ensure all related imports and helper functions for these routes are also moved.
 * 3.  Export a single function that accepts a Hono instance and registers all API routes.
 */
""",
        "src/workflows/research_orchestration.ts": """/**
 * @fileoverview Defines the Cloudflare Workflow for agentic research.
 * * TODO FOR REFACTORING AGENT:
 * 1.  Define a new class that implements a Cloudflare Workflow.
 * 2.  This workflow should orchestrate the agentic research process. A typical flow would be:
 * a. Receive a research topic as input.
 * b. Send a task to the `github_search_consumer` queue.
 * c. Wait for the queue task to complete or for a callback.
 * d. Trigger an AI agent in `src/modules/ai/agents/` to process the results.
 * e. Store the final analysis in D1.
 * f. Send a completion notification.
 */
""",
        "src/queues/github_search_consumer.ts": """/**
 * @fileoverview Cloudflare Queues consumer for executing GitHub search tasks.
 * * TODO FOR REFACTORING AGENT:
 * 1.  Implement the `queue` handler for a Cloudflare Queues consumer.
 * 2.  This consumer should expect a message containing a GitHub search query.
 * 3.  Upon receiving a message, it should:
 * a. Use the GitHub module to execute the search.
 * b. Store the raw search results in a Durable Object or D1.
 * c. Potentially trigger the next step in the workflow (e.g., via a callback or another queue).
 */
""",
        "src/modules/ai/services/claude.ts": """/**
 * @fileoverview Client for interacting with the Anthropic Claude API.
 */
""",
        "src/modules/ai/services/workerai.ts": """/**
 * @fileoverview Client for interacting with the Cloudflare Workers AI API.
 */
""",
        "src/modules/ai/agents/research_agent.ts": """/**
 * @fileoverview Defines the ResearchAgent using the Cloudflare Agents SDK.
 * * TODO FOR REFACTORING AGENT:
 * 1.  Create a `ResearchAgent` class that extends the Cloudflare `Agent`.
 * 2.  Define tools for this agent, such as:
 * - A tool to search GitHub (using `src/modules/github/github.ts`).
 * - A tool to analyze repository content.
 * - A tool to summarize findings (using an AI service from `src/modules/ai/services/`).
 * 3.  Implement the agent's core logic for planning and executing research tasks.
 */
""",
        "src/modules/ai/agents/developer_agent.ts": """/**
 * @fileoverview Defines a DeveloperAgent for code-related tasks.
 * * TODO FOR REFACTORING AGENT:
 * 1.  Create a `DeveloperAgent` class that extends the Cloudflare `Agent`.
 * 2.  This agent will specialize in tasks like code analysis, PR reviews, and standardization checks.
 * 3.  Define relevant tools for code manipulation and analysis.
 */
""",
        "src/modules/storage/d1.ts": """/**
 * @fileoverview Abstraction layer for all D1 database operations.
 * * TODO FOR REFACTORING AGENT:
 * 1.  Centralize all D1 database queries from across the application (especially from `src/durable/*.ts` files) here.
 * 2.  Create exported functions for each distinct database operation, such as:
 * - `getResearchTask(db, taskId)`
 * - `saveRepositoryAnalysis(db, analysisData)`
 * - `listUserInterests(db, userId)`
 * 3.  This will decouple business logic from direct database access.
 */
""",
        "src/modules/services/email.ts": """/**
 * @fileoverview Service for handling email sending.
 * * TODO FOR REFACTORING AGENT:
 * 1.  Create a dedicated `EmailService` class or a set of functions for sending emails.
 * 2.  Abstract the logic for creating and sending `EmailMessage` objects.
 * 3.  Include functions for formatting different types of emails, like the daily research digest.
 */
"""
    }

def create_placeholder_files(base_path: Path):
    """Creates new placeholder files with detailed instructional comments."""
    placeholders = get_placeholder_content()

    print_status("Creating placeholder files for refactoring...", "INFO")

    for file_path, content in placeholders.items():
        full_path = base_path / file_path
        full_path.parent.mkdir(parents=True, exist_ok=True)
        with open(full_path, 'w', encoding='utf-8') as f:
            f.write(content.strip())
        print_status(f"Created: {file_path}", "SUCCESS")

def automate_git_workflow(base_path: Path):
    """Creates a new branch, commits the changes, and opens a pull request."""
    branch_name = "feat/refactor-project-structure"
    commit_message = "feat: Refactor project into modular structure"
    pr_title = "feat: Refactor Project into Modular Structure"
    pr_body = """
This PR introduces a comprehensive refactoring of the project structure to improve maintainability and scalability. The monolithic `src/index.ts` file is being broken down into a modular architecture.

### Key Changes:

-   **New Directory Structure:** Established a clear folder hierarchy for `durable` objects, `routes`, `workflows`, `queues`, and various `modules`.
-   **File Relocation:** Moved existing files into their new logical locations.
-   **Placeholder Scaffolding:** Created new placeholder files with detailed comments to guide the next phase of code migration.
-   **Architectural Alignment:** The new structure is designed to support Cloudflare Workflows, Queues, and the Agents SDK for building robust, decoupled systems.

This automated refactoring was performed by a script to prepare the codebase for manual and AI-driven code migration.
"""

    print_status("Automating Git workflow...", "INFO")

    # 1. Create and switch to a new branch
    print_status(f"Creating and switching to branch '{branch_name}'...", "INFO")
    run_command(['git', 'checkout', '-b', branch_name], base_path)

    # 2. Add all new and modified files
    print_status("Adding all changes to the staging area...", "INFO")
    run_command(['git', 'add', 'src/'], base_path)

    # 3. Commit the changes
    print_status("Committing changes...", "INFO")
    run_command(['git', 'commit', '-m', commit_message], base_path)

    # 4. Push to remote
    print_status(f"Pushing branch '{branch_name}' to origin...", "INFO")
    run_command(['git', 'push', '-u', 'origin', branch_name], base_path)

    # 5. Create a pull request
    print_status("Creating pull request...", "INFO")
    try:
        run_command(['gh', 'pr', 'create', '--title', pr_title, '--body', pr_body, '--fill'], base_path)
        print_status("Successfully created pull request!", "SUCCESS")
    except Exception:
        print_status("Failed to create PR automatically.", "WARNING")
        print_status("Please create the pull request manually on GitHub.", "INFO")
        print_status(f"Branch: {branch_name}", "INFO")

# --- Main Execution ---

def main():
    """Main function to execute the refactoring script."""
    print_status("=" * 60, "INFO")
    print_status("Cloudflare Worker Project Refactoring Script", "INFO")
    print_status("=" * 60, "INFO")

    base_path = Path.cwd()

    if not (base_path / "src").is_dir() or not (base_path / "wrangler.jsonc").exists():
        print_status("This script must be run from the root of your Cloudflare Worker project.", "ERROR")
        sys.exit(1)

    try:
        # Step 1: Create Directories
        create_directory_structure(base_path)

        # Step 2: Move Files
        move_existing_files(base_path)

        # Step 3 & 4: Create Placeholders
        create_placeholder_files(base_path)

        # Step 5: Git Workflow
        automate_git_workflow(base_path)

        print_status("=" * 60, "SUCCESS")
        print_status("Refactoring preparation complete!", "SUCCESS")
        print_status(f"A new pull request has been created on the '{base_path.name}' repository.", "INFO")
        print_status("=" * 60, "SUCCESS")

    except Exception as e:
        print_status(f"An unexpected error occurred: {e}", "ERROR")
        sys.exit(1)

if __name__ == "__main__":
    main()
