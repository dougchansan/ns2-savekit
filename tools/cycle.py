#!/usr/bin/env python3
"""From a wedged console to an RPC session, with no hands and no screen checks.

  python3 tools/cycle.py                # full cycle: power, launch, host, V=START
  python3 tools/cycle.py --no-power     # console already freshly booted
  python3 tools/cycle.py --status       # just report the newest run

Assumptions, all measured on this console (docs/RESULTS.md, 2026-10-28):
  * a 16 s power press force-offs the console and a 1 s press boots it
  * the home menu keeps the game row with Mario Kart first and the retail
    SMILEBASIC 4 tile second, and the account picker defaults to `doug`
  * the session script already contains LOAD/RUN/REMOVE/V=START for this host

It starts the host, types the session through the Flipper's Bad KB, and leaves
the host running. Nothing here checks the screen: the point is to get RPC up
while other work continues.
"""
import argparse
import os
import re
import subprocess
import sys
import time
import urllib.request

FINGERBOT = os.environ.get('FINGERBOT', 'http://127.0.0.1:8080')
PAD = os.environ.get('PAD', 'http://192.168.50.215')
MAC_IP = os.environ.get('MAC_IP', '192.168.50.235')
RPC_DIR = os.path.expanduser('~/ns2jb-rpc')
FLIPPER_DIR = os.path.expanduser('~/flipper2jb')
FLIPPER_HOST = os.environ.get('FLIPPER_HOST', '192.168.50.215')
COMMAND = 'V=START(39380,192,168,50,235,0,0,0,0)'
HOST_LOG = '/tmp/cycle-host.log'

def log(message):
    print('%s  %s' % (time.strftime('%H:%M:%S'), message), flush=True)

def http(url, timeout=25):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return r.read().decode(errors='replace')
    except Exception as e:
        return 'ERR ' + str(e)[:80]

def pad(query, pause=1.0, ms=90):
    # Short taps only: a held direction auto-repeats on the home menu, which is
    # what made the cursor skip tiles.
    reply = http('%s/pro?%s&ms=%d' % (PAD, query, ms))
    time.sleep(pause)
    return reply

def power_cycle():
    log('fingerbot: arm up, then a 16 s press to force off')
    http(FINGERBOT + '/up')
    time.sleep(1)
    http(FINGERBOT + '/press?seconds=16', timeout=45)
    time.sleep(6)
    log('fingerbot: 1 s press to boot')
    http(FINGERBOT + '/press?seconds=1')
    time.sleep(6)
    http(FINGERBOT + '/press?seconds=1')
    log('waiting 30 s for the home menu')
    time.sleep(30)

def launch_smilebasic():
    # The home menu puts the cursor on the most recently played title, so as long
    # as this cycle ends with SmileBASIC running, it is the first tile next time.
    # HOME resets focus to that tile; A launches it. Then: account (doug), the tag
    # info dialog, and two more confirms that land on "Make a Program".
    log('pad: HOME -> A (launch most recent title)')
    pad('home=1', 1.5, ms=150)
    pad('a=1', 10)
    log('pad: A (account doug)')
    pad('a=1', 10)
    log('pad: A through the tag/info dialogs')
    for _ in range(3):
        pad('a=1', 6)
    log('pad: A (Make a Program)')
    pad('a=1', 8)
    time.sleep(3)
    log('SmileBASIC should be at the direct-mode prompt')

def start_host():
    log('host: node run.cjs --rpc %s' % MAC_IP)
    handle = open(HOST_LOG, 'w')
    proc = subprocess.Popen(['node', 'run.cjs', '--rpc', MAC_IP], cwd=RPC_DIR,
                            stdout=handle, stderr=subprocess.STDOUT)
    run = None
    for _ in range(60):
        time.sleep(0.5)
        try:
            text = open(HOST_LOG).read()
        except OSError:
            continue
        match = re.search(r'Run folder: (\S+)', text)
        if match:
            run = match.group(1)
            break
    if not run:
        raise SystemExit('host did not print a run folder; see ' + HOST_LOG)
    log('host: run folder %s (pid %d)' % (run, proc.pid))
    return proc, run

def session_script():
    sys.path.insert(0, FLIPPER_DIR)
    from flipper2jb.rpc import RPC, blob, integer
    from flipper2jb.targets.ns2jb import session_script as build
    from flipper2jb.transfer import upload
    from flipper2jb.autoclose import is_locked

    data, seconds = build(COMMAND)
    remote = '/ext/badusb/CY-%d.txt' % int(time.time())
    rpc = RPC(FLIPPER_HOST, 8080)
    try:
        if is_locked(rpc):
            log('flipper: Bad KB is open, sending Back')
            for event in (0, 2, 1):
                rpc.request(23, integer(1, 5) + integer(2, event))
                time.sleep(0.2)
            time.sleep(2)
        log('flipper: uploading %s (%d bytes of key script)' % (remote, len(data)))
        upload(rpc, remote, data)
        try:
            rpc.request(16, blob(1, 'Bad KB') + blob(2, remote))
        except RuntimeError as error:
            log('flipper: start refused (%s); pressing Run on the open app' % error)
        time.sleep(3)
        for event in (0, 2, 1):
            rpc.request(23, integer(1, 4) + integer(2, event))
            time.sleep(0.25)
        log('flipper: Run pressed; script types for %.0f s' % seconds)
    finally:
        rpc.close()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--no-power', action='store_true')
    parser.add_argument('--no-launch', action='store_true')
    parser.add_argument('--status', action='store_true')
    args = parser.parse_args()

    if args.status:
        runs = sorted((os.path.join(RPC_DIR, 'runs', name)
                       for name in os.listdir(os.path.join(RPC_DIR, 'runs'))),
                      key=os.path.getmtime)
        run = runs[-1]
        print(subprocess.run(['node', os.path.join(RPC_DIR, 'rpc.cjs'), run, 'status'],
                             capture_output=True, text=True).stdout)
        return

    if not args.no_power:
        power_cycle()
    if not args.no_launch:
        launch_smilebasic()

    proc, run = start_host()
    session_script()

    deadline = time.time() + 240
    while time.time() < deadline:
        time.sleep(15)
        text = open(HOST_LOG).read()
        stage = re.findall(r'^\s*([1-4])/4 .*$', text, re.M)
        ready = subprocess.run(['node', os.path.join(RPC_DIR, 'rpc.cjs'), run, 'status'],
                               capture_output=True, text=True).stdout
        log('host stage %s  status: %s' % (stage[-1] + '/4' if stage else 'none',
                                           'ready' if '"ready": true' in ready else 'not ready'))
        if '"ready": true' in ready:
            log('session is live: %s' % run)
            return
        if 'Error:' in text:
            log('host reported an error; see ' + HOST_LOG)
            return
    log('timed out waiting for the session')

if __name__ == '__main__':
    main()
