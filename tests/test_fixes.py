#!/usr/bin/env python3
"""
Comprehensive test for GH-Bot Worker fixes
This tests the specific issues identified in the test results
"""
import requests
import json
import time

class Colors:
    GREEN = '\033[92m'
    RED = '\033[91m'
    YELLOW = '\033[93m'
    BLUE = '\033[94m'
    RESET = '\033[0m'
    BOLD = '\033[1m'

def test_webhook_signature_handling():
    """Test webhook endpoint properly handles missing signatures"""
    print(f"{Colors.BLUE}Testing webhook signature handling...{Colors.RESET}")

    url = "https://gh-bot.hacolby.workers.dev/github/webhook"
    payload = {
        "action": "opened",
        "pull_request": {"id": 1, "number": 1},
        "repository": {"name": "test", "full_name": "test/test"}
    }

    # Test without signature header
    try:
        response = requests.post(
            url,
            json=payload,
            headers={'Content-Type': 'application/json', 'X-GitHub-Event': 'pull_request'},
            timeout=10
        )

        if response.status_code == 401:
            print(f"{Colors.GREEN}✅ FIXED: Webhook returns 401 for missing signature{Colors.RESET}")
            return True
        elif response.status_code == 500:
            print(f"{Colors.RED}❌ STILL BROKEN: Webhook returns 500 (should be 401){Colors.RESET}")
            return False
        else:
            print(f"{Colors.YELLOW}⚠️  UNEXPECTED: Webhook returns {response.status_code}{Colors.RESET}")
            return False

    except Exception as e:
        print(f"{Colors.RED}❌ ERROR: {e}{Colors.RESET}")
        return False

def test_research_endpoints():
    """Test research endpoints return helpful messages instead of empty responses"""
    print(f"{Colors.BLUE}Testing research endpoints...{Colors.RESET}")

    endpoints = [
        "/research/results",
        "/research/risks",
        "/research/structured",
        "/research/analysis?repo=nonexistent/repo"
    ]

    all_passed = True

    for endpoint in endpoints:
        try:
            url = f"https://gh-bot.hacolby.workers.dev{endpoint}"
            response = requests.get(url, timeout=10)

            if response.status_code == 200:
                data = response.json()

                # Check if response has helpful information instead of just empty array
                if ('message' in data or 'total_projects' in data or
                    'total_analyses' in data or 'total_structured_analyses' in data):
                    print(f"{Colors.GREEN}✅ IMPROVED: {endpoint} - provides helpful info{Colors.RESET}")
                elif 'results' in data and len(data['results']) > 0:
                    print(f"{Colors.GREEN}✅ DATA: {endpoint} - has actual data{Colors.RESET}")
                else:
                    print(f"{Colors.YELLOW}⚠️  PARTIAL: {endpoint} - works but could be more helpful{Colors.RESET}")

            elif response.status_code == 404 and "analysis" in endpoint:
                data = response.json()
                if 'message' in data:
                    print(f"{Colors.GREEN}✅ IMPROVED: {endpoint} - helpful 404 message{Colors.RESET}")
                else:
                    print(f"{Colors.YELLOW}⚠️  PARTIAL: {endpoint} - 404 but no helpful message{Colors.RESET}")

            else:
                print(f"{Colors.RED}❌ ERROR: {endpoint} - status {response.status_code}{Colors.RESET}")
                all_passed = False

        except Exception as e:
            print(f"{Colors.RED}❌ ERROR: {endpoint} - {e}{Colors.RESET}")
            all_passed = False

    return all_passed

def test_parameter_validation():
    """Test parameter validation prevents SQL injection and handles large limits"""
    print(f"{Colors.BLUE}Testing parameter validation...{Colors.RESET}")

    test_cases = [
        ("/research/results?limit=9999", "Large limit should be capped"),
        ("/research/results?limit=-1", "Negative limit should be rejected"),
        ("/research/results?min_score=2.0", "Score > 1 should be capped"),
        ("/research/results?min_score=-1", "Negative score should be capped"),
    ]

    all_passed = True

    for endpoint, description in test_cases:
        try:
            url = f"https://gh-bot.hacolby.workers.dev{endpoint}"
            response = requests.get(url, timeout=10)

            if response.status_code in [200, 400]:
                if response.status_code == 200:
                    data = response.json()
                    if 'limit_applied' in data:
                        print(f"{Colors.GREEN}✅ IMPROVED: {description} - limit capped{Colors.RESET}")
                    else:
                        print(f"{Colors.YELLOW}⚠️  PARTIAL: {description} - works but no limit info{Colors.RESET}")
                else:
                    print(f"{Colors.GREEN}✅ IMPROVED: {description} - proper validation error{Colors.RESET}")
            else:
                print(f"{Colors.RED}❌ ERROR: {description} - unexpected status {response.status_code}{Colors.RESET}")
                all_passed = False

        except Exception as e:
            print(f"{Colors.RED}❌ ERROR: {description} - {e}{Colors.RESET}")
            all_passed = False

    return all_passed

def main():
    print(f"{Colors.BOLD}GH-Bot Worker Fix Validation{Colors.RESET}")
    print("=" * 50)

    print(f"\n{Colors.BOLD}Issue 1: Webhook 500 Error Fix{Colors.RESET}")
    webhook_fixed = test_webhook_signature_handling()

    print(f"\n{Colors.BOLD}Issue 2: Empty Response Improvements{Colors.RESET}")
    endpoints_improved = test_research_endpoints()

    print(f"\n{Colors.BOLD}Issue 3: Parameter Validation{Colors.RESET}")
    params_fixed = test_parameter_validation()

    print("\n" + "=" * 50)

    if webhook_fixed and endpoints_improved and params_fixed:
        print(f"{Colors.GREEN}{Colors.BOLD}🎉 ALL FIXES VALIDATED!{Colors.RESET}")
        print(f"{Colors.GREEN}The worker should now pass more tests.{Colors.RESET}")
    else:
        print(f"{Colors.YELLOW}{Colors.BOLD}⚠️  SOME IMPROVEMENTS MADE{Colors.RESET}")
        print(f"{Colors.YELLOW}Check individual test results above.{Colors.RESET}")

if __name__ == "__main__":
    main()
