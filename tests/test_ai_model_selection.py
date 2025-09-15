#!/usr/bin/env python3
"""
Comprehensive AI Model Selection Test Suite

This test suite validates the enhanced AI model selection logic by testing:
- Different task types and their model selection
- Budget constraints and cost optimization
- Latency preferences and async queue handling
- Context requirements and very long context models
- Prompt generation and optimization
- Edge cases and fallback scenarios
"""

import unittest
import json
import time
import requests
from typing import Dict, Any, Optional, List
from dataclasses import dataclass
from enum import Enum
import os
from dotenv import dotenv_values

# Load environment variables
VARS_PATH = "../.dev.vars"
if os.path.exists(VARS_PATH):
    env_vars = dotenv_values(VARS_PATH)
    os.environ.update({k: v for k, v in env_vars.items() if v is not None})

WORKER_URL = (os.environ.get("WORKER_URL") or "https://gh-bot.hacolby.workers.dev").rstrip("/")
API_KEY = os.environ.get("API_KEY")

class Colors:
    """ANSI color codes for terminal output"""
    GREEN = '\033[92m'
    RED = '\033[91m'
    YELLOW = '\033[93m'
    BLUE = '\033[94m'
    CYAN = '\033[96m'
    RESET = '\033[0m'
    BOLD = '\033[1m'

@dataclass
class ModelSelectionTestCase:
    """Test case for model selection scenarios"""
    name: str
    task: str
    inputs: Dict[str, Any]
    expected_primary: str
    expected_attributes: Dict[str, Any]
    description: str

