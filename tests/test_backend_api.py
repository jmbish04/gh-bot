import os
import unittest
import requests

BASE_URL = os.environ.get("WORKER_URL", "http://localhost:8787").rstrip("/")
HEADERS = {
    "Accept": "application/json",
}


def _check_cors_headers(case: unittest.TestCase, response: requests.Response):
    case.assertEqual(response.headers.get("Access-Control-Allow-Origin"), "*")
    case.assertEqual(response.headers.get("Access-Control-Allow-Methods"), "GET, POST, PUT, DELETE, OPTIONS")
    case.assertEqual(response.headers.get("Access-Control-Allow-Headers"), "Content-Type, Authorization")
    case.assertEqual(response.headers.get("Content-Type", "").split(";")[0], "application/json")


class BackendAPITests(unittest.TestCase):
    def get(self, path: str) -> requests.Response:
        resp = requests.get(f"{BASE_URL}{path}", headers=HEADERS, timeout=10)
        _check_cors_headers(self, resp)
        return resp

    def test_stats(self):
        resp = self.get("/api/stats")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(
            resp.json(),
            {
                "projects": 8,
                "commands": 117,
                "practices": 12,
                "analyses": 4,
                "operations": 3,
                "repositories": 8,
            },
        )

    def test_research_status(self):
        resp = self.get("/api/research/status")
        self.assertIn(resp.status_code, (200, 500))
        data = resp.json()
        self.assertIn(data["status"], ["idle", "running", "completed", "error"])
        self.assertIn("progress", data)
        self.assertIn("current_operation", data)

    def test_operations(self):
        resp = self.get("/api/operations")
        self.assertEqual(resp.status_code, 200)
        self.assertIn("operations", resp.json())

    def test_recent_activity(self):
        resp = self.get("/api/recent-activity")
        self.assertEqual(resp.status_code, 200)
        self.assertIn("activity", resp.json())

    def test_health(self):
        resp = self.get("/api/health")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json().get("status"), "healthy")


if __name__ == "__main__":
    unittest.main()
