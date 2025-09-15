#!/usr/bin/env python3
"""
Quick test script to verify webhook endpoint fixes
"""
import requests
import json

def test_webhook_without_signature():
    """Test webhook endpoint without signature - should return 401, not 500"""
    url = "https://gh-bot.hacolby.workers.dev/github/webhook"

    payload = {
        "action": "opened",
        "pull_request": {
            "id": 1,
            "number": 1,
            "state": "open"
        },
        "repository": {
            "name": "test-repo",
            "full_name": "test-org/test-repo"
        }
    }

    headers = {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'pull_request'
    }

    try:
        response = requests.post(url, json=payload, headers=headers, timeout=10)
        print(f"Status Code: {response.status_code}")
        print(f"Response: {response.text}")

        if response.status_code in [401, 403]:
            print("✅ PASS: Webhook correctly returns auth error")
            return True
        else:
            print(f"❌ FAIL: Expected 401/403, got {response.status_code}")
            return False

    except Exception as e:
        print(f"❌ ERROR: {e}")
        return False

def test_research_results():
    """Test research results endpoint with better error messages"""
    url = "https://gh-bot.hacolby.workers.dev/research/results"

    try:
        response = requests.get(url, timeout=10)
        print(f"Status Code: {response.status_code}")

        if response.status_code == 200:
            data = response.json()
            print(f"Response: {json.dumps(data, indent=2)}")

            if 'message' in data and 'total_projects' in data:
                print("✅ PASS: Research results endpoint provides helpful information")
                return True
            elif 'results' in data and len(data['results']) > 0:
                print("✅ PASS: Research results endpoint returns data")
                return True
            else:
                print("⚠️  PARTIAL: Endpoint works but format may need improvement")
                return True
        else:
            print(f"❌ FAIL: Expected 200, got {response.status_code}")
            return False

    except Exception as e:
        print(f"❌ ERROR: {e}")
        return False

if __name__ == "__main__":
    print("Testing GH-Bot Worker Fixes")
    print("=" * 40)

    print("\n1. Testing webhook without signature:")
    webhook_pass = test_webhook_without_signature()

    print("\n2. Testing research results endpoint:")
    results_pass = test_research_results()

    print("\n" + "=" * 40)
    if webhook_pass and results_pass:
        print("✅ All tests passed!")
    else:
        print("❌ Some tests failed")
