#!/usr/bin/env python3
"""
Quick runner for the comprehensive test suite
"""

import sys
import os

# Add tests directory to path
sys.path.append(os.path.join(os.path.dirname(__file__), 'tests'))

from test_worker import main

if __name__ == "__main__":
    print("🚀 Running comprehensive gh-bot worker test suite...")
    main()
