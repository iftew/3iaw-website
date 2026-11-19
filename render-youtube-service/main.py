import os
import re
import tempfile
import threading
import subprocess
from pathlib import Path
from urllib.parse import quote
from urllib.parse import urlencode

import httpx
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask

app = FastAPI(title="3iaw YouTube Audio Extractor", docs_url=None, redoc_url=None)
SERVICE_TOKEN = os.environ.get("YOUTUBE_SERVICE_TOKEN", "")
TUNELIO_API_KEY = os.environ.get("TUNELIO_API_KEY", "")
MAX_CONCURRENT = max(1, int(os.environ.get("MAX_CONCURRENT_DOWNLOADS", "2")))
MAX_SOURCE_BYTES = 200 * 1024 * 1024
MAX_OUTPUT_BYTES = 20 * 1024 * 1024
semaphore = threading.BoundedSemaphore(MAX_CONCURRENT)


class ExtractRequest(BaseModel):
    video_id: str = Field(pattern=r"^[A-Za-z0-9_-]{11}$")
    start: float = Field(default=0, ge=0, le=21600)
    max_duration: float = Field(default=400, gt=0, le=400)


@app.get("/health")
def health():
    return {"ok": True, "service": "3iaw-youtube-extractor", "provider": "tunelio"}


def _safe_filename(value: str, fallback: str) -> str:
    stem = Path(value or fallback).stem
    stem = re.sub(r"[^A-Za-z0-9._ -]+", " ", stem).strip(" .")
    return (stem or fallback)[:80]


def _raise_provider_error(response: httpx.Response):
    detail = "Tunelio could not create an audio download for this video."
    try:
        data = response.json()
        detail = str(data.get("detail") or data.get("error") or data.get("message") or data.get("status") or detail)
    except Exception:
        pass
    status = response.status_code
    if status in (401, 403):
        raise HTTPException(status_code=502, detail="Tunelio rejected the API key. Check TUNELIO_API_KEY in Render.")
    if status == 429:
        raise HTTPException(status_code=429, detail="Tunelio rate limit reached. Please try again later.")
    if status == 402:
        raise HTTPException(status_code=402, detail="Tunelio free credits may be exhausted. Check your Tunelio dashboard.")
    raise HTTPException(status_code=502, detail=f"Tunelio error ({status}): {detail[:240]}")


@app.post("/extract")
def extract_audio(payload: ExtractRequest, authorization: str | None = Header(default=None)):
    if not SERVICE_TOKEN or authorization != f"Bearer {SERVICE_TOKEN}":
        raise HTTPException(status_code=401, detail="Unauthorized")
    if not TUNELIO_API_KEY:
        raise HTTPException(status_code=503, detail="Tunelio is not configured. Add TUNELIO_API_KEY to Render.")
    if not semaphore.acquire(blocking=False):
        raise HTTPException(status_code=429, detail="The audio service is busy. Please try again in a minute.")

    temp_dir = tempfile.TemporaryDirectory(prefix="3iaw-tunelio-")
    folder = Path(temp_dir.name)
    source = folder / "source.mp3"
    output = folder / "output.mp3"
    video_url = f"https://www.youtube.com/watch?v={payload.video_id}"

    try:
        timeout = httpx.Timeout(connect=15, read=90, write=30, pool=15)
        with httpx.Client(timeout=timeout, follow_redirects=True) as client:
            # Tunelio returns a signed stream URL synchronously; no polling is required.
            response = client.get(
                "https://tunelio.dev/create",
                params={"url": video_url, "quality": "mp3"},
                headers={"Authorization": f"Bearer {TUNELIO_API_KEY}"},
            )
            if response.status_code >= 400:
                _raise_provider_error(response)
            try:
                data = response.json()
            except Exception as exc:
                raise HTTPException(status_code=502, detail="Tunelio returned an unreadable response.") from exc

            download_url = data.get("url")
            if data.get("status") not in (None, "ok") or not isinstance(download_url, str):
                message = str(data.get("status") or "Tunelio did not return a download URL.")
                raise HTTPException(status_code=502, detail=message[:240])
            if not download_url.startswith("https://"):
                raise HTTPException(status_code=502, detail="Tunelio returned an invalid download URL.")

            # Stream the MP3 to temporary storage, with a hard safety limit.
            total = 0
            with client.stream("GET", download_url) as media_response:
                if media_response.status_code >= 400:
                    raise HTTPException(status_code=502, detail="The Tunelio download link could not be opened. Please retry.")
                with source.open("wb") as file:
                    for chunk in media_response.iter_bytes(chunk_size=1024 * 256):
                        if not chunk:
                            continue
                        total += len(chunk)
                        if total > MAX_SOURCE_BYTES:
                            raise HTTPException(status_code=413, detail="The source audio is too large to process on this service.")
                        file.write(chunk)

        if not source.exists() or source.stat().st_size == 0:
            raise HTTPException(status_code=502, detail="Tunelio returned an empty audio file.")

        # Keep the existing trim contract expected by the Cloudflare Worker/frontend.
        command = [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-ss", str(payload.start), "-i", str(source),
            "-t", str(payload.max_duration), "-vn",
            "-codec:a", "libmp3lame", "-b:a", "192k", str(output),
        ]
        result = subprocess.run(command, capture_output=True, text=True, timeout=180)
        if result.returncode != 0 or not output.exists() or output.stat().st_size == 0:
            raise HTTPException(status_code=422, detail="The requested trim section could not be created. Check the start time and try again.")
        if output.stat().st_size > MAX_OUTPUT_BYTES:
            raise HTTPException(status_code=413, detail="The MP3 is larger than 20 MB. Choose a shorter section.")

        title = str(data.get("filename") or f"youtube-{payload.video_id}.mp3")[:150]
        safe_title = _safe_filename(title, f"youtube-{payload.video_id}")
        encoded_title = quote(Path(title).stem or safe_title, safe="")

        def cleanup():
            temp_dir.cleanup()
            semaphore.release()

        return FileResponse(
            path=output,
            media_type="audio/mpeg",
            filename=f"{safe_title}.mp3",
            headers={"X-Title": encoded_title, "Cache-Control": "no-store"},
            background=BackgroundTask(cleanup),
        )
    except HTTPException:
        temp_dir.cleanup()
        semaphore.release()
        raise
    except httpx.TimeoutException as exc:
        temp_dir.cleanup()
        semaphore.release()
        raise HTTPException(status_code=504, detail="Tunelio took too long to respond. Please try again.") from exc
    except Exception as exc:
        temp_dir.cleanup()
        semaphore.release()
        raise HTTPException(status_code=502, detail="The audio service could not process this video. Please try again.") from exc
