"""Sets up the YouTube helper for 3iaw.com on this PC.

Easiest: double-click "Install YouTube helper.bat" in this folder (in File Explorer, not inside another app:
some apps redirect what their programs write under AppData, and then the auto-start would not take).
Or run it from the website's folder:

    python youtube-helper\\setup.py             install or repair everything (safe to run again)
    python youtube-helper\\setup.py status      is the helper running, and can the site reach it
    python youtube-helper\\setup.py stop        stop the helper (it starts again at the next Windows sign-in)
    python youtube-helper\\setup.py start       start it again now
    python youtube-helper\\setup.py uninstall   stop it and remove it from this PC
    python youtube-helper\\setup.py local       only the parts that need no Cloudflare sign-in (for testing)

What install does:
  1. makes the folder "3iaw-youtube" in your user folder with its own Python (a venv), yt-dlp and ffmpeg
  2. copies youtube_helper.py there and makes a random token only this PC and the site's Worker know
  3. downloads cloudflared (Cloudflare's tunnel program) into that folder, if it isn't installed
  4. signs in to Cloudflare in your browser (you click Authorize), makes the tunnel "3iaw-youtube-helper"
     and points yt.3iaw.com at it
  5. gives the token to the Worker as the secret YOUTUBE_HELPER_TOKEN (wrangler)
  6. starts the helper, and if you agree makes it start whenever you sign in to Windows

Nothing secret is printed or stored in the website's folder. Add --yes to skip the questions.
"""

import json
import os
import secrets
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from xml.sax.saxutils import escape

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
APP = Path.home() / '3iaw-youtube'   # youtube_helper.py looks in the same place (APP_DIR)
VENV = APP / 'venv'
VPY, VPYW = VENV / 'Scripts' / 'python.exe', VENV / 'Scripts' / 'pythonw.exe'
HELPER = APP / 'youtube_helper.py'
CONFIG = APP / 'config.json'
TUNNEL_SETTINGS = APP / 'cloudflared.yml'
CF_OWN = APP / 'cloudflared.exe'
CF_URL = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
CF_HOME = Path.home() / '.cloudflared'
STARTUP = Path(os.environ.get('APPDATA', Path.home())) / 'Microsoft' / 'Windows' / 'Start Menu' / 'Programs' / 'Startup' / '3iaw YouTube helper.bat'

HOSTNAME = 'yt.3iaw.com'            # worker/index.js calls this address (YT_HELPER)
TUNNEL = '3iaw-youtube-helper'
PORT = 8791
SECRET = 'YOUTUBE_HELPER_TOKEN'     # the Worker secret that holds the token
TASK = '3iaw YouTube helper'        # the Task Scheduler task, used when the Startup folder can't be written
TEST_VIDEO = 'jNQXAC9IVRw'          # "Me at the zoo", 19 seconds: the first video on YouTube
NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
YES = '--yes' in sys.argv


def say(text):
    print('\n> ' + text, flush=True)


def note(text):
    print('  ' + text, flush=True)


def stop(text):
    print('\nSTOPPED: ' + text, flush=True)
    sys.exit(1)


def ask(question):
    if YES:
        return True
    return input('\n? ' + question + ' [Y/n] ').strip().lower() in ('', 'y', 'yes')


def get(url, token=None, timeout=20):
    """-> (status, headers, body bytes); status 0 when nothing answered."""
    headers = {'User-Agent': '3iaw-youtube-setup'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=timeout) as r:
            return r.status, r.headers, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read()
    except Exception:
        return 0, {}, b''


def read_config():
    try:
        return json.loads(CONFIG.read_text('utf-8'))
    except (OSError, ValueError):
        return {}


def helper_answers():
    status, headers, _ = get(f'http://127.0.0.1:{PORT}/health', timeout=3)
    return status == 200 and headers.get('X-Helper') == '1'


def site_reaches_helper():
    status, headers, _ = get(f'https://{HOSTNAME}/health', timeout=10)
    return status == 200 and headers.get('X-Helper') == '1'


# ---------- the steps ----------
def step_python():
    APP.mkdir(parents=True, exist_ok=True)
    if not VPY.exists():
        say('Making the helper its own Python, so it never touches your other Python programs')
        subprocess.run([sys.executable, '-m', 'venv', str(VENV)], check=True)
    say('Installing yt-dlp and ffmpeg for the helper (a minute or two the first time)')
    subprocess.run([str(VPY), '-m', 'pip', 'install', '--upgrade', '--quiet', '--disable-pip-version-check',
                    'yt-dlp[default]', 'imageio-ffmpeg'], check=True)
    (APP / 'last-update').write_text(time.strftime('%Y-%m-%d %H:%M:%S'), 'utf-8')  # the helper updates yt-dlp daily from here on
    version = subprocess.run([str(VPY), '-c', 'import yt_dlp; print(yt_dlp.version.__version__)'], capture_output=True, text=True)
    note('yt-dlp ' + version.stdout.strip())
    if not shutil.which('node') and not shutil.which('deno'):
        note('Node.js was not found. Most videos still work, but a few need it: install Node.js from nodejs.org if some links fail.')


