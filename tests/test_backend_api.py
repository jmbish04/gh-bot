import os
import unittest
import requests

BASE_URL = os.environ.get("WORKER_URL", "http://localhost:8787").rstrip("/")
HEADERS = {
    "Accept": "application/json",
}


def _check_cors_headers(response: requests.Response):
    assert response.headers.get("Access-Control-Allow-Origin") == "*"
    assert response.headers.get("Access-Control-Allow-Methods") == "GET, POST, PUT, DELETE, OPTIONS"
    assert response.headers.get("Access-Control-Allow-Headers") == "Content-Type, Authorization"
    assert response.headers.get("Content-Type", "").split(";")[0] == "application/json"


class BackendAPITests(unittest.TestCase):
    def get(self, path: str) -> requests.Response:
        resp = requests.get(f"{BASE_URL}{path}", headers=HEADERS, timeout=10)
        _check_cors_headers(resp)
        return resp

    def test_stats(self):
        resp = self.get("/api/stats")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        for key in ["projects", "commands", "practices", "analyses", "operations", "repositories"]:
            self.assertIn(key, data)

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
