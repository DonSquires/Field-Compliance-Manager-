"""RunPod Serverless worker for bounded Bob browser QA.

This endpoint is intentionally separate from inference. It accepts a signed
source archive and signed artifact upload URL, runs only allowlisted Playwright
profiles, and never accepts credentials in the job payload.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request
from pathlib import Path
from typing import Any

import runpod

ALLOWED_PROFILES = {
    "ci-smoke": [
        "e2e/admin-hub-dispatch.spec.ts",
        "e2e/dr-bob-automation-geofence-module.spec.ts",
        "e2e/geofence-spine-map.spec.ts",
        "e2e/officer-module-entitlements.spec.ts",
    ],
    "human": ["e2e/dr-bob-human-test.spec.ts"],
    "automation": ["e2e/dr-bob-automation-geofence-module.spec.ts"],
}
MAX_ARCHIVE_BYTES = 500 * 1024 * 1024
MAX_TIMEOUT_SECONDS = 45 * 60


def fail(message: str) -> dict[str, Any]:
    return {"status": "failed", "error": message}


def download(url: str, destination: Path) -> int:
    request = urllib.request.Request(url, headers={"User-Agent": "FCM-Bob-RunPod-QA/1.0"})
    total = 0
    with urllib.request.urlopen(request, timeout=60) as response, destination.open("wb") as output:
        while chunk := response.read(1024 * 1024):
            total += len(chunk)
            if total > MAX_ARCHIVE_BYTES:
                raise ValueError("source archive exceeds bounded size")
            output.write(chunk)
    return total


def safe_extract(archive: Path, destination: Path) -> None:
    destination_resolved = destination.resolve()
    with tarfile.open(archive, "r:gz") as handle:
        for member in handle.getmembers():
            if member.issym() or member.islnk() or member.isdev():
                raise ValueError("source archive contains an unsupported link or device entry")
            target = (destination / member.name).resolve()
            if target != destination_resolved and destination_resolved not in target.parents:
                raise ValueError("source archive contains an unsafe path")
        handle.extractall(destination)


def source_root(destination: Path) -> Path:
    """Support GitHub archives with one repository directory at the root."""
    candidates = [item for item in destination.iterdir() if item.name != '__MACOSX']
    if len(candidates) == 1 and candidates[0].is_dir() and (candidates[0] / 'apps' / 'web').is_dir():
        return candidates[0]
    return destination


def upload_artifacts(archive: Path, upload_url: str) -> None:
    request = urllib.request.Request(
        upload_url,
        data=archive.read_bytes(),
        method="PUT",
        headers={"Content-Type": "application/gzip", "User-Agent": "FCM-Bob-RunPod-QA/1.0"},
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        if response.status >= 300:
            raise RuntimeError(f"artifact upload failed with HTTP {response.status}")


def run_profile(source: Path, profile: str, target_url: str | None, timeout: int, output: Path) -> subprocess.CompletedProcess[str]:
    if profile not in ALLOWED_PROFILES:
        raise ValueError("unsupported QA profile")
    print("[bob-qa] installing web dependencies", flush=True)
    install = subprocess.run(["npm", "ci", "--include=dev", "--ignore-scripts", "--no-audit", "--no-fund"], cwd=source / "apps/web", env={**os.environ, "CI": "true", "NODE_ENV": "development"}, text=True, capture_output=True, timeout=min(timeout, 600))
    if install.returncode != 0:
        print(f"[bob-qa] dependency install failed exit_code={install.returncode}", flush=True)
        return install
    playwright = source / "apps" / "web" / "node_modules" / ".bin" / "playwright"
    if not playwright.exists():
        print("[bob-qa] local Playwright binary missing after dependency install", flush=True)
        return subprocess.CompletedProcess([str(playwright)], 1, "", "local Playwright binary was not installed")
    print(f"[bob-qa] running Playwright profile={profile}", flush=True)
    command = [str(playwright), "test", *ALLOWED_PROFILES[profile], "--workers=1", "--reporter=line"]
    if profile == "human" and target_url:
        command = ["npx", "playwright", "test", ALLOWED_PROFILES[profile][0], "--workers=1", "--reporter=line"]
    environment = {
        **os.environ,
        "CI": "true",
        "PLAYWRIGHT_OUTPUT_DIR": str(output / "test-results"),
        "PLAYWRIGHT_HTML_OUTPUT_DIR": str(output / "playwright-report"),
    }
    if target_url:
        environment.update({"HUMAN_TEST_LIVE": "true", "HUMAN_TEST_BASE_URL": target_url})
    return subprocess.run(command, cwd=source / "apps/web", env=environment, text=True, capture_output=True, timeout=timeout)


def redact(value: str) -> str:
    text = value[-100_000:]
    text = re.sub(r"(?i)(authorization\s*[:=]\s*bearer\s+)[^\s,;]+", r"\1[REDACTED]", text)
    text = re.sub(r"(?i)(token|secret|password|api[_-]?key)\s*[:=]\s*[^\s,;]+", r"\1=[REDACTED]", text)
    return text


def handler(job: dict[str, Any]) -> dict[str, Any]:
    payload = job.get("input") or {}
    source_url = str(payload.get("source_archive_url") or "")
    artifact_url = str(payload.get("artifact_upload_url") or "")
    profile = str(payload.get("profile") or "ci-smoke")
    target_url = str(payload.get("target_url") or "") or None
    expected_sha = str(payload.get("expected_sha") or "")
    timeout = min(max(int(payload.get("timeout_seconds") or 900), 30), MAX_TIMEOUT_SECONDS)
    if not source_url or not artifact_url:
        return fail("source_archive_url and artifact_upload_url are required")
    if profile == "human" and not target_url:
        return fail("human profile requires an explicit target_url")
    try:
        print(f"[bob-qa] accepted profile={profile} expected_sha={expected_sha or 'none'}", flush=True)
        with tempfile.TemporaryDirectory(prefix="fcm-runpod-qa-") as temporary:
            root = Path(temporary)
            archive = root / "source.tar.gz"
            source = root / "source"
            output = root / "artifacts"
            source.mkdir()
            output.mkdir()
            source_bytes = download(source_url, archive)
            print(f"[bob-qa] source downloaded bytes={source_bytes}", flush=True)
            safe_extract(archive, source)
            result = run_profile(source_root(source), profile, target_url, timeout, output)
            manifest = {
                "status": "succeeded" if result.returncode == 0 else "failed",
                "profile": profile,
                "expected_sha": expected_sha,
                "target_url": target_url,
                "stdout": redact(result.stdout),
                "stderr": redact(result.stderr),
                "source_bytes": source_bytes,
            }
            (output / "runpod-qa-result.json").write_text(json.dumps(manifest, indent=2))
            bundle = root / "artifacts.tar.gz"
            with tarfile.open(bundle, "w:gz") as handle:
                handle.add(output, arcname="artifacts")
            print("[bob-qa] uploading artifacts", flush=True)
            upload_artifacts(bundle, artifact_url)
            print(f"[bob-qa] completed status={manifest['status']} exit_code={result.returncode}", flush=True)
            return {
                "status": manifest["status"],
                "profile": profile,
                "expected_sha": expected_sha,
                "target_url": target_url,
                "artifact_sha256": hashlib.sha256(bundle.read_bytes()).hexdigest(),
                "exit_code": result.returncode,
            }
    except subprocess.TimeoutExpired:
        return fail("QA worker timed out")
    except Exception as error:  # noqa: BLE001
        return fail(str(error))


runpod.serverless.start({"handler": handler})