def step_files():
    say('Copying the helper to ' + str(APP))
    shutil.copy2(HERE / 'youtube_helper.py', HELPER)
    config = read_config()
    if not config.get('token'):
        config['token'] = secrets.token_urlsafe(48)
        note('made a new token (kept in config.json in that folder, never shown)')
    config.update(port=PORT, hostname=HOSTNAME)
    CONFIG.write_text(json.dumps(config, indent=2), 'utf-8')
    return config


def step_cloudflared():
    exe = str(CF_OWN) if CF_OWN.exists() else shutil.which('cloudflared')
    if not exe:
        say("Downloading cloudflared from Cloudflare's releases on GitHub")
        note(CF_URL)
        part = CF_OWN.with_suffix('.download')
        part.unlink(missing_ok=True)
        curl = shutil.which('curl.exe')  # part of Windows 10 and 11
        if curl:
            got = subprocess.run([curl, '--location', '--fail', '--silent', '--show-error', '--output', str(part), CF_URL])
            if got.returncode != 0:
                stop('The download failed. Check your internet connection and run setup again.')
        else:
            request = urllib.request.Request(CF_URL, headers={'User-Agent': '3iaw-youtube-setup'})
            with urllib.request.urlopen(request, timeout=60) as r, part.open('wb') as f:
                shutil.copyfileobj(r, f, 64 * 1024)
        if part.stat().st_size < 5 * 1024 * 1024:
            stop('The download is too small to be cloudflared. Run setup again.')
        part.replace(CF_OWN)
        exe = str(CF_OWN)
    version = subprocess.run([exe, '--version'], capture_output=True, text=True)
    if version.returncode != 0:
        stop('cloudflared did not run: ' + (version.stderr or version.stdout).strip()[:300])
    note(version.stdout.strip().splitlines()[0])
    return exe


def step_sign_in(exe):
    if (CF_HOME / 'cert.pem').exists():
        return
    say('Signing in to Cloudflare. A browser window opens: pick 3iaw.com and click Authorize.')
    if subprocess.run([exe, 'tunnel', 'login']).returncode != 0 or not (CF_HOME / 'cert.pem').exists():
        stop('The Cloudflare sign-in did not finish. Run setup again to retry.')


def find_tunnel(exe):
    listed = subprocess.run([exe, 'tunnel', 'list', '--output', 'json', '--name', TUNNEL], capture_output=True, text=True)
    try:
        tunnels = json.loads(listed.stdout or 'null') or []
    except ValueError:
        tunnels = []
    for t in tunnels:
        if t.get('name') == TUNNEL:
            return t.get('id')
    return None


def step_tunnel(exe):
    say(f'Making the tunnel "{TUNNEL}" that connects this PC to {HOSTNAME}')
    tunnel_id = find_tunnel(exe)
    if tunnel_id:
        note('it already exists; using it')
    else:
        made = subprocess.run([exe, 'tunnel', 'create', TUNNEL], capture_output=True, text=True)
        if made.returncode != 0:
            stop('Could not make the tunnel: ' + (made.stderr or made.stdout).strip()[-400:])
        tunnel_id = find_tunnel(exe)
        if not tunnel_id:
            stop('The tunnel was made but could not be found afterwards. Run setup again.')
    key = CF_HOME / (tunnel_id + '.json')
    if not key.exists():
        stop(f'The tunnel exists on Cloudflare, but its key file is not on this PC ({key}).\n'
             f'  Delete the tunnel and run setup again:   "{exe}" tunnel delete {TUNNEL}')
    TUNNEL_SETTINGS.write_text(
        f"tunnel: {tunnel_id}\n"
        f"credentials-file: '{key}'\n"
        "ingress:\n"
        f"  - hostname: {HOSTNAME}\n"
        f"    service: http://127.0.0.1:{PORT}\n"
        "  - service: http_status:404\n", 'utf-8')
    routed = subprocess.run([exe, 'tunnel', 'route', 'dns', '--overwrite-dns', TUNNEL, HOSTNAME], capture_output=True, text=True)
    if routed.returncode != 0:
        stop(f'Could not point {HOSTNAME} at the tunnel: ' + (routed.stderr or routed.stdout).strip()[-400:])
    note(f'{HOSTNAME} now leads to this PC through the tunnel')


