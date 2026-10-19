import json, os, pty, re, select, subprocess, sys, time
mode, mutation = sys.argv[1:3]
master, slave = pty.openpty()
child = subprocess.Popen(sys.argv[3:], stdin=slave, stdout=slave, stderr=slave, close_fds=True)
os.close(slave)
content, sent = b'', set()
deadline = time.monotonic() + 30
try:
    while time.monotonic() < deadline:
        readable, _, _ = select.select([master], [], [], 0.1)
        if readable:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            if not data:
                break
            content += data
            for approval in re.findall(rb'Type approve ([a-f0-9]{64}) to ', content):
                if approval in sent:
                    continue
                sent.add(approval)
                if mode == 'stale' and len(sent) == 2:
                    with open(mutation, 'wb') as target:
                        target.write(b'changed by external fixture editor\n')
                if mode == 'cancel':
                    os.write(master, b'\x03')
                else:
                    os.write(master, (b'approve ' + approval if mode in ('approve', 'stale') else b'') + b'\n')
        elif child.poll() is not None:
            break
    code = child.wait(timeout=2)
    print(json.dumps({'code': code, 'batches': len(sent), 'output': content.decode('utf8', errors='replace')}))
finally:
    os.close(master)
    if child.poll() is None:
        child.kill()
        child.wait()
