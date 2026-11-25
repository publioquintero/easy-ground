from fastapi.testclient import TestClient

from app.main import app


def test_health_reports_each_service():
    res = TestClient(app).get("/api/health")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok"
    assert set(body["services"]) == {"postgres", "redis", "storage"}
    assert all(v in {"up", "down"} for v in body["services"].values())
