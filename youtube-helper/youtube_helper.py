"""YouTube helper for 3iaw.com's Audio Converter. It runs on the owner's PC.

Why it exists: YouTube refuses requests that come from cloud servers (Cloudflare, Render, ...) but answers a
normal home connection. So the site's Worker asks this PC for the audio of a YouTube link:

    visitor -> 3iaw.com/api/youtube (Worker) -> https://yt.3iaw.com (Cloudflare Tunnel) -> this program -> YouTube

    GET /audio/<video id>   with "Authorization: Bearer <token>"   ->  the video's audio, title in X-Title
    GET /health                                                    ->  {"ok": true}

When the PC is off the tunnel is down, and the Worker tells visitors to upload a file instead.

setup.py installs this: it copies this file to the folder "3iaw-youtube" in the user's own folder
(C:\\Users\\<name>\\3iaw-youtube) and starts it there. The token, the settings, the log and the short-lived
download cache all live in that folder, never in the website's repo. It is deliberately not under AppData:
programs started from some packaged apps get their AppData writes redirected to a private copy.
This program also keeps the tunnel (cloudflared) running next to it, and stops it when it stops.
"""

import atexit
import hmac
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from logging.handlers import RotatingFileHandler
from pathlib import Path
from urllib.parse import quote

# THREEIAW_YT_DIR is only for trying this out in another folder
APP_DIR = Path(os.environ.get('THREEIAW_YT_DIR') or Path.home() / '3iaw-youtube')
CACHE = APP_DIR / 'cache'
MAX_SECONDS = 45 * 60            # longest video it will fetch
MAX_BYTES = 40 * 1024 * 1024     # the Worker's limit too (YT_MAX_BYTES in worker/index.js)
KEEP_SECONDS = 30 * 60           # a fetched video is kept this long, so a retry or a second visitor is instant
MAX_AT_ONCE = 2                  # downloads from YouTube running at the same time
NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)

APP_DIR.mkdir(parents=True, exist_ok=True)
CACHE.mkdir(exist_ok=True)
log = logging.getLogger('helper')
log.setLevel(logging.INFO)
_handler = RotatingFileHandler(APP_DIR / 'helper.log', maxBytes=512 * 1024, backupCount=1, encoding='utf-8')
_handler.setFormatter(logging.Formatter('%(asctime)s %(levelname)s %(message)s'))
log.addHandler(_handler)

CONFIG = json.loads((APP_DIR / 'config.json').read_text('utf-8'))
TOKEN = str(CONFIG['token'])
PORT = int(CONFIG.get('port', 8791))


def update_ytdlp():
    """YouTube changes often and yt-dlp follows with new versions, so take the newest one once a day.
    Only inside the helper's own Python (the venv setup.py makes), never the PC's main Python."""
    if sys.prefix == sys.base_prefix:
        return
    stamp = APP_DIR / 'last-update'
    try:
        if stamp.exists() and time.time() - stamp.stat().st_mtime < 86400:
            return
        python = Path(sys.executable).with_name('python.exe')
        done = subprocess.run(
            [str(python), '-m', 'pip', 'install', '--upgrade', '--quiet', '--disable-pip-version-check', 'yt-dlp[default]'],
            capture_output=True, text=True, timeout=240, creationflags=NO_WINDOW)
        stamp.write_text(time.strftime('%Y-%m-%d %H:%M:%S'), 'utf-8')
        log.info('yt-dlp update check: %s', 'ok' if done.returncode == 0 else (done.stderr or '').strip()[-300:])
    except Exception as e:  # no internet yet, pip busy, ...: carry on with the installed version
        log.warning('yt-dlp update skipped: %s', e)


update_ytdlp()
import yt_dlp  # noqa: E402  (imported after the update so the new version is the one loaded)

try:
    import imageio_ffmpeg
    FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
except Exception:
    FFMPEG = shutil.which('ffmpeg')


class Refuse(Exception):
    """A request this helper turns down, with the message the visitor sees."""
    def __init__(self, status, message):
        super().__init__(message)
        self.status, self.message = status, message


class YtLog:
    """yt-dlp's messages go to the log file (there is no console when this runs in the background)."""
    def debug(self, msg):
        pass

    def info(self, msg):
        pass

    def warning(self, msg):
        log.warning('yt-dlp: %s', msg)

    def error(self, msg):
        log.error('yt-dlp: %s', msg)


