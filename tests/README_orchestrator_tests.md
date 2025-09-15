# AI Orchestrator Test Suite

## Overview

This comprehensive test suite validates the AI Orchestrator system that provides intelligent model selection and prompt generation for the GitHub bot worker. The orchestrator uses OpenAI's gpt-4o-mini for meta-reasoning about optimal model choices.

## Test Coverage

### 🧠 Model Selection Scenarios
- **Small PR Review**: Validates selection of Qwen Coder 32B for PRs <300 lines
- **Large PR Review**: Tests Scout 17B selection for large PRs >300 lines
- **Deep Security Audit**: Verifies DeepSeek R1 selection for reasoning-heavy tasks
- **Budget-Sensitive Review**: Ensures cheap models for budget constraints
- **Low-Latency Preference**: Validates avoidance of async queue models
- **Batch Triage**: Tests fast, cheap model selection for batch processing
- **Repo Summarization**: Verifies long-context model selection

### 📋 JSON Schema Compliance
- Validates orchestrator response structure against defined schema
- Tests required fields: `model`, `prompt`, `rationale`, `translation`
- Verifies proper data types and nested object structures
- Tests invalid responses are correctly rejected

### 🔄 OpenAI Fallback Scenarios
- **No OpenAI Key**: Validates CF model fallback when key missing
- **OpenAI API Error**: Tests fallback on rate limits/API failures
- **OpenAI Success**: Confirms OpenAI usage when available
- **OpenAI Timeout**: Validates fallback on request timeouts

### 💰 Cost Optimization
- **Budget-Sensitive Small PR**: Validates cheap model usage ($0.0001-$0.002)
- **High-Quality Deep Audit**: Allows expensive models for quality ($0.002-$0.02)
- **Batch Triage**: Enforces very cheap models for batch processing ($0.0001-$0.001)
- **Large Repo Analysis**: Medium cost for long-context analysis ($0.001-$0.01)

### ⚡ Latency Preferences
- **Low Latency PR Review**: Avoids Scout 17B and GPT-OSS-120B
- **Standard Latency Deep Audit**: Allows slower models when latency not critical
- **Fast Batch Processing**: Prefers Llama 3.2 3B for speed

### 🌍 Non-English Detection
- **English Content**: Correctly identifies English with high confidence
- **Chinese Content**: Detects Chinese characters, triggers translation
- **Spanish Content**: Identifies Spanish text patterns, triggers translation
- **Mixed Content**: Handles code with foreign terms appropriately
- **Code Only**: Treats pure code as English context

### 💾 Caching Mechanism
- **Cache Hit**: Same requests return cached results
- **Cache Miss**: Different requests bypass cache
- **Cache Expiry**: Expired cache (>300s) forces new orchestration

### 🔧 Full Integration
- **End-to-End PR Review**: Complete workflow with model selection, prompt generation, cost estimation
- **Multilingual Deep Audit**: Security audit with translation detection
- **Budget-Constrained Batch**: Cost-optimized batch processing workflow

## Usage

### Running the Test Suite

```bash
# Run all orchestrator tests
python tests/test_orchestrator.py

# Run with verbose output
python -v tests/test_orchestrator.py
```

### Test Results

The test suite provides:
- ✅ **PASS**: Test succeeded
- ❌ **FAIL**: Test failed with error details
- ⏭️ **SKIP**: Test skipped (not applicable)
- ℹ️ **INFO**: Informational message

### Example Output

```
🚀 Starting Orchestrator Test Suite
============================================================

🧠 Testing Model Selection Scenarios
==================================================
✅ PASS Small PR Review: Selected correct model: @cf/qwen/qwen2.5-coder-32b-instruct
✅ PASS Large PR Review: Selected correct model: @cf/meta/llama-4-scout-17b-16e-instruct
✅ PASS Deep Security Audit: Selected correct model: @cf/deepseek-ai/deepseek-r1-distill-qwen-32b
...

🏁 Test Suite Summary
============================================================
Total Tests: 45
✅ Passed: 43
❌ Failed: 2
⏭️ Skipped: 0
📊 Pass Rate: 95.6%
```

## Test Architecture

### Simulation-Based Testing

Since the orchestrator involves complex AI interactions, the test suite uses simulation:

- **Model Selection**: Simulates pickModelForTask logic based on task descriptions
- **Cost Estimation**: Uses pricing models to estimate request costs
- **Language Detection**: Heuristic-based detection for test scenarios
- **OpenAI Calls**: Mocks API calls and fallback behavior
- **Caching**: Simulates cache hit/miss scenarios

### Test Data

The suite includes comprehensive test cases:
- **7 Model Selection Scenarios**: Cover all major use cases
- **2 Schema Validation Tests**: Valid and invalid response structures
- **4 Fallback Scenarios**: Different OpenAI failure modes
- **4 Cost Optimization Tests**: Budget vs quality trade-offs
- **3 Latency Tests**: Low latency vs standard requirements
- **5 Language Detection Tests**: English, Chinese, Spanish, mixed, code-only
- **3 Caching Tests**: Hit, miss, and expiry scenarios
- **3 Integration Tests**: End-to-end workflows

## Integration with CI/CD

Add to your continuous integration pipeline:

```yaml
# GitHub Actions example
- name: Run Orchestrator Tests
  run: python tests/test_orchestrator.py

# Or as part of broader test suite
- name: Run All Tests
  run: |
    python tests/test_orchestrator.py
    python tests/test_ai_model_selection.py
    python tests/test_comprehensive.py
```

## Extending Tests

To add new test scenarios:

1. **Add Test Method**: Create `test_new_feature()` method
2. **Define Test Cases**: Create data structures with expected outcomes
3. **Implement Simulation**: Add helper methods to simulate behavior
4. **Update Documentation**: Document new test coverage

Example:
```python
def test_new_feature(self):
    """Test new orchestrator feature"""
    test_cases = [
        {
            "name": "New Feature Test",
            "inputs": {"param": "value"},
            "expected": "result"
        }
    ]

    for test in test_cases:
        result = self._simulate_new_feature(test["inputs"])
        if result == test["expected"]:
            self.log(TestResult.PASS, test["name"], "Feature works correctly")
        else:
            self.log(TestResult.FAIL, test["name"], f"Expected {test['expected']}, got {result}")
```

## Troubleshooting

### Common Issues

1. **Import Errors**: Ensure `src/` directory is in Python path
2. **Missing Dependencies**: Install required Python packages
3. **Test Failures**: Check simulation logic matches actual implementation

### Debug Mode

For detailed debugging, modify test methods to add extra logging:

```python
def test_with_debug(self):
    print(f"Debug: Running test with inputs: {inputs}")
    result = self._simulate_behavior(inputs)
    print(f"Debug: Got result: {result}")
    # ... rest of test
```

## Performance

The test suite is designed for speed:
- **No Network Calls**: All AI interactions are simulated
- **Minimal I/O**: Tests run in memory without file operations
- **Fast Execution**: Complete suite runs in <5 seconds
- **Parallel Safe**: Tests don't share mutable state

## Maintenance

Keep tests synchronized with orchestrator changes:
- **Model Updates**: Update expected model selections when policies change
- **Schema Changes**: Modify validation tests when response format evolves
- **Feature Additions**: Add test coverage for new orchestrator capabilities
- **Cost Updates**: Update pricing expectations when model costs change
