import os
import uuid

import pytest
from botocore.exceptions import BotoCoreError, ClientError

from app.config import Settings
from app.storage import ensure_bucket, s3_client


def storage_settings() -> Settings:
    return Settings(s3_endpoint_url=os.environ.get("S3_TEST_ENDPOINT", "http://localhost:9000"))


def storage_up() -> bool:
    try:
        s3_client(storage_settings(), timeout_s=1).list_buckets()
        return True
    except (BotoCoreError, ClientError):
        return False


def test_client_uses_path_style_addressing():
    client = s3_client(Settings())
    assert client.meta.config.s3["addressing_style"] == "path"


@pytest.mark.skipif(not storage_up(), reason="object storage not running (docker compose up -d storage)")
def test_round_trip_against_running_storage():
    settings = storage_settings()
    assert ensure_bucket(settings)
    assert ensure_bucket(settings)  # idempotent
    client = s3_client(settings)
    key = f"tests/{uuid.uuid4()}.txt"
    client.put_object(Bucket=settings.s3_bucket, Key=key, Body=b"gate code 4921", ContentType="text/plain")
    try:
        assert client.get_object(Bucket=settings.s3_bucket, Key=key)["Body"].read() == b"gate code 4921"
    finally:
        client.delete_object(Bucket=settings.s3_bucket, Key=key)
