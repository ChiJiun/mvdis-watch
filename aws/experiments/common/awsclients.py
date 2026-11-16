"""boto3 client 工廠（延遲 import；乾跑不需要 boto3）。

讀 AWS_REGION（預設 us-east-1，Learner Lab）與 AWS_ENDPOINT_URL（本機 LocalStack）。
憑證走 boto3 預設鏈：Learner Lab 的 ~/.aws/credentials，或 bastion 上的 LabInstanceProfile。
"""
from __future__ import annotations

import os
from typing import Any


def client(name: str) -> Any:
    import boto3  # noqa: WPS433

    kwargs = {"region_name": os.environ.get("AWS_REGION", "us-east-1")}
    endpoint = os.environ.get("AWS_ENDPOINT_URL")
    if endpoint:
        kwargs["endpoint_url"] = endpoint
    return boto3.client(name, **kwargs)