def step_secret(token):
    say(f"Giving the token to the site's Worker (secret {SECRET})")
    npx = shutil.which('npx.cmd') or shutil.which('npx')
    if not npx:
        stop('Node.js (npx) was not found, and wrangler needs it. Install Node.js from nodejs.org, then run setup again.')

    def put():
        # --yes: npx must not stop to ask about installing wrangler, or it would swallow the token
        return subprocess.run([npx, '--yes', 'wrangler', 'secret', 'put', SECRET], input=token + '\n',
                              capture_output=True, text=True, cwd=str(REPO), encoding='utf-8', errors='replace')

    done = put()
    if done.returncode != 0:
        note('wrangler is not signed in (or its sign-in expired). A browser window opens: click Allow.')
        subprocess.run([npx, '--yes', 'wrangler', 'login'], cwd=str(REPO))
        done = put()
    if done.returncode != 0:
        tail = ((done.stdout or '') + (done.stderr or '')).replace(token, '***').strip()[-600:]
        stop('wrangler could not save the secret:\n' + tail)
    note('saved; the live Worker has it now')


def step_autostart():
    if task_exists():
        note(f'it already starts by itself at every sign-in (Task Scheduler task "{TASK}")')
        return
    if not STARTUP.exists() and not ask('Start the helper automatically whenever you sign in to Windows?'):
        note(r'not added. Start it yourself with:  python youtube-helper\setup.py start')
        return
    STARTUP.parent.mkdir(parents=True, exist_ok=True)
    with STARTUP.open('w', encoding='mbcs', newline='') as f:
        f.write('@echo off\r\n'
                'rem Starts the 3iaw.com YouTube helper in the background. Delete this file to stop that.\r\n'
                f'start "" "{VPYW}" "{HELPER}"\r\n')
    # Started from inside some packaged apps, the file lands in that app's private copy of AppData and Windows never sees it
    packages = Path(os.environ.get('LOCALAPPDATA', '')) / 'Packages'
    strays = list(packages.glob('*/LocalCache/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/' + STARTUP.name)) if packages.is_dir() else []
    if strays:
        # the Startup folder is out of reach from here, so ask Windows' Task Scheduler to start it at sign-in instead
        for stray in strays:
            stray.unlink(missing_ok=True)
        added, problem = add_task()
        if added:
            note(f'it will start by itself at every sign-in (Task Scheduler task "{TASK}")')
        else:
            note('NOT added: ' + problem[:200])
            note('Double-click "Install YouTube helper.bat" in File Explorer to add the auto-start.')
        return
    note('it will start by itself at every sign-in (the file is in your Startup folder)')


def task_exists():
    return subprocess.run(['schtasks', '/Query', '/TN', TASK], capture_output=True, creationflags=NO_WINDOW).returncode == 0


def add_task():
    """A Task Scheduler task that starts the helper when this user signs in -> (worked, problem)."""
    user = escape(os.environ.get('USERDOMAIN', '') + '\\' + os.environ.get('USERNAME', ''))
    xml = f'''<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Starts the 3iaw.com YouTube helper in the background at sign-in. Remove it with: python youtube-helper\\setup.py uninstall</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>{user}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>{user}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author"><Exec><Command>{escape(str(VPYW))}</Command><Arguments>"{escape(str(HELPER))}"</Arguments><WorkingDirectory>{escape(str(APP))}</WorkingDirectory></Exec></Actions>
</Task>'''
    file = APP / 'autostart-task.xml'
    file.write_text(xml, 'utf-16')
    done = subprocess.run(['schtasks', '/Create', '/TN', TASK, '/XML', str(file), '/F'], capture_output=True, text=True, creationflags=NO_WINDOW)
    file.unlink(missing_ok=True)
    return done.returncode == 0, (done.stderr or done.stdout or '').strip()


def image_of(pid):
    """The program name of a running process, '' when there is none."""
    listed = subprocess.run(['tasklist', '/FI', f'PID eq {pid}', '/FO', 'CSV', '/NH'], capture_output=True, text=True, creationflags=NO_WINDOW)
    first = (listed.stdout or '').strip().splitlines()[:1]
    return first[0].split('","')[0].strip('"').lower() if first and first[0].startswith('"') else ''


def stop_helper():
    """Stop the helper and its tunnel. A process is only stopped when it really is one of ours."""
    try:
        pids = json.loads((APP / 'helper.pid').read_text('utf-8'))
    except (OSError, ValueError):
        pids = {}
    stopped = False
    for name, wanted in (('helper', ('python.exe', 'pythonw.exe')), ('cloudflared', ('cloudflared.exe',))):
        pid = pids.get(name)
        if isinstance(pid, int) and image_of(pid) in wanted:
            if name == 'helper' and not helper_answers():
                continue  # a different Python program now has that number
            subprocess.run(['taskkill', '/PID', str(pid), '/T', '/F'], capture_output=True, creationflags=NO_WINDOW)
            stopped = True
    (APP / 'helper.pid').unlink(missing_ok=True)
    return stopped