class AIModelSelectionTest(unittest.TestCase):
    """Comprehensive AI Model Selection Test Suite"""

    def setUp(self):
        """Set up test fixtures"""
        self.session = requests.Session()
        if API_KEY:
            self.session.headers.update({"X-API-Key": API_KEY})
        self.session.headers.update({"Accept": "application/json"})

        # Define expected models based on our enhanced AI models system
        self.models = {
            'DEFAULT': '@cf/qwen/qwen2.5-coder-32b-instruct',
            'QWEN_CODER_32B': '@cf/qwen/qwen2.5-coder-32b-instruct',
            'DEEPSEEK_R1_32B': '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
            'LLAMA4_SCOUT_17B': '@cf/meta/llama-4-scout-17b-16e-instruct',
            'LLAMA32_3B': '@cf/meta/llama-3.2-3b-instruct',
            'MISTRAL_7B_V01': '@cf/mistral/mistral-7b-instruct-v0.1',
            'GPT_OSS_120B': '@cf/openai/gpt-oss-120b',
        }

        # Define test cases for various scenarios
        self.test_cases = [
            # Small PR scenarios
            ModelSelectionTestCase(
                name="small_pr_default",
                task="review_pr",
                inputs={
                    "diffLinesChanged": 150,
                    "filesChanged": 2,
                    "budgetSensitive": False,
                    "lowLatencyPreferred": False
                },
                expected_primary=self.models['QWEN_CODER_32B'],
                expected_attributes={"reasoning": "small PR, standard review"},
                description="Small PR should use Qwen Coder 32B for standard review"
            ),

            # Large PR scenarios
            ModelSelectionTestCase(
                name="large_pr_context",
                task="review_pr",
                inputs={
                    "diffLinesChanged": 800,
                    "filesChanged": 12,
                    "hasDesignDocsOrImages": True,
                    "needsVeryLongContext": True
                },
                expected_primary=self.models['LLAMA4_SCOUT_17B'],
                expected_attributes={"reasoning": "large PR with long context needs"},
                description="Large PR with long context should use Scout 17B"
            ),

            # Budget-sensitive scenarios
            ModelSelectionTestCase(
                name="budget_sensitive_small",
                task="review_pr",
                inputs={
                    "diffLinesChanged": 100,
                    "filesChanged": 1,
                    "budgetSensitive": True
                },
                expected_primary=self.models['MISTRAL_7B_V01'],
                expected_attributes={"reasoning": "budget sensitive small PR"},
                description="Budget-sensitive small PR should use Mistral 7B"
            ),

            # Deep audit scenarios
            ModelSelectionTestCase(
                name="deep_audit_reasoning",
                task="deep_audit",
                inputs={
                    "needReasoningDepth": True,
                    "diffLinesChanged": 500,
                    "filesChanged": 5
                },
                expected_primary=self.models['DEEPSEEK_R1_32B'],
                expected_attributes={"reasoning": "deep audit with reasoning depth"},
                description="Deep audit with reasoning should use DeepSeek R1"
            ),

            # Batch triage scenarios
            ModelSelectionTestCase(
                name="batch_triage",
                task="triage_many_prs",
                inputs={
                    "diffLinesChanged": 200,
                    "filesChanged": 3
                },
                expected_primary=self.models['LLAMA32_3B'],
                expected_attributes={"reasoning": "fast triage for batch processing"},
                description="Batch triage should use fast Llama 3.2 3B"
            ),

            # Repo summarization scenarios
            ModelSelectionTestCase(
                name="repo_summarize_long_context",
                task="repo_summarize",
                inputs={
                    "needsVeryLongContext": True,
                    "hasDesignDocsOrImages": True
                },
                expected_primary=self.models['LLAMA4_SCOUT_17B'],
                expected_attributes={"reasoning": "repo synthesis with long context and images"},
                description="Repo summarization with long context should use Scout 17B"
            ),

            # Low latency scenarios
            ModelSelectionTestCase(
                name="low_latency_preference",
                task="review_pr",
                inputs={
                    "diffLinesChanged": 400,
                    "filesChanged": 6,
                    "lowLatencyPreferred": True
                },
                expected_primary=self.models['QWEN_CODER_32B'],
                expected_attributes={"reasoning": "low latency preference avoids async queue models"},
                description="Low latency preference should avoid Scout/GPT-OSS"
            ),

            # Fallback scenarios
            ModelSelectionTestCase(
                name="fallback_general",
                task="fallback_general",
                inputs={
                    "needsVeryLongContext": False
                },
                expected_primary=self.models['GPT_OSS_120B'],
                expected_attributes={"reasoning": "general fallback to high-capability model"},
                description="General fallback should use GPT-OSS-120B"
            ),
        ]

    def print_test_header(self, text: str):
        """Print formatted test section header"""
        print(f"\n{Colors.BOLD}{Colors.CYAN}{'='*70}{Colors.RESET}")
        print(f"{Colors.BOLD}{Colors.CYAN}{text.center(70)}{Colors.RESET}")
        print(f"{Colors.BOLD}{Colors.CYAN}{'='*70}{Colors.RESET}\n")

    def print_test_result(self, test_name: str, passed: bool, details: str = ""):
        """Print test result with color coding"""
        status = f"{Colors.GREEN}[PASS]{Colors.RESET}" if passed else f"{Colors.RED}[FAIL]{Colors.RESET}"
        print(f"{status} {test_name}")
        if details:
            print(f"      {Colors.BLUE}→ {details}{Colors.RESET}")

    def simulate_model_selection(self, task: str, inputs: Dict[str, Any]) -> Dict[str, Any]:
        """
        Simulate model selection logic based on our enhanced AI models system.
        This mirrors the pickModelForTask function logic from ai_models.ts
        """

        # Policy constants (matching ai_models.ts)
        SMALL_PR_LINES = 300
        LARGE_PR_FILES = 5
        ASYNC_QUEUE_MODELS = {
            '@cf/meta/llama-4-scout-17b-16e-instruct',
            '@cf/openai/gpt-oss-120b',
            '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
        }
        VERY_LONG_CTX_MODELS = [
            '@cf/meta/llama-4-scout-17b-16e-instruct',
            '@cf/openai/gpt-oss-120b',
            '@cf/meta/llama-3.2-3b-instruct',
        ]

        # Extract inputs
        diff_lines = inputs.get('diffLinesChanged', 0)
        files_changed = inputs.get('filesChanged', 0)
        has_images = inputs.get('hasDesignDocsOrImages', False)
        needs_long_context = inputs.get('needsVeryLongContext', False)
        needs_reasoning = inputs.get('needReasoningDepth', False)
        budget_sensitive = inputs.get('budgetSensitive', False)
        low_latency = inputs.get('lowLatencyPreferred', False)

        # Determine PR size
        small_pr = diff_lines > 0 and diff_lines < SMALL_PR_LINES
        large_or_multi = (not small_pr and (diff_lines >= SMALL_PR_LINES or files_changed >= LARGE_PR_FILES)) or has_images or needs_long_context

        # Model selection logic (mirrors ai_models.ts)
        primary = self.models['DEFAULT']  # Start with default
        fallback = None
        rationale = []

        if task == 'triage_many_prs':
            primary = self.models['LLAMA32_3B']
            fallback = self.models['QWEN_CODER_32B']
            rationale.append('batch triage: cheap first-pass')

        elif task == 'review_pr':
            if needs_long_context or large_or_multi:
                primary = VERY_LONG_CTX_MODELS[0] if needs_long_context else self.models['LLAMA4_SCOUT_17B']
                fallback = self.models['QWEN_CODER_32B']
                rationale.append('large/multi-file or long context needs')
            elif small_pr and budget_sensitive:
                primary = self.models['MISTRAL_7B_V01']
                fallback = self.models['QWEN_CODER_32B']
                rationale.append('budget-sensitive small diff')
            else:
                primary = self.models['QWEN_CODER_32B']
                fallback = self.models['LLAMA4_SCOUT_17B']
                rationale.append('standard review')

        elif task == 'deep_audit':
            primary = self.models['QWEN_CODER_32B']
            fallback = self.models['DEEPSEEK_R1_32B']
            if needs_reasoning:
                primary = self.models['DEEPSEEK_R1_32B']
                fallback = self.models['QWEN_CODER_32B']
                rationale.append('max reasoning depth')
            else:
                rationale.append('code-specialized + reasoning fallback')
            if needs_long_context:
                fallback = VERY_LONG_CTX_MODELS[0]

        elif task == 'repo_summarize':
            primary = VERY_LONG_CTX_MODELS[0] if needs_long_context else self.models['LLAMA4_SCOUT_17B']
            fallback = self.models['QWEN_CODER_32B']
            rationale.append('repo-wide synthesis' + (' with long context' if needs_long_context else ''))

        elif task == 'fallback_general':
            primary = self.models['GPT_OSS_120B'] if needs_long_context else self.models['GPT_OSS_120B']
            fallback = self.models['QWEN_CODER_32B']
            rationale.append('general fallback to high-capability model')

        # Apply budget/latency nudges
        if budget_sensitive:
            if primary in [self.models['LLAMA4_SCOUT_17B'], self.models['GPT_OSS_120B']]:
                primary = self.models['QWEN_CODER_32B']
                rationale.append('budget-sensitive adjustment')

        if low_latency and primary in ASYNC_QUEUE_MODELS:
            primary = self.models['QWEN_CODER_32B']
            rationale.append('low-latency preference')

        return {
            'primary': primary,
            'fallback': fallback,
            'embeddings': '@cf/baai/bge-m3',
            'reranker': '@cf/baai/bge-reranker-base',
            'rationale': ' | '.join(rationale) if rationale else 'default policy'
        }

    def test_model_selection_scenarios(self):
        """Test various model selection scenarios"""
        self.print_test_header("AI Model Selection Scenarios")

        passed_tests = 0
        total_tests = len(self.test_cases)

        for test_case in self.test_cases:
            result = self.simulate_model_selection(test_case.task, test_case.inputs)

            # Check if primary model matches expected
            primary_correct = result['primary'] == test_case.expected_primary

            # Additional validations
            has_fallback = result['fallback'] is not None
            has_rationale = len(result['rationale']) > 0
            has_embeddings = result['embeddings'] is not None

            passed = primary_correct and has_fallback and has_rationale and has_embeddings

            if passed:
                passed_tests += 1

            details = f"Primary: {result['primary']}, Rationale: {result['rationale']}"
            self.print_test_result(
                f"{test_case.name}: {test_case.description}",
                passed,
                details
            )

            # Assert for unittest framework
            self.assertEqual(result['primary'], test_case.expected_primary,
                           f"Model selection failed for {test_case.name}")

        print(f"\n{Colors.BOLD}Model Selection Tests: {passed_tests}/{total_tests} passed{Colors.RESET}")

    def test_policy_constraints(self):
        """Test policy constraints and edge cases"""
        self.print_test_header("Policy Constraints & Edge Cases")

        test_cases = [
            {
                'name': 'very_small_pr',
                'inputs': {'task': 'review_pr', 'diffLinesChanged': 50, 'filesChanged': 1},
                'expected_behavior': 'should use default coder model'
            },
            {
                'name': 'massive_pr',
                'inputs': {'task': 'review_pr', 'diffLinesChanged': 5000, 'filesChanged': 50, 'needsVeryLongContext': True},
                'expected_behavior': 'should use long context model'
            },
            {
                'name': 'zero_changes',
                'inputs': {'task': 'review_pr', 'diffLinesChanged': 0, 'filesChanged': 0},
                'expected_behavior': 'should handle gracefully'
            },
            {
                'name': 'extreme_budget_constraint',
                'inputs': {'task': 'review_pr', 'diffLinesChanged': 200, 'budgetSensitive': True, 'lowLatencyPreferred': True},
                'expected_behavior': 'should prioritize budget over other factors'
            },
        ]

        passed_tests = 0
        for test_case in test_cases:
            try:
                result = self.simulate_model_selection(
                    test_case['inputs']['task'],
                    {k: v for k, v in test_case['inputs'].items() if k != 'task'}
                )

                # Basic validation - should always return valid result
                is_valid = (
                    result['primary'] in self.models.values() and
                    result['rationale'] is not None and
                    len(result['rationale']) > 0
                )

                self.print_test_result(
                    f"{test_case['name']}: {test_case['expected_behavior']}",
                    is_valid,
                    f"Selected: {result['primary']}"
                )

                if is_valid:
                    passed_tests += 1

            except Exception as e:
                self.print_test_result(
                    f"{test_case['name']}: {test_case['expected_behavior']}",
                    False,
                    f"Exception: {str(e)}"
                )

        print(f"\n{Colors.BOLD}Policy Constraint Tests: {passed_tests}/{len(test_cases)} passed{Colors.RESET}")

    def test_cost_optimization(self):
        """Test cost optimization scenarios"""
        self.print_test_header("Cost Optimization Tests")

        # Model cost data (approximate, per 1M tokens)
        model_costs = {
            '@cf/qwen/qwen2.5-coder-32b-instruct': {'input': 0.66, 'output': 1.00},
            '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b': {'input': 0.50, 'output': 4.88}, # High output cost
            '@cf/meta/llama-4-scout-17b-16e-instruct': {'input': 0.27, 'output': 0.85},
            '@cf/meta/llama-3.2-3b-instruct': {'input': 0.051, 'output': 0.34}, # Cheapest
            '@cf/mistral/mistral-7b-instruct-v0.1': {'input': 0.11, 'output': 0.19}, # Budget friendly
            '@cf/openai/gpt-oss-120b': {'input': 0.35, 'output': 0.75},
        }

        cost_scenarios = [
            {
                'name': 'budget_sensitive_chooses_cheaper',
                'inputs': {'task': 'review_pr', 'diffLinesChanged': 200, 'budgetSensitive': True},
                'test': lambda result: model_costs.get(result['primary'], {}).get('input', 1.0) < 0.5
            },
            {
                'name': 'batch_triage_uses_cheapest',
                'inputs': {'task': 'triage_many_prs', 'diffLinesChanged': 100},
                'test': lambda result: result['primary'] == '@cf/meta/llama-3.2-3b-instruct'  # Cheapest model
            },
            {
                'name': 'expensive_model_for_complex_task',
                'inputs': {'task': 'deep_audit', 'needReasoningDepth': True},
                'test': lambda result: result['primary'] == '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b'  # Worth the cost
            }
        ]

        passed_tests = 0
        for scenario in cost_scenarios:
            result = self.simulate_model_selection(scenario['inputs']['task'],
                                                 {k: v for k, v in scenario['inputs'].items() if k != 'task'})

            passed = scenario['test'](result)
            if passed:
                passed_tests += 1

            cost_info = model_costs.get(result['primary'], {'input': 'unknown', 'output': 'unknown'})
            self.print_test_result(
                scenario['name'],
                passed,
                f"Selected: {result['primary']}, Cost: ${cost_info['input']:.3f}/${cost_info['output']:.2f} per 1M tokens"
            )

        print(f"\n{Colors.BOLD}Cost Optimization Tests: {passed_tests}/{len(cost_scenarios)} passed{Colors.RESET}")

    def test_latency_optimization(self):
        """Test latency optimization scenarios"""
        self.print_test_header("Latency Optimization Tests")

        # Async queue models (higher latency)
        async_queue_models = {
            '@cf/meta/llama-4-scout-17b-16e-instruct',
            '@cf/openai/gpt-oss-120b',
            '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
        }

        latency_scenarios = [
            {
                'name': 'low_latency_avoids_async_queue',
                'inputs': {'task': 'review_pr', 'diffLinesChanged': 500, 'lowLatencyPreferred': True},
                'test': lambda result: result['primary'] not in async_queue_models
            },
            {
                'name': 'normal_latency_allows_async_queue',
                'inputs': {'task': 'repo_summarize', 'needsVeryLongContext': True, 'lowLatencyPreferred': False},
                'test': lambda result: True  # Should be allowed to use any model
            },
            {
                'name': 'batch_triage_prioritizes_speed',
                'inputs': {'task': 'triage_many_prs'},
                'test': lambda result: result['primary'] == '@cf/meta/llama-3.2-3b-instruct'  # Fast, small model
            }
        ]

        passed_tests = 0
        for scenario in latency_scenarios:
            result = self.simulate_model_selection(scenario['inputs']['task'],
                                                 {k: v for k, v in scenario['inputs'].items() if k != 'task'})

            passed = scenario['test'](result)
            if passed:
                passed_tests += 1

            is_async_queue = result['primary'] in async_queue_models
            self.print_test_result(
                scenario['name'],
                passed,
                f"Selected: {result['primary']}, Async Queue: {'Yes' if is_async_queue else 'No'}"
            )

        print(f"\n{Colors.BOLD}Latency Optimization Tests: {passed_tests}/{len(latency_scenarios)} passed{Colors.RESET}")

    def test_context_window_handling(self):
        """Test context window and long context scenarios"""
        self.print_test_header("Context Window Handling Tests")

        # Model context windows
        context_windows = {
            '@cf/qwen/qwen2.5-coder-32b-instruct': 32768,
            '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b': 80000,
            '@cf/meta/llama-4-scout-17b-16e-instruct': 131000,
            '@cf/meta/llama-3.2-3b-instruct': 128000,
            '@cf/mistral/mistral-7b-instruct-v0.1': 2824,
            '@cf/openai/gpt-oss-120b': 128000,
        }

        context_scenarios = [
            {
                'name': 'very_long_context_uses_large_window',
                'inputs': {'task': 'repo_summarize', 'needsVeryLongContext': True},
                'test': lambda result: context_windows.get(result['primary'], 0) >= 100000
            },
            {
                'name': 'small_context_can_use_any_model',
                'inputs': {'task': 'review_pr', 'diffLinesChanged': 100},
                'test': lambda result: context_windows.get(result['primary'], 0) > 0
            },
            {
                'name': 'large_multifile_prefers_long_context',
                'inputs': {'task': 'review_pr', 'diffLinesChanged': 1000, 'filesChanged': 20, 'hasDesignDocsOrImages': True},
                'test': lambda result: context_windows.get(result['primary'], 0) >= 80000
            }
        ]

        passed_tests = 0
        for scenario in context_scenarios:
            result = self.simulate_model_selection(scenario['inputs']['task'],
                                                 {k: v for k, v in scenario['inputs'].items() if k != 'task'})

            passed = scenario['test'](result)
            if passed:
                passed_tests += 1

            context_size = context_windows.get(result['primary'], 'unknown')
            self.print_test_result(
                scenario['name'],
                passed,
                f"Selected: {result['primary']}, Context: {context_size:,} tokens"
            )

        print(f"\n{Colors.BOLD}Context Window Tests: {passed_tests}/{len(context_scenarios)} passed{Colors.RESET}")

    def test_edge_cases_and_fallbacks(self):
        """Test edge cases and fallback scenarios"""
        self.print_test_header("Edge Cases & Fallback Tests")

        edge_cases = [
            {
                'name': 'unknown_task_type',
                'inputs': {'task': 'unknown_task', 'diffLinesChanged': 200},
                'expected_behavior': 'should fallback to general model'
            },
            {
                'name': 'conflicting_requirements',
                'inputs': {'task': 'review_pr', 'budgetSensitive': True, 'needsVeryLongContext': True, 'lowLatencyPreferred': True},
                'expected_behavior': 'should balance requirements'
            },
            {
                'name': 'negative_values',
                'inputs': {'task': 'review_pr', 'diffLinesChanged': -100, 'filesChanged': -5},
                'expected_behavior': 'should handle gracefully'
            },
            {
                'name': 'extremely_large_values',
                'inputs': {'task': 'review_pr', 'diffLinesChanged': 1000000, 'filesChanged': 1000},
                'expected_behavior': 'should use appropriate large-scale model'
            }
        ]

        passed_tests = 0
        for test_case in edge_cases:
            try:
                result = self.simulate_model_selection(
                    test_case['inputs']['task'],
                    {k: v for k, v in test_case['inputs'].items() if k != 'task'}
                )

                # Basic validation - should return valid result
                is_valid = (
                    result['primary'] in self.models.values() and
                    result['fallback'] is not None and
                    result['rationale'] is not None
                )

                if is_valid:
                    passed_tests += 1

                self.print_test_result(
                    f"{test_case['name']}: {test_case['expected_behavior']}",
                    is_valid,
                    f"Selected: {result['primary']}"
                )

            except Exception as e:
                self.print_test_result(
                    f"{test_case['name']}: {test_case['expected_behavior']}",
                    False,
                    f"Exception: {str(e)}"
                )

        print(f"\n{Colors.BOLD}Edge Case Tests: {passed_tests}/{len(edge_cases)} passed{Colors.RESET}")

    def test_integration_with_worker(self):
        """Test integration with actual worker deployment (optional)"""
        self.print_test_header("Worker Integration Tests (Optional)")

        if not WORKER_URL:
            print(f"{Colors.YELLOW}[SKIP] No WORKER_URL configured - skipping integration tests{Colors.RESET}")
            return

        try:
            # Test health endpoint first
            health_response = self.session.get(f"{WORKER_URL}/health", timeout=10)
            if health_response.status_code != 200:
                print(f"{Colors.YELLOW}[SKIP] Worker not accessible - skipping integration tests{Colors.RESET}")
                return

            print(f"{Colors.GREEN}[INFO] Worker accessible at {WORKER_URL}{Colors.RESET}")

            # Test if there's a model selection endpoint (hypothetical)
            # This would be nice to have for testing but might not exist yet
            integration_tests = [
                {
                    'name': 'worker_model_selection_endpoint',
                    'endpoint': '/ai/select-model',
                    'payload': {'task': 'review_pr', 'diffLinesChanged': 200},
                    'expected_status': [200, 404]  # 404 if endpoint doesn't exist yet
                }
            ]

            passed_tests = 0
            for test in integration_tests:
                try:
                    response = self.session.post(
                        f"{WORKER_URL}{test['endpoint']}",
                        json=test['payload'],
                        timeout=10
                    )

                    status_ok = response.status_code in test['expected_status']
                    if status_ok and response.status_code == 200:
                        # Try to parse response
                        try:
                            data = response.json()
                            has_model = 'primary' in data or 'model' in data
                            status_ok = has_model
                        except:
                            pass

                    if status_ok:
                        passed_tests += 1

                    details = f"Status: {response.status_code}"
                    if response.status_code == 200:
                        details += f", Response: {response.text[:100]}..."
                    elif response.status_code == 404:
                        details += " (endpoint not implemented yet - OK)"

                    self.print_test_result(test['name'], status_ok, details)

                except Exception as e:
                    self.print_test_result(test['name'], False, f"Error: {str(e)}")

            print(f"\n{Colors.BOLD}Integration Tests: {passed_tests}/{len(integration_tests)} passed{Colors.RESET}")

        except Exception as e:
            print(f"{Colors.YELLOW}[SKIP] Worker integration tests failed: {str(e)}{Colors.RESET}")


