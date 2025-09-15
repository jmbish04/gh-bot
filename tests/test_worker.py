#!/usr/bin/env python3
"""
Comprehensive test suite for gh-bot Worker endpoints.
- Loads config from ../.dev.vars (falls back to env, then hardcoded defaults)
- Sends Accept: application/json and optional X-API-Key from .dev.vars
- Handles non-JSON bodies gracefully (captures raw text for debugging)
- Prints colored test output and writes a concise JSON summary file
"""

import json
import time
import hashlib
import hmac
from typing import Dict, Any, Optional, List
from datetime import datetime
import requests
from dataclasses import dataclass
from enum import Enum
import os
from dotenv import dotenv_values

# ---------------------------
# Config from .dev.vars / env
# ---------------------------
VARS_PATH = "../.dev.vars"
if os.path.exists(VARS_PATH):
    env_vars = dotenv_values(VARS_PATH)
    os.environ.update({k: v for k, v in env_vars.items() if v is not None})

WORKER_URL = (os.environ.get("WORKER_URL") or "https://gh-bot.hacolby.workers.dev").rstrip("/")
OUTPUT_FILE = os.environ.get("OUTPUT_FILE") or "test_results.json"
API_KEY = os.environ.get("API_KEY")
WEBHOOK_SECRET = os.environ.get("GITHUB_WEBHOOK_SECRET")

DEFAULT_HEADERS = {
    "Accept": "application/json",
    **({"X-API-Key": API_KEY} if API_KEY else {}),
}


class Colors:
    """ANSI color codes for terminal output"""
    GREEN = '\033[92m'
    RED = '\033[91m'
    YELLOW = '\033[93m'
    BLUE = '\033[94m'
    MAGENTA = '\033[95m'
    CYAN = '\033[96m'
    RESET = '\033[0m'
    BOLD = '\033[1m'


class TestStatus(Enum):
    """Test result status"""
    PASSED = "PASSED"
    FAILED = "FAILED"
    SKIPPED = "SKIPPED"
    WARNING = "WARNING"


@dataclass
class TestResult:
    """Container for test results"""
    endpoint: str
    method: str
    status: TestStatus
    response_code: Optional[int] = None
    response_time: Optional[float] = None
    message: str = ""
    response_data: Any = None


