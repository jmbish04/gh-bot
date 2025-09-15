#!/usr/bin/env python3
"""
Test the specific endpoint fixes
"""

import requests
import json

def test_analysis_endpoint():
    """Test the /research/analysis endpoint fixes"""

    base_url = "https://gh-bot.hacolby.workers.dev"

    print("Testing Analysis Endpoint Fixes")
    print("=" * 40)

    # Test 1: Valid repo that doesn't exist in DB (should return 200 now)
    print("\n1. Testing valid repo (cloudflare/workers-sdk):")
    try:
        response = requests.get(f"{base_url}/research/analysis?repo=cloudflare/workers-sdk", timeout=10)
        print(f"   Status: {response.status_code}")
        if response.status_code == 200:
            data = response.json()
            print(f"   Message: {data.get('message', '')}")
            print("   ✅ FIXED: Now returns 200 instead of 404")
        else:
            print(f"   ❌ Still returning {response.status_code}")
    except Exception as e:
        print(f"   ❌ Error: {e}")

    # Test 2: SQL injection attempt (should return 400)
    print("\n2. Testing SQL injection protection:")
    try:
        response = requests.get(f"{base_url}/research/analysis?repo='; DROP TABLE projects; --", timeout=10)
        print(f"   Status: {response.status_code}")
        if response.status_code == 400:
            data = response.json()
            print(f"   Message: {data.get('message', '')}")
            print("   ✅ FIXED: SQL injection properly blocked with 400")
        else:
            print(f"   ❌ Unexpected status: {response.status_code}")
            try:
                print(f"   Response: {response.json()}")
            except:
                print(f"   Response: {response.text}")
    except Exception as e:
        print(f"   ❌ Error: {e}")

    # Test 3: Invalid format (should return 400)
    print("\n3. Testing invalid repo format:")
    try:
        response = requests.get(f"{base_url}/research/analysis?repo=invalid-format", timeout=10)
        print(f"   Status: {response.status_code}")
        if response.status_code == 400:
            data = response.json()
            print(f"   Message: {data.get('message', '')}")
            print("   ✅ GOOD: Invalid format properly rejected")
        else:
            print(f"   ❌ Unexpected status: {response.status_code}")
    except Exception as e:
        print(f"   ❌ Error: {e}")

    # Test 4: Missing repo parameter (should return 400)
    print("\n4. Testing missing repo parameter:")
    try:
        response = requests.get(f"{base_url}/research/analysis", timeout=10)
        print(f"   Status: {response.status_code}")
        if response.status_code == 400:
            data = response.json()
            print(f"   Message: {data.get('error', '')}")
            print("   ✅ GOOD: Missing parameter properly handled")
        else:
            print(f"   ❌ Unexpected status: {response.status_code}")
    except Exception as e:
        print(f"   ❌ Error: {e}")

if __name__ == "__main__":
    test_analysis_endpoint()
