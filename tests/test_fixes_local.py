#!/usr/bin/env python3
"""
Quick test script to validate our parameter validation fixes
"""

import requests
import json

def test_endpoint(url, expected_status=200, description=""):
    """Test an endpoint and return the result"""
    try:
        print(f"\n🧪 Testing: {description}")
        print(f"URL: {url}")

        response = requests.get(url, timeout=10)
        print(f"Status: {response.status_code}")

        if response.status_code == expected_status:
            print("✅ PASS")
        else:
            print("❌ FAIL")

        # Try to parse as JSON
        try:
            data = response.json()
            print(f"Response: {json.dumps(data, indent=2)[:200]}...")
        except:
            print(f"Response (text): {response.text[:200]}...")

        return response.status_code == expected_status

    except Exception as e:
        print(f"❌ ERROR: {e}")
        return False

def main():
    base_url = "https://gh-bot.hacolby.workers.dev"

    print("🎯 Testing Parameter Validation Fixes")
    print("=====================================")

    tests = [
        # Health check
        (f"{base_url}/health", 200, "Health check"),

        # Parameter validation tests - should return 400, not 500
        (f"{base_url}/colby/commands?limit=wat", 400, "Invalid limit parameter"),
        (f"{base_url}/colby/commands?offset=-1", 400, "Negative offset parameter"),
        (f"{base_url}/colby/best-practices?limit=abc", 400, "Invalid best-practices limit"),
        (f"{base_url}/colby/best-practices?offset=-5", 400, "Negative best-practices offset"),

        # Valid parameter tests - should work
        (f"{base_url}/colby/commands?limit=5", 200, "Valid limit parameter"),
        (f"{base_url}/colby/best-practices?limit=3", 200, "Valid best-practices limit"),
    ]

    passed = 0
    total = len(tests)

    for url, expected_status, description in tests:
        if test_endpoint(url, expected_status, description):
            passed += 1

    print(f"\n📊 Results: {passed}/{total} tests passed")

    if passed == total:
        print("🎉 All tests passed!")
    else:
        print("⚠️  Some tests failed - check the output above")

    return passed == total

if __name__ == "__main__":
    main()