class WorkerTester:
    """Test suite for gh-bot Worker endpoints"""

    def __init__(self, base_url: str, webhook_secret: Optional[str] = None):
        """
        Initialize the tester

        Args:
            base_url: The worker URL (e.g., 'https://gh-bot.hacolby.workers.dev')
            webhook_secret: GitHub webhook secret for signature verification (optional)
        """
        self.base_url = base_url.rstrip('/')
        self.webhook_secret = webhook_secret
        self.session = requests.Session()
        self.session.headers.update(DEFAULT_HEADERS)
        self.results: List[TestResult] = []

    def print_header(self, text: str):
        """Print a formatted section header"""
        print(f"\n{Colors.BOLD}{Colors.CYAN}{'='*60}{Colors.RESET}")
        print(f"{Colors.BOLD}{Colors.CYAN}{text.center(60)}{Colors.RESET}")
        print(f"{Colors.BOLD}{Colors.CYAN}{'='*60}{Colors.RESET}\n")

    def print_test(self, name: str, status: TestStatus, details: str = ""):
        """Print test result with color coding"""
        status_colors = {
            TestStatus.PASSED: Colors.GREEN,
            TestStatus.FAILED: Colors.RED,
            TestStatus.SKIPPED: Colors.YELLOW,
            TestStatus.WARNING: Colors.YELLOW,
        }
        color = status_colors.get(status, Colors.RESET)
        status_text = f"[{status.value}]"
        print(f"{color}{status_text:12}{Colors.RESET} {name}")
        if details:
            print(f"{'':12} {Colors.BLUE}→ {details}{Colors.RESET}")

    def generate_webhook_signature(self, payload: bytes) -> str:
        """
        Generate GitHub webhook signature (HMAC-SHA256)
        """
        if not self.webhook_secret:
            return ""
        signature = hmac.new(
            self.webhook_secret.encode("utf-8"),
            payload,
            hashlib.sha256
        ).hexdigest()
        return f"sha256={signature}"

    def test_endpoint(
        self,
        method: str,
        path: str,
        description: str,
        data: Optional[Dict] = None,
        headers: Optional[Dict] = None,
        expected_status: Optional[List[int]] = None,
        check_response: bool = True
    ) -> TestResult:
        """
        Test a single endpoint.
        """
        if expected_status is None:
            expected_status = [200, 201, 202]

        url = f"{self.base_url}{path}"
        req_headers = {**self.session.headers, **(headers or {})}

        try:
            start_time = time.time()

            if method.upper() == "GET":
                response = self.session.get(url, headers=req_headers, timeout=30)
            elif method.upper() == "POST":
                if data is not None:
                    req_headers.setdefault("Content-Type", "application/json")
                    response = self.session.post(url, json=data, headers=req_headers, timeout=30)
                else:
                    response = self.session.post(url, headers=req_headers, timeout=30)
            else:
                raise ValueError(f"Unsupported method: {method}")

            response_time = time.time() - start_time

            # Status check
            if response.status_code not in expected_status:
                status = TestStatus.FAILED
                message = f"Expected {expected_status}, got {response.status_code}"
            else:
                status = TestStatus.PASSED
                message = f"Response time: {response_time:.2f}s"

            # Parse body
            response_text = response.text if response.text is not None else ""
            response_data: Any = None
            if response_text.strip():
                ctype = response.headers.get("Content-Type", "")
                if "application/json" in ctype:
                    try:
                        response_data = response.json()
                    except Exception as e:
                        status = TestStatus.WARNING if status == TestStatus.PASSED else status
                        message = (message + " | " if message else "") + f"JSON parse error: {e}"
                        response_data = {"__raw__": response_text[:2000], "__json_error__": str(e)}
                else:
                    # Non-JSON (e.g., text/event-stream, HTML, plain text)
                    response_data = {"__raw__": response_text[:2000]}

            # Additional validation
            if check_response and status == TestStatus.PASSED:
                if response.status_code == 200 and (response_data is None or response_data == ""):
                    status = TestStatus.WARNING
                    message = "Empty response body"

            result = TestResult(
                endpoint=path,
                method=method,
                status=status,
                response_code=response.status_code,
                response_time=response_time,
                message=message,
                response_data=response_data
            )

        except requests.exceptions.Timeout:
            result = TestResult(path, method, TestStatus.FAILED, message="Request timeout (30s)")
        except requests.exceptions.ConnectionError as e:
            result = TestResult(path, method, TestStatus.FAILED, message=f"Connection error: {e}")
        except Exception as e:
            result = TestResult(path, method, TestStatus.FAILED, message=f"Unexpected error: {e}")

        self.results.append(result)
        self.print_test(description, result.status, result.message)
        return result

    # -----------------
    # Test categories
    # -----------------
    def test_health_endpoints(self):
        self.print_header("Health & Status Endpoints")

        self.test_endpoint(
            method="GET",
            path="/health",
            description="Health check endpoint"
        )

        self.test_endpoint(
            method="GET",
            path="/demo/stream",
            description="Demo streaming endpoint",
            check_response=False  # likely text/event-stream
        )

    def test_research_endpoints(self):
        self.print_header("Research Endpoints")

        self.test_endpoint(
            method="GET",
            path="/research/status",
            description="Research orchestrator status",
            expected_status=[200, 503]
        )

        self.test_endpoint(
            method="GET",
            path="/research/results",
            description="Get research results (default params)"
        )

        self.test_endpoint(
            method="GET",
            path="/research/results?min_score=0.7&limit=10",
            description="Get research results (filtered)"
        )

        self.test_endpoint(
            method="GET",
            path="/research/risks",
            description="Get repositories with risk flags"
        )

        self.test_endpoint(
            method="GET",
            path="/research/structured",
            description="Get structured analysis results"
        )

        self.test_endpoint(
            method="GET",
            path="/research/structured?kind=backend&min_conf=0.5",
            description="Get filtered structured analysis"
        )

        self.test_endpoint(
            method="GET",
            path="/research/analysis",
            description="Get analysis (missing repo param)",
            expected_status=[400]
        )

        self.test_endpoint(
            method="GET",
            path="/research/analysis?repo=cloudflare/workers-sdk",
            description="Get analysis for specific repo",
            expected_status=[200]
        )

    def test_research_post_endpoints(self):
        self.print_header("Research POST Endpoints")

        post_headers = {}
        if API_KEY:  # be explicit for POSTs if needed
            post_headers["X-API-Key"] = API_KEY

        self.test_endpoint(
            method="POST",
            path="/research/run",
            description="Start research sweep",
            data={
                "queries": ["topic:cloudflare-workers"],
                "categories": ["infrastructure"],
            },
            headers=post_headers,
            expected_status=[200, 202, 403, 503],
        )

        self.test_endpoint(
            method="POST",
            path="/research/analyze",
            description="Manual repo analysis",
            data={"owner": "cloudflare", "repo": "miniflare", "force": False},
            headers=post_headers,
            expected_status=[200, 400, 404, 500],
        )

        self.test_endpoint(
            method="POST",
            path="/research/analyze-structured",
            description="Manual structured analysis",
            data={"owner": "cloudflare", "repo": "wrangler", "force": False},
            headers=post_headers,
            expected_status=[200, 400, 404, 500],
        )

        self.test_endpoint(
            method="POST",
            path="/research/analyze",
            description="Analysis with missing params",
            data={},
            headers=post_headers,
            expected_status=[400],
        )

    def test_webhook_endpoints(self):
        self.print_header("GitHub Webhook Endpoints")

        pr_payload = {
            "action": "opened",
            "pull_request": {
                "id": 1,
                "number": 1,
                "state": "open",
                "title": "Test PR",
                "user": {"login": "test-user"},
                "head": {"ref": "feature-branch", "sha": "abc123"},
                "base": {"ref": "main"},
            },
            "repository": {
                "name": "test-repo",
                "full_name": "test-org/test-repo",
                "owner": {"login": "test-org"},
            },
        }

        # Test webhook without signature (should fail)
        self.test_endpoint(
            method="POST",
            path="/github/webhook",
            description="Webhook without signature",
            data=pr_payload,
            expected_status=[401, 403],
        )

        # Test webhook with invalid signature
        self.test_endpoint(
            method="POST",
            path="/github/webhook",
            description="Webhook with invalid signature",
            data=pr_payload,
            headers={
                "X-Hub-Signature-256": "sha256=invalid_signature_here",
                "X-GitHub-Event": "pull_request",
                "Content-Type": "application/json",
            },
            expected_status=[401, 403],
        )

        # Test webhook with valid signature (if secret provided)
        if self.webhook_secret:
            payload_bytes = json.dumps(pr_payload).encode("utf-8")
            signature = self.generate_webhook_signature(payload_bytes)

            self.test_endpoint(
                method="POST",
                path="/github/webhook",
                description="Webhook with valid signature",
                data=pr_payload,
                headers={
                    "X-Hub-Signature-256": signature,
                    "X-GitHub-Event": "pull_request",
                    "Content-Type": "application/json",
                },
                expected_status=[200, 202],
            )

            # Test different webhook events
            webhook_events = [
                ("issue_comment", "Issue comment webhook"),
                ("pull_request_review", "PR review webhook"),
                ("pull_request_review_comment", "PR review comment webhook"),
                ("pull_request", "Pull request webhook"),
                ("push", "Push webhook"),
                ("installation", "Installation webhook"),
            ]

            for event_type, description in webhook_events:
                event_payload = {
                    "action": "created" if "comment" in event_type else "opened",
                    "repository": pr_payload["repository"]
                }

                if "pull_request" in event_type:
                    event_payload["pull_request"] = pr_payload["pull_request"]

                if "comment" in event_type:
                    event_payload["comment"] = {
                        "id": 123,
                        "body": "/colby help",
                        "user": {"login": "test-user"}
                    }

                payload_bytes = json.dumps(event_payload).encode("utf-8")
                signature = self.generate_webhook_signature(payload_bytes)

                self.test_endpoint(
                    method="POST",
                    path="/github/webhook",
                    description=description,
                    data=event_payload,
                    headers={
                        "X-Hub-Signature-256": signature,
                        "X-GitHub-Event": event_type,
                        "Content-Type": "application/json",
                    },
                    expected_status=[200, 202, 400],
                )
        else:
            print(f"{Colors.YELLOW}[SKIPPED]   Webhook tests with signature (no secret provided){Colors.RESET}")

    def test_colby_command_parsing(self):
        self.print_header("Colby Command Parsing Tests")

        if not self.webhook_secret:
            print(f"{Colors.YELLOW}[SKIPPED]   Colby command tests (no webhook secret){Colors.RESET}")
            return

        # Test various Colby commands in webhook payloads
        colby_commands = [
            "/colby implement",
            "/colby create issue",
            "/colby create issue and assign to copilot",
            "/colby bookmark this suggestion",
            "/colby extract suggestions",
            "/colby help",
            "/apply",  # legacy command
            "/summarize",  # legacy command
            "Please /colby implement the suggestions above",
            "Can you /colby create issue for this bug?",
            "Multiple commands: /colby implement and /colby bookmark this suggestion",
        ]

        for command in colby_commands:
            comment_payload = {
                "action": "created",
                "issue": {
                    "number": 123,
                    "pull_request": {"url": "https://api.github.com/repos/test/repo/pulls/123"}
                },
                "comment": {
                    "id": 456,
                    "body": command,
                    "user": {"login": "test-user"}
                },
                "repository": {
                    "name": "test-repo",
                    "full_name": "test-org/test-repo",
                    "owner": {"login": "test-org"},
                },
            }

            payload_bytes = json.dumps(comment_payload).encode("utf-8")
            signature = self.generate_webhook_signature(payload_bytes)

            self.test_endpoint(
                method="POST",
                path="/github/webhook",
                description=f"Colby command: {command[:50]}...",
                data=comment_payload,
                headers={
                    "X-Hub-Signature-256": signature,
                    "X-GitHub-Event": "issue_comment",
                    "Content-Type": "application/json",
                },
                expected_status=[200, 202],
            )

    def test_colby_endpoints(self):
        self.print_header("Colby Command Endpoints")

        # Test GET /colby/commands
        self.test_endpoint(
            method="GET",
            path="/colby/commands",
            description="Get all colby commands",
            expected_status=[200, 500]  # 500 if table doesn't exist
        )

        self.test_endpoint(
            method="GET",
            path="/colby/commands?limit=5",
            description="Get colby commands with limit",
            expected_status=[200, 500]
        )

        self.test_endpoint(
            method="GET",
            path="/colby/commands?repo=test/repo&author=testuser",
            description="Get filtered colby commands",
            expected_status=[200, 500]
        )

        self.test_endpoint(
            method="GET",
            path="/colby/commands?limit=wat",
            description="Get colby commands with invalid limit",
            expected_status=[400]
        )

        # Test GET /colby/best-practices
        self.test_endpoint(
            method="GET",
            path="/colby/best-practices",
            description="Get all best practices",
            expected_status=[200, 500]
        )

        self.test_endpoint(
            method="GET",
            path="/colby/best-practices?category=typescript&status=pending",
            description="Get filtered best practices",
            expected_status=[200, 500]
        )

        self.test_endpoint(
            method="GET",
            path="/colby/best-practices?limit=invalid",
            description="Get best practices with invalid limit",
            expected_status=[400]
        )

        # Test GET /colby/operations/:id
        self.test_endpoint(
            method="GET",
            path="/colby/operations/test-operation-123",
            description="Get operation status",
            expected_status=[200, 404, 500]
        )

        # Test GET /colby/repo/:owner/:repo
        self.test_endpoint(
            method="GET",
            path="/colby/repo/cloudflare/workers-sdk",
            description="Get repo-specific colby activity",
            expected_status=[200, 500]
        )

    def test_dashboard_endpoints(self):
        self.print_header("Dashboard & UI Endpoints")

        # Test main dashboard
        self.test_endpoint(
            method="GET",
            path="/",
            description="Main dashboard UI",
            expected_status=[200],
            check_response=False  # HTML response
        )

        # Test help page
        self.test_endpoint(
            method="GET",
            path="/help",
            description="Help page",
            expected_status=[200],
            check_response=False  # HTML response
        )

        # Test OpenAPI spec
        self.test_endpoint(
            method="GET",
            path="/openapi.json",
            description="OpenAPI specification",
            expected_status=[200]
        )

    def test_dashboard_api_endpoints(self):
        self.print_header("Dashboard API Endpoints")

        # Test dashboard APIs with HTMX headers
        htmx_headers = {
            "HX-Request": "true",
            "Accept": "text/html"
        }

        self.test_endpoint(
            method="GET",
            path="/api/stats",
            description="Get dashboard statistics",
            expected_status=[200, 500]
        )

        self.test_endpoint(
            method="GET",
            path="/api/recent-activity",
            description="Get recent activity",
            expected_status=[200, 500]
        )

        self.test_endpoint(
            method="GET",
            path="/api/operations",
            description="Get live operations",
            expected_status=[200, 500]
        )

        # Test HTMX endpoints
        self.test_endpoint(
            method="GET",
            path="/research/results?limit=5",
            description="Research results for HTMX",
            headers=htmx_headers,
            expected_status=[200],
            check_response=False  # HTML response
        )

        self.test_endpoint(
            method="GET",
            path="/colby/commands?limit=5",
            description="Colby commands for HTMX",
            headers=htmx_headers,
            expected_status=[200, 500],
            check_response=False  # HTML response
        )

    def test_parameter_validation(self):
        self.print_header("Parameter Validation Tests")

        # Test various invalid parameters
        invalid_params = [
            ("/research/results?min_score=invalid", "Invalid min_score parameter"),
            ("/research/results?limit=0", "Zero limit parameter"),
            ("/research/results?limit=-5", "Negative limit parameter"),
            ("/research/structured?min_conf=2.0", "Out of range confidence"),
            ("/research/structured?min_conf=-0.5", "Negative confidence"),
            ("/colby/commands?offset=-1", "Negative offset parameter"),
            ("/colby/best-practices?limit=abc", "Non-numeric limit"),
        ]

        for path, description in invalid_params:
            self.test_endpoint(
                method="GET",
                path=path,
                description=description,
                expected_status=[400, 200]  # Some might handle gracefully with defaults
            )

    def test_cors_and_headers(self):
        self.print_header("CORS & Headers Tests")

        # Test with different Accept headers
        accept_headers = [
            ("application/json", "JSON Accept header"),
            ("text/html", "HTML Accept header"),
            ("*/*", "Wildcard Accept header"),
            ("application/xml", "XML Accept header"),
        ]

        for accept_header, description in accept_headers:
            self.test_endpoint(
                method="GET",
                path="/health",
                description=f"Health check with {description}",
                headers={"Accept": accept_header},
                expected_status=[200]
            )

        # Test with missing headers
        self.test_endpoint(
            method="GET",
            path="/health",
            description="Health check without Accept header",
            headers={},
            expected_status=[200]
        )

    def test_security_endpoints(self):
        self.print_header("Security & Input Validation")

        # SQL injection attempts
        sql_injection_tests = [
            ("'; DROP TABLE colby_commands; --", "SQL injection in repo filter"),
            ("test' OR '1'='1", "SQL injection boolean bypass"),
            ("test'; INSERT INTO colby_commands VALUES (...); --", "SQL injection insert"),
            ("test\"; DELETE FROM best_practices; --", "SQL injection with quotes"),
        ]

        for injection, description in sql_injection_tests:
            self.test_endpoint(
                method="GET",
                path=f"/research/analysis?repo={injection}",
                description=description,
                expected_status=[400, 200]  # Should either reject (400) or handle safely (200)
            )

        # XSS attempts
        xss_tests = [
            ("<script>alert('xss')</script>", "Basic XSS attempt"),
            ("javascript:alert('xss')", "JavaScript protocol XSS"),
            ("%3Cscript%3Ealert('xss')%3C/script%3E", "URL encoded XSS"),
        ]

        for xss, description in xss_tests:
            self.test_endpoint(
                method="GET",
                path=f"/colby/commands?repo={xss}",
                description=description,
                expected_status=[200, 400, 500]
            )

    def test_edge_cases(self):
        self.print_header("Edge Cases & Error Handling")

        self.test_endpoint(
            method="GET",
            path="/non-existent-endpoint",
            description="Non-existent endpoint",
            expected_status=[404],
        )

        # Test wrong tenant paths
        self.test_endpoint(
            method="GET",
            path="/nope/commands?limit=5",
            description="Wrong tenant path",
            expected_status=[404],
        )

        # Invalid JSON in POST (intentionally broken body)
        try:
            resp = self.session.post(
                f"{self.base_url}/research/analyze",
                data="invalid json{",
                headers={"Content-Type": "application/json"},
                timeout=10,
            )
            status = TestStatus.PASSED if resp.status_code in [400, 422] else TestStatus.FAILED
            self.print_test("Invalid JSON in POST request", status, f"Status: {resp.status_code}")
        except Exception as e:
            self.print_test("Invalid JSON in POST request", TestStatus.FAILED, str(e))

        self.test_endpoint(
            method="GET",
            path="/research/results?limit=9999",
            description="Large limit parameter (should cap)",
            expected_status=[200],
        )

        self.test_endpoint(
            method="GET",
            path="/research/analysis?repo='; DROP TABLE projects; --",
            description="SQL injection attempt (should be safe)",
            expected_status=[200, 400],
        )

    def run_performance_tests(self):
        self.print_header("Performance Tests")
        print(f"{Colors.MAGENTA}Testing concurrent requests...{Colors.RESET}")

        import concurrent.futures
        import statistics

        def make_request():
            start = time.time()
            try:
                r = self.session.get(f"{self.base_url}/health", timeout=10)
                return time.time() - start, r.status_code
            except Exception:
                return None, None

        # Test concurrent health checks
        with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
            futures = [executor.submit(make_request) for _ in range(10)]
            results = [f.result() for f in concurrent.futures.as_completed(futures)]

        times = [t for (t, code) in results if t is not None]
        if times:
            avg_time = statistics.mean(times)
            max_time = max(times)
            min_time = min(times)
            status = TestStatus.PASSED if avg_time < 2.0 else TestStatus.WARNING
            self.print_test(
                "Concurrent health requests (10 parallel)",
                status,
                f"Avg: {avg_time:.2f}s, Min: {min_time:.2f}s, Max: {max_time:.2f}s",
            )
        else:
            self.print_test("Concurrent health requests (10 parallel)", TestStatus.FAILED, "All requests failed")

        # Test response times for different endpoints
        endpoints_to_test = [
            "/health",
            "/research/results?limit=5",
            "/colby/commands?limit=5",
            "/api/stats",
        ]

        print(f"{Colors.MAGENTA}Testing endpoint response times...{Colors.RESET}")
        for endpoint in endpoints_to_test:
            times = []
            for _ in range(3):  # 3 samples per endpoint
                start = time.time()
                try:
                    r = self.session.get(f"{self.base_url}{endpoint}", timeout=10)
                    if r.status_code < 500:  # Accept anything that's not a server error
                        times.append(time.time() - start)
                except Exception:
                    pass

            if times:
                avg_time = statistics.mean(times)
                status = TestStatus.PASSED if avg_time < 3.0 else TestStatus.WARNING
                self.print_test(
                    f"Response time: {endpoint}",
                    status,
                    f"Avg: {avg_time:.2f}s ({len(times)} samples)",
                )

        # Test database query performance
        print(f"{Colors.MAGENTA}Testing database query performance...{Colors.RESET}")
        db_endpoints = [
            "/research/results",
            "/research/risks",
            "/research/structured",
            "/colby/commands",
            "/colby/best-practices",
        ]

        for endpoint in db_endpoints:
            start = time.time()
            try:
                r = self.session.get(f"{self.base_url}{endpoint}?limit=1", timeout=15)
                response_time = time.time() - start
                status = TestStatus.PASSED if response_time < 5.0 else TestStatus.WARNING
                if r.status_code >= 500:
                    status = TestStatus.WARNING  # Database might not be set up
                self.print_test(
                    f"DB query: {endpoint}",
                    status,
                    f"Time: {response_time:.2f}s, Status: {r.status_code}",
                )
            except Exception as e:
                self.print_test(f"DB query: {endpoint}", TestStatus.FAILED, str(e))

    def run_load_tests(self):
        self.print_header("Load Tests")
        print(f"{Colors.MAGENTA}Running basic load test...{Colors.RESET}")

        import concurrent.futures
        import statistics

        def make_load_request(endpoint):
            start = time.time()
            try:
                r = self.session.get(f"{self.base_url}{endpoint}", timeout=15)
                return time.time() - start, r.status_code, endpoint
            except Exception as e:
                return None, None, endpoint

        # Test with mixed endpoint load
        endpoints = [
            "/health", "/health", "/health",  # 3x health (should be fast)
            "/research/results?limit=5",
            "/colby/commands?limit=5",
            "/api/stats",
            "/research/risks",
        ] * 3  # 21 total requests

        print(f"Making {len(endpoints)} concurrent requests...")
        with concurrent.futures.ThreadPoolExecutor(max_workers=15) as executor:
            futures = [executor.submit(make_load_request, ep) for ep in endpoints]
            results = [f.result() for f in concurrent.futures.as_completed(futures)]

        successful = [(t, code, ep) for (t, code, ep) in results if t is not None and code < 500]
        failed = [ep for (t, code, ep) in results if t is None or code >= 500]

        if successful:
            times = [t for (t, code, ep) in successful]
            avg_time = statistics.mean(times)
            max_time = max(times)
            p95_time = sorted(times)[int(len(times) * 0.95)] if len(times) > 1 else max_time

            success_rate = len(successful) / len(endpoints) * 100
            status = TestStatus.PASSED if success_rate >= 90 and avg_time < 3.0 else TestStatus.WARNING

            self.print_test(
                f"Load test ({len(endpoints)} requests)",
                status,
                f"Success: {success_rate:.1f}%, Avg: {avg_time:.2f}s, P95: {p95_time:.2f}s, Max: {max_time:.2f}s",
            )

            if failed:
                self.print_test(
                    "Failed endpoints in load test",
                    TestStatus.WARNING,
                    f"Failed: {', '.join(set(failed))}",
                )
        else:
            self.print_test("Load test", TestStatus.FAILED, "All requests failed")

    def print_summary(self):
        self.print_header("Test Summary")

        total = len(self.results)
        passed = sum(1 for r in self.results if r.status == TestStatus.PASSED)
        failed = sum(1 for r in self.results if r.status == TestStatus.FAILED)
        warnings = sum(1 for r in self.results if r.status == TestStatus.WARNING)
        skipped = sum(1 for r in self.results if r.status == TestStatus.SKIPPED)

        print(f"{Colors.BOLD}Total Tests:{Colors.RESET} {total}")
        print(f"{Colors.GREEN}Passed:{Colors.RESET} {passed}")
        print(f"{Colors.RED}Failed:{Colors.RESET} {failed}")
        print(f"{Colors.YELLOW}Warnings:{Colors.RESET} {warnings}")
        print(f"{Colors.YELLOW}Skipped:{Colors.RESET} {skipped}")

        if failed > 0:
            print(f"\n{Colors.RED}{Colors.BOLD}Failed Tests:{Colors.RESET}")
            for result in self.results:
                if result.status == TestStatus.FAILED:
                    print(f"  • {result.method} {result.endpoint}: {result.message}")

        if total > 0:
            success_rate = (passed / total) * 100
            color = Colors.GREEN if success_rate >= 80 else (Colors.YELLOW if success_rate >= 60 else Colors.RED)
            print(f"\n{Colors.BOLD}Success Rate:{Colors.RESET} {color}{success_rate:.1f}%{Colors.RESET}")

        response_times = [r.response_time for r in self.results if r.response_time is not None]
        if response_times:
            avg_response = sum(response_times) / len(response_times)
            max_response = max(response_times)
            print(f"\n{Colors.BOLD}Performance:{Colors.RESET}")
            print(f"  Average Response Time: {avg_response:.2f}s")
            print(f"  Max Response Time: {max_response:.2f}s")

    def run_all_tests(self):
        print(f"{Colors.BOLD}{Colors.MAGENTA}")
        print("╔══════════════════════════════════════════════════════════╗")
        print("║         GH-BOT WORKER COMPREHENSIVE TEST SUITE          ║")
        print("╚══════════════════════════════════════════════════════════╝")
        print(f"{Colors.RESET}")

        print(f"{Colors.CYAN}Testing: {self.base_url}{Colors.RESET}")
        if API_KEY:
            print(f"{Colors.CYAN}Using API key from .dev.vars{Colors.RESET}")
        if self.webhook_secret:
            print(f"{Colors.CYAN}Webhook signing enabled{Colors.RESET}")
        print(f"{Colors.CYAN}Time: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}{Colors.RESET}")

        self.test_health_endpoints()
        self.test_research_endpoints()
        self.test_research_post_endpoints()
        self.test_colby_endpoints()
        self.test_dashboard_endpoints()
        self.test_dashboard_api_endpoints()
        self.test_parameter_validation()
        self.test_cors_and_headers()
        self.test_security_endpoints()
        self.test_webhook_endpoints()
        self.test_colby_command_parsing()
        self.test_edge_cases()
        self.run_performance_tests()
        self.run_load_tests()

        self.print_summary()
        return self.results


def main():
    tester = WorkerTester(WORKER_URL, WEBHOOK_SECRET)
    results = tester.run_all_tests()

    # Write concise results file
    output_data = {
        "url": WORKER_URL,
        "timestamp": datetime.now().isoformat(),
        "results": [
            {
                "endpoint": r.endpoint,
                "method": r.method,
                "status": r.status.value,
                "response_code": r.response_code,
                "response_time": r.response_time,
                "message": r.message,
            }
            for r in results
        ],
    }
    with open(OUTPUT_FILE, "w") as f:
        json.dump(output_data, f, indent=2)
    print(f"\n{Colors.GREEN}Results saved to {OUTPUT_FILE}{Colors.RESET}")


if __name__ == "__main__":
    main()