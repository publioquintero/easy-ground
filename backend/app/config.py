from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=Path(__file__).resolve().parent.parent / ".env", extra="ignore")

    database_url: str = "postgresql://easyground:easyground@localhost:5432/easyground"
    redis_url: str = "redis://localhost:6379/0"
    s3_endpoint_url: str = "http://localhost:9000"
    s3_access_key: str = "easyground"
    s3_secret_key: str = "easyground-dev-secret"
    s3_bucket: str = "easy-ground"
    google_maps_api_key: str = ""
    # "auto": Google when a key is set, otherwise the free US Census geocoder.
    geocoder: str = "auto"


@lru_cache
def get_settings() -> Settings:
    return Settings()