def ydl_options():
    options = {
        # m4a is the track as YouTube published it (AAC); webm/opus only when a video has no m4a
        'format': 'bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]/bestaudio[ext=webm]/bestaudio',
        'outtmpl': {'default': str(CACHE / '%(id)s.%(ext)s')},
        'noplaylist': True, 'quiet': True, 'no_warnings': True, 'noprogress': True, 'logger': YtLog(),
        'socket_timeout': 20, 'retries': 2, 'fragment_retries': 2, 'extractor_retries': 1,
        'max_filesize': MAX_BYTES, 'overwrites': True,
        'cachedir': str(APP_DIR / 'yt-dlp-cache'),
        # YouTube's player needs a JavaScript runtime for some videos; Node is used when it is installed
        'js_runtimes': {'deno': {}, 'node': {}},
    }
    if FFMPEG:
        options['ffmpeg_location'] = FFMPEG  # lets yt-dlp repair the m4a container so every browser can read it
    return options


def explain(error):
    """yt-dlp's error text -> (status, message for the visitor)."""
    text = str(error).lower()
    if 'private video' in text:
        return 404, 'That video is private.'
    if 'confirm your age' in text or 'age-restricted' in text or 'age restricted' in text:
        return 403, 'That video is age-restricted, so it cannot be fetched.'
    if 'members-only' in text or 'join this channel' in text:
        return 403, 'That video is for channel members only.'
    if 'not a bot' in text:
        return 503, 'YouTube is refusing requests right now. Try again later, or upload the audio file instead.'
    if 'live event' in text or 'premieres in' in text or 'is live' in text:
        return 422, 'Live videos and premieres cannot be fetched. Try again after it has finished.'
    if 'unavailable' in text or 'not available' in text or 'removed' in text or 'does not exist' in text:
        return 404, 'That video does not exist, is private, or was deleted.'
    return 502, 'YouTube could not provide that audio right now. Try again, or upload the audio file instead.'


def clean_cache():
    now = time.time()
    for f in CACHE.iterdir():
        try:
            if now - f.stat().st_mtime > KEEP_SECONDS:
                f.unlink()
        except OSError:
            pass


def cached(video_id):
    """(path, title) of a video fetched in the last KEEP_SECONDS, or None."""
    note = CACHE / (video_id + '.json')
    try:
        meta = json.loads(note.read_text('utf-8'))
        path = CACHE / meta['file']
        if time.time() - path.stat().st_mtime <= KEEP_SECONDS and path.stat().st_size > 0:
            return path, meta.get('title') or ''
    except (OSError, ValueError, KeyError):
        pass
    return None


def fetch(video_id):
    """Download the audio of one video into the cache -> (path, title). Raises Refuse."""
    url = 'https://www.youtube.com/watch?v=' + video_id
    try:
        with yt_dlp.YoutubeDL(ydl_options()) as ydl:
            info = ydl.extract_info(url, download=False)
            if info.get('is_live') or info.get('live_status') in ('is_live', 'is_upcoming'):
                raise Refuse(422, 'Live videos and premieres cannot be fetched. Try again after it has finished.')
            minutes = (info.get('duration') or 0) / 60
            if minutes * 60 > MAX_SECONDS:
                raise Refuse(413, f'That video is {minutes:.0f} minutes long; YouTube links work up to {MAX_SECONDS // 60} minutes. '
                                  'Use a shorter video, or upload the audio file instead.')
            info = ydl.process_ie_result(info, download=True)
    except Refuse:
        raise
    except Exception as e:
        status, message = explain(e)
        log.error('%s failed (%s): %s', video_id, status, str(e)[:500])
        raise Refuse(status, message) from e

    files = [Path(d['filepath']) for d in info.get('requested_downloads') or [] if d.get('filepath')]
    files = [f for f in files if f.exists()] or [f for f in CACHE.glob(video_id + '.*') if f.suffix not in ('.json', '.part')]
    if not files or files[0].stat().st_size == 0:
        # yt-dlp skips a file over max_filesize without raising
        raise Refuse(413, f'That video\'s audio is over {MAX_BYTES // 1048576} MB. Use a shorter video, or upload the audio file instead.')
    path = files[0]
    if path.stat().st_size > MAX_BYTES:
        path.unlink(missing_ok=True)
        raise Refuse(413, f'That video\'s audio is over {MAX_BYTES // 1048576} MB. Use a shorter video, or upload the audio file instead.')
    title = str(info.get('title') or '')[:150]
    (CACHE / (video_id + '.json')).write_text(json.dumps({'file': path.name, 'title': title}), 'utf-8')
    log.info('%s fetched: %.1f MB, %s', video_id, path.stat().st_size / 1048576, path.suffix)
    return path, title


slots = threading.BoundedSemaphore(MAX_AT_ONCE)
id_locks, id_locks_guard = {}, threading.Lock()