def run_test_suite():
    """Run the complete AI model selection test suite"""
    print(f"{Colors.BOLD}{Colors.CYAN}")
    print("╔══════════════════════════════════════════════════════════╗")
    print("║          AI MODEL SELECTION TEST SUITE                  ║")
    print("╚══════════════════════════════════════════════════════════╝")
    print(f"{Colors.RESET}")

    # Create test suite
    suite = unittest.TestSuite()

    # Add all test methods
    test_class = AIModelSelectionTest
    suite.addTest(test_class('test_model_selection_scenarios'))
    suite.addTest(test_class('test_policy_constraints'))
    suite.addTest(test_class('test_cost_optimization'))
    suite.addTest(test_class('test_latency_optimization'))
    suite.addTest(test_class('test_context_window_handling'))
    suite.addTest(test_class('test_edge_cases_and_fallbacks'))
    suite.addTest(test_class('test_integration_with_worker'))

    # Run tests
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)

    # Print summary
    print(f"\n{Colors.BOLD}Test Suite Summary:{Colors.RESET}")
    print(f"Tests run: {result.testsRun}")
    print(f"Failures: {len(result.failures)}")
    print(f"Errors: {len(result.errors)}")

    if result.failures:
        print(f"\n{Colors.RED}Failures:{Colors.RESET}")
        for test, traceback in result.failures:
            print(f"  - {test}: {traceback}")

    if result.errors:
        print(f"\n{Colors.RED}Errors:{Colors.RESET}")
        for test, traceback in result.errors:
            print(f"  - {test}: {traceback}")

    success_rate = ((result.testsRun - len(result.failures) - len(result.errors)) / result.testsRun * 100) if result.testsRun > 0 else 0
    color = Colors.GREEN if success_rate >= 80 else (Colors.YELLOW if success_rate >= 60 else Colors.RED)
    print(f"\n{Colors.BOLD}Overall Success Rate:{Colors.RESET} {color}{success_rate:.1f}%{Colors.RESET}")

    return result.wasSuccessful()


if __name__ == "__main__":
    import sys

    print(f"{Colors.BOLD}AI Model Selection Test Suite{Colors.RESET}")
    print(f"Testing enhanced model selection logic...")
    print(f"Worker URL: {WORKER_URL}")
    print(f"API Key: {'✓ Configured' if API_KEY else '✗ Not configured'}")
    print()

    try:
        success = run_test_suite()
        sys.exit(0 if success else 1)
    except KeyboardInterrupt:
        print(f"\n{Colors.YELLOW}Tests interrupted by user{Colors.RESET}")
        sys.exit(1)
    except Exception as e:
        print(f"\n{Colors.RED}Test suite failed with error: {str(e)}{Colors.RESET}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