def start_helper():
    stop_helper()
    if not VPYW.exists() or not HELPER.exists():
        stop(r'The helper is not installed yet. Run:  python youtube-helper\setup.py')
    flags = getattr(subprocess, 'DETACHED_PROCESS', 0) | getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0)
    subprocess.Popen([str(VPYW), str(HELPER)], cwd=str(APP), creationflags=flags, close_fds=True,
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(60):
        if helper_answers():
            return True
        time.sleep(1)
    return False


def step_start(config):
    say('Starting the helper')
    if not start_helper():
        stop('The helper did not start. Its log is ' + str(APP / 'helper.log'))
    note(f'running on this PC (port {PORT})')
    say('Trying a 19-second test video through the helper')
    started = time.time()
    status, headers, body = get(f'http://127.0.0.1:{PORT}/audio/{TEST_VIDEO}', token=config['token'], timeout=120)
    if status != 200 or len(body) < 10000:
        problem = body[:300].decode('utf-8', 'replace') if body else 'no answer'
        stop(f'The helper could not fetch the test video ({status}): {problem}\n  Its log is {APP / "helper.log"}')
    note(f'got {len(body) / 1024:.0f} KB of {headers.get("Content-Type")} in {time.time() - started:.1f} s')


def step_check_site():
    say(f'Checking that the site can reach this PC at https://{HOSTNAME} (a new address can take a minute or two)')
    for _ in range(40):
        if site_reaches_helper():
            note('yes, it is reachable')
            return True
        time.sleep(3)
    note('not reachable yet. Give it a few minutes, then run:  python youtube-helper\\setup.py status')
    return False


# ---------- the commands ----------
def install(cloud=True):
    print(__doc__.split('What install does:')[1].split('Nothing secret')[0].rstrip() if cloud else '  (local parts only)')
    if cloud and not ask('Go ahead?'):
        return
    step_python()
    config = step_files()
    exe = step_cloudflared()
    if cloud:
        step_sign_in(exe)
        step_tunnel(exe)
        step_secret(config['token'])
        step_autostart()
    step_start(config)
    if cloud:
        reachable = step_check_site()
        print('\nDONE. YouTube links on 3iaw.com/audio now come through this PC whenever it is on.' if reachable
              else '\nINSTALLED, but the site cannot reach this PC yet (see above).')
    else:
        print('\nLocal parts are ready. Run setup without "local" to connect it to the site.')


def status():
    config = read_config()
    print('Helper folder:       ' + (str(APP) if HELPER.exists() else 'not installed'))
    print('Helper running:      ' + ('yes' if helper_answers() else 'no'))
    print(f'Site can reach it:   ' + ('yes' if site_reaches_helper() else f'no (https://{HOSTNAME} does not answer)'))
    print('Tunnel set up:       ' + ('yes' if TUNNEL_SETTINGS.exists() else 'no'))
    print('Token made:          ' + ('yes' if config.get('token') else 'no'))
    print('Starts at sign-in:   ' + ('yes' if STARTUP.exists() or task_exists() else 'no'))
    print('Log:                 ' + str(APP / 'helper.log'))


def uninstall():
    if not ask(f'Stop the helper and delete {APP} and its auto-start?'):
        return
    stop_helper()
    STARTUP.unlink(missing_ok=True)
    if task_exists():
        subprocess.run(['schtasks', '/Delete', '/TN', TASK, '/F'], capture_output=True, creationflags=NO_WINDOW)
    shutil.rmtree(APP, ignore_errors=True)
    print('Removed from this PC. Still on your Cloudflare account, to delete in the dashboard if you want:\n'
          f'  - the tunnel "{TUNNEL}" (Zero Trust > Networks > Tunnels)\n'
          f'  - the DNS record {HOSTNAME} (3iaw.com > DNS > Records)\n'
          f'  - the Worker secret {SECRET}')


def main():
    if os.name != 'nt':
        stop('This setup is for Windows.')
    command = next((a for a in sys.argv[1:] if not a.startswith('-')), 'install')
    if command == 'install':
        install()
    elif command == 'local':
        install(cloud=False)
    elif command == 'status':
        status()
    elif command == 'start':
        print('Started.' if start_helper() else 'It did not start. Its log is ' + str(APP / 'helper.log'))
    elif command == 'stop':
        print('Stopped.' if stop_helper() else 'It was not running.')
    elif command == 'uninstall':
        uninstall()
    else:
        print(__doc__)


if __name__ == '__main__':
    try:
        main()
    except subprocess.CalledProcessError as e:
        stop(f'A step failed (exit code {e.returncode}): {" ".join(map(str, e.cmd))[:200]}')
    except KeyboardInterrupt:
        stop('Cancelled.')
