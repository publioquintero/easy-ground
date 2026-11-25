"""S3-compatible object storage (RustFS locally; any S3 in production) via boto3."""

import logging

import boto3
from botocore.client import BaseClient
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

from app.config import Settings

log = logging.getLogger(__name__)


def s3_client(settings: Settings, timeout_s: float = 5) -> BaseClient:
    return boto3.client(
        "s3",
        endpoint_url=settings.s3_endpoint_url,
        aws_access_key_id=settings.s3_access_key,
        aws_secret_access_key=settings.s3_secret_key,
        region_name="us-east-1",
        config=Config(
            # RustFS (like MinIO) serves buckets as /bucket/key unless it is given a domain.
            s3={"addressing_style": "path"},
            connect_timeout=timeout_s,
            read_timeout=timeout_s,
            retries={"max_attempts": 1},
        ),
    )


def ensure_bucket(settings: Settings) -> bool:
    """Create the app bucket if missing. Storage is optional at startup: log and go on."""
    client = s3_client(settings, timeout_s=2)
    try:
        client.head_bucket(Bucket=settings.s3_bucket)
        return True
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") not in ("404", "NoSuchBucket", "NotFound"):
            log.warning("storage bucket check failed: %s", error)
            return False
    except BotoCoreError as error:
        log.warning("storage unreachable: %s", error)
        return False
    try:
        client.create_bucket(Bucket=settings.s3_bucket)
        log.info("created storage bucket %s", settings.s3_bucket)
        return True
    except (BotoCoreError, ClientError) as error:
        log.warning("could not create storage bucket: %s", error)
        return False
