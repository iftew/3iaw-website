import os
import re
import tempfile
import threading
from pathlib import Path
from urllib.parse import quote

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask
from yt_dlp import YoutubeDL
from yt_dlp.utils import download_range_func

app = FastAPI(title="3iaw YouTube Audio Extractor", docs_url=None, redoc_url=None)
TOKEN = os.environ.get("YOUTUBE_SERVICE_TOKEN", "")
MAX_CONCURRENT = max(1, int(os.environ.get("MAX_CONCURRENT_DOWNLOADS", "2")))
semaphore = threading.BoundedSemaphore(MAX_CONCURRENT)

class ExtractRequest(BaseModel):
    video_id: str = Field(pattern=r"^[A-Za-z0-9_-]{11}$")
    start: float = Field(default=0, ge=0, le=21600)
    max_duration: float = Field(default=400, gt=0, le=400)

@app.get("/health")
def health():
    return {"ok": True, "service": "3iaw-youtube-extractor"}

@app.post("/extract")
def extract_audio(payload: ExtractRequest, authorization: str | None = Header(default=None)):
    if not TOKEN or authorization != f"Bearer {TOKEN}":
        raise HTTPException(status_code=401, detail="Unauthorized")
    if not semaphore.acquire(blocking=False):
        raise HTTPException(status_code=429, detail="The audio service is busy. Please try again in a minute.")

    temp_dir = tempfile.TemporaryDirectory(prefix="3iaw-yt-")
    folder = Path(temp_dir.name)
    url = f"https://www.youtube.com/watch?v={payload.video_id}"
    try:
        # First read metadata only, then download just the requested section.
        metadata_options = {
            "quiet": True,
            "no_warnings": True,
            "noplaylist": True,
            "skip_download": True,
            "socket_timeout": 25,
            "extractor_retries": 2,
            "retries": 2,
        }
        with YoutubeDL(metadata_options) as ydl:
            info = ydl.extract_info(url, download=False)

        duration = info.get("duration")
        if not duration:
            raise HTTPException(status_code=422, detail="This video has no available duration information.")
        if payload.start >= duration:
            raise HTTPException(status_code=400, detail="The trim start is beyond the end of this video.")
        end = min(float(duration), payload.start + payload.max_duration)
        if end - payload.start < 1:
            raise HTTPException(status_code=400, detail="The selected audio section is too short.")

        options = {
            "format": "bestaudio/best",
            "outtmpl": str(folder / "source.%(ext)s"),
            "noplaylist": True,
            "quiet": True,
            "no_warnings": True,
            "socket_timeout": 30,
            "retries": 2,
            "fragment_retries": 2,
            "extractor_retries": 2,
            "download_ranges": download_range_func(None, [(payload.start, end)]),
            "force_keyframes_at_cuts": True,
            "postprocessors": [{
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": "192",
            }],
            "postprocessor_args": {"ffmpeg": ["-vn"]},
            "overwrites": True,
        }
        with YoutubeDL(options) as ydl:
            ydl.download([url])

        mp3_files = list(folder.glob("*.mp3"))
        if not mp3_files:
            raise HTTPException(status_code=502, detail="The audio was downloaded but MP3 conversion did not complete.")
        output = mp3_files[0]
        if output.stat().st_size <= 0:
            raise HTTPException(status_code=502, detail="The extracted MP3 file was empty.")
        if output.stat().st_size > 20 * 1024 * 1024:
            raise HTTPException(status_code=413, detail="The MP3 is larger than 20 MB. Choose a shorter section.")

        title = str(info.get("title") or f"youtube-{payload.video_id}")[:150]
        safe_title = re.sub(r"[^A-Za-z0-9._ -]+", " ", title).strip() or f"youtube-{payload.video_id}"
        encoded_title = quote(title, safe="")

        def cleanup():
            temp_dir.cleanup()
            semaphore.release()

        return FileResponse(
            path=output,
            media_type="audio/mpeg",
            filename=f"{safe_title[:80]}.mp3",
            headers={"X-Title": encoded_title, "Cache-Control": "no-store"},
            background=BackgroundTask(cleanup),
        )
    except HTTPException:
        temp_dir.cleanup()
        semaphore.release()
        raise
    except Exception as exc:
        temp_dir.cleanup()
        semaphore.release()
        message = str(exc)
        if "private video" in message.lower() or "sign in" in message.lower():
            message = "This video is private or requires sign-in, so it cannot be processed."
        elif "copyright" in message.lower() or "not available" in message.lower():
            message = "This video is unavailable for audio extraction."
        else:
            message = "YouTube could not provide this audio right now. Try again later or use another video."
        raise HTTPException(status_code=502, detail=message) from exc