def audio_for(video_id):
    """The cached file for a video, fetching it first when needed. Two requests for the same video share one download."""
    with id_locks_guard:
        lock = id_locks.setdefault(video_id, threading.Lock())
    with lock:
        hit = cached(video_id)
        if hit:
            return hit
        if not slots.acquire(blocking=False):
            raise Refuse(429, 'The YouTube converter is busy. Try again in a minute.')
        try:
            clean_cache()
            return fetch(video_id)
        finally:
            slots.release()


TYPES = {'.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.webm': 'audio/webm', '.opus': 'audio/ogg', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg'}


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = '3iaw-youtube-helper'
    sys_version = ''

    def log_message(self, fmt, *args):  # the default prints to a console that isn't there
        pass

    def send_json(self, status, body):
        data = json.dumps(body).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Helper', '1')  # tells the Worker this answer is the helper's, not a Cloudflare error page
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        try:
            path = self.path.split('?', 1)[0]
            if path == '/health':
                return self.send_json(200, {'ok': True})
            match = re.fullmatch(r'/audio/([A-Za-z0-9_-]{11})', path)
            if not match:
                return self.send_json(404, {'error': 'Not found.'})
            given = (self.headers.get('Authorization') or '').encode('utf-8')
            if not hmac.compare_digest(given, ('Bearer ' + TOKEN).encode('utf-8')):
                return self.send_json(401, {'error': 'Unauthorized.'})
            try:
                file, title = audio_for(match.group(1))
            except Refuse as no:
                return self.send_json(no.status, {'error': no.message})
            size = file.stat().st_size
            self.send_response(200)
            self.send_header('Content-Type', TYPES.get(file.suffix.lower(), 'audio/mp4'))
            self.send_header('Content-Length', str(size))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Helper', '1')
            if title:
                self.send_header('X-Title', quote(title, safe=''))
            self.end_headers()
            with file.open('rb') as f:
                shutil.copyfileobj(f, self.wfile, 256 * 1024)
        except (BrokenPipeError, ConnectionError):
            pass  # the visitor went away mid-download
        except Exception:
            log.exception('request failed: %s', self.path)
            try:
                self.send_json(500, {'error': 'The YouTube converter hit an error. Try again.'})
            except Exception:
                pass


# ---------- the tunnel (cloudflared) runs next to this program ----------
tunnel = None
stopping = threading.Event()


def cloudflared_exe():
    own = APP_DIR / 'cloudflared.exe'
    return str(own) if own.exists() else shutil.which('cloudflared')


def write_pids():
    (APP_DIR / 'helper.pid').write_text(json.dumps({'helper': os.getpid(), 'cloudflared': tunnel.pid if tunnel else None}), 'utf-8')


def keep_tunnel_running():
    """Start cloudflared with the settings setup.py wrote, and start it again whenever it stops."""
    global tunnel
    exe, settings = cloudflared_exe(), APP_DIR / 'cloudflared.yml'
    if not exe or not settings.exists():
        log.warning('no tunnel yet (run setup.py): the site cannot reach this PC')
        return
    wait = 5
    while not stopping.is_set():
        started = time.time()
        try:
            out = APP_DIR / 'cloudflared.log'
            if out.exists() and out.stat().st_size > 1024 * 1024:
                out.unlink()
            with out.open('ab') as sink:
                tunnel = subprocess.Popen(
                    [exe, 'tunnel', '--no-autoupdate', '--loglevel', 'warn', '--config', str(settings), 'run'],
                    stdout=sink, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, creationflags=NO_WINDOW)
                write_pids()
                log.info('tunnel started (pid %s)', tunnel.pid)
                tunnel.wait()
        except Exception as e:
            log.error('tunnel could not start: %s', e)
        if stopping.is_set():
            break
        wait = 5 if time.time() - started > 120 else min(wait * 2, 120)  # back off while it keeps failing
        log.warning('tunnel stopped; starting it again in %s s', wait)
        stopping.wait(wait)


def stop_tunnel():
    stopping.set()
    if tunnel and tunnel.poll() is None:
        tunnel.terminate()


def main():
    try:
        server = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)  # this PC only; the tunnel connects from inside
    except OSError as e:
        log.error('port %s is taken, most likely the helper is already running: %s', PORT, e)
        return 1
    server.daemon_threads = True
    write_pids()
    atexit.register(stop_tunnel)
    threading.Thread(target=keep_tunnel_running, daemon=True).start()
    clean_cache()
    log.info('helper ready on 127.0.0.1:%s (yt-dlp %s, ffmpeg %s)', PORT, yt_dlp.version.__version__, 'yes' if FFMPEG else 'no')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop_tunnel()
    return 0


if __name__ == '__main__':
    sys.exit(main())
