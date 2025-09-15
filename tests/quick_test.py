#!/usr/bin/env python3
"""
Quick test script for gh-bot Worker
Focuses on the most important endpoints
"""

import requests
import json
import time
from datetime import datetime


def test_worker(base_url='https://gh-bot.hacolby.workers.dev'):
    """Quick test of worker endpoints"""
    
    print("=" * 50)
    print(f"Testing GH-Bot Worker: {base_url}")
    print(f"Time: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 50)
    
    tests_passed = 0
    tests_failed = 0
    
    # Test cases
    test_cases = [
        {
            'name': 'Health Check',
            'method': 'GET',
            'path': '/health',
            'expected_status': [200],
            'check_json': True,
            'expected_keys': ['ok']
        },
        {
            'name': 'Research Status',
            'method': 'GET',
            'path': '/research/status',
            'expected_status': [200, 503],
            'check_json': True
        },
        {
            'name': 'Research Results',
            'method': 'GET',
            'path': '/research/results?limit=5',
            'expected_status': [200],
            'check_json': True
        },
        {
            'name': 'Research Risks',
            'method': 'GET',
            'path': '/research/risks',
            'expected_status': [200],
            'check_json': True
        },
        {
            'name': 'Structured Analysis',
            'method': 'GET',
            'path': '/research/structured?min_conf=0.5',
            'expected_status': [200],
            'check_json': True
        },
        {
            'name': 'Specific Repo Analysis',
            'method': 'GET',
            'path': '/research/analysis?repo=cloudflare/workers-sdk',
            'expected_status': [200],
            'check_json': True
        },
        {
            'name': 'Invalid Endpoint (404 test)',
            'method': 'GET',
            'path': '/invalid-endpoint',
            'expected_status': [404],
            'check_json': False
        },
        {
            'name': 'Missing Repo Parameter',
            'method': 'GET',
            'path': '/research/analysis',
            'expected_status': [400],
            'check_json': False
        },
        {
            'name': 'Manual Analysis (POST)',
            'method': 'POST',
            'path': '/research/analyze',
            'data': {
                'owner': 'cloudflare',
                'repo': 'miniflare',
                'force': False
            },
            'expected_status': [200, 400, 404, 500],
            'check_json': True
        }
    ]
    
    # Run tests
    for test in test_cases:
        url = f"{base_url.rstrip('/')}{test['path']}"
        print(f"\nTesting: {test['name']}")
        print(f"  URL: {test['method']} {url}")
        
        try:
            start_time = time.time()
            
            if test['method'] == 'GET':
                response = requests.get(url, timeout=30)
            elif test['method'] == 'POST':
                response = requests.post(
                    url,
                    json=test.get('data'),
                    timeout=30
                )
            else:
                print(f"  ❌ Unsupported method: {test['method']}")
                tests_failed += 1
                continue
            
            elapsed = time.time() - start_time
            
            # Check status code
            if response.status_code in test['expected_status']:
                print(f"  ✅ Status: {response.status_code} (expected: {test['expected_status']})")
                status_ok = True
            else:
                print(f"  ❌ Status: {response.status_code} (expected: {test['expected_status']})")
                status_ok = False
            
            print(f"  ⏱️  Response time: {elapsed:.2f}s")
            
            # Check JSON response if required
            if test.get('check_json', False):
                try:
                    data = response.json()
                    print(f"  ✅ Valid JSON response")
                    
                    # Check for expected keys
                    if 'expected_keys' in test:
                        missing_keys = [k for k in test['expected_keys'] if k not in data]
                        if missing_keys:
                            print(f"  ❌ Missing keys: {missing_keys}")
                            status_ok = False
                        else:
                            print(f"  ✅ All expected keys present")
                    
                    # Show sample data for successful responses
                    if response.status_code == 200:
                        if isinstance(data, list):
                            print(f"  📊 Response: List with {len(data)} items")
                            if data and len(data) > 0:
                                print(f"  📊 First item keys: {list(data[0].keys()) if isinstance(data[0], dict) else 'N/A'}")
                        elif isinstance(data, dict):
                            print(f"  📊 Response keys: {list(data.keys())}")
                        else:
                            print(f"  📊 Response type: {type(data).__name__}")
                    
                except json.JSONDecodeError:
                    print(f"  ❌ Invalid JSON response")
                    if test.get('check_json', False):
                        status_ok = False
            
            # Update counters
            if status_ok:
                tests_passed += 1
                print(f"  ✅ Test PASSED")
            else:
                tests_failed += 1
                print(f"  ❌ Test FAILED")
                
        except requests.exceptions.Timeout:
            print(f"  ❌ Request timeout (30s)")
            tests_failed += 1
        except requests.exceptions.ConnectionError as e:
            print(f"  ❌ Connection error: {e}")
            tests_failed += 1
        except Exception as e:
            print(f"  ❌ Unexpected error: {e}")
            tests_failed += 1
    
    # Summary
    print("\n" + "=" * 50)
    print("TEST SUMMARY")
    print("=" * 50)
    print(f"Total tests: {tests_passed + tests_failed}")
    print(f"✅ Passed: {tests_passed}")
    print(f"❌ Failed: {tests_failed}")
    
    if tests_failed == 0:
        print("\n🎉 All tests passed successfully!")
    else:
        print(f"\n⚠️  {tests_failed} test(s) failed")
    
    success_rate = (tests_passed / (tests_passed + tests_failed)) * 100 if (tests_passed + tests_failed) > 0 else 0
    print(f"\nSuccess rate: {success_rate:.1f}%")
    
    return tests_passed, tests_failed


if __name__ == '__main__':
    import sys
    
    # Check for custom URL
    url = sys.argv[1] if len(sys.argv) > 1 else 'https://gh-bot.hacolby.workers.dev'
    
    passed, failed = test_worker(url)
    
    # Exit with non-zero code if tests failed
    sys.exit(0 if failed == 0 else 1)
