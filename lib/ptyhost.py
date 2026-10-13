#!/usr/bin/env python3
"""Allocate a PTY for a command and relay it over stdin/stdout.

macOS `script(1)` refuses to run unless its own stdin is a TTY, which it never is
when spawned from a server. forkpty() has no such requirement.

  argv: ptyhost.py <cols> <rows> <command> [args...]
  fd 0  -> keystrokes in
  fd 1  -> terminal output out
  fd 3  -> control channel, newline-delimited: "R <cols> <rows>"
"""
import os, sys, fcntl, termios, struct, select, signal

def set_winsize(fd, cols, rows):
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
    except OSError:
        pass

def main():
    if len(sys.argv) < 4:
        sys.stderr.write('usage: ptyhost.py <cols> <rows> <cmd> [args...]\n')
        return 2
    cols, rows, argv = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3:]

    pid, master = os.forkpty()
    if pid == 0:
        os.environ.setdefault('TERM', 'xterm-256color')
        os.environ['COLUMNS'], os.environ['LINES'] = str(cols), str(rows)
        try:
            os.execvp(argv[0], argv)
        except Exception as e:
            sys.stderr.write('exec failed: %s\n' % e)
            os._exit(127)

    set_winsize(master, cols, rows)
    signal.signal(signal.SIGCHLD, signal.SIG_DFL)

    try:
        ctrl = os.fdopen(3, 'rb', 0)
        ctrl_fd = ctrl.fileno()
    except OSError:
        ctrl, ctrl_fd = None, None

    out = sys.stdout.buffer
    watch = [master, 0] + ([ctrl_fd] if ctrl_fd is not None else [])
    pending = b''

    while True:
        try:
            ready, _, _ = select.select(watch, [], [], 0.5)
        except (InterruptedError, OSError):
            continue

        if master in ready:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            if not data:
                break
            out.write(data); out.flush()

        if 0 in ready:
            try:
                data = os.read(0, 65536)
            except OSError:
                data = b''
            if not data:
                # browser hung up; detach the child rather than orphaning it
                break
            os.write(master, data)

        if ctrl_fd is not None and ctrl_fd in ready:
            try:
                chunk = os.read(ctrl_fd, 4096)
            except OSError:
                chunk = b''
            if chunk:
                pending += chunk
                while b'\n' in pending:
                    line, pending = pending.split(b'\n', 1)
                    parts = line.decode('utf8', 'ignore').split()
                    if len(parts) == 3 and parts[0] == 'R':
                        try:
                            set_winsize(master, int(parts[1]), int(parts[2]))
                            os.kill(pid, signal.SIGWINCH)
                        except (ValueError, ProcessLookupError):
                            pass

        # reap
        try:
            done, _ = os.waitpid(pid, os.WNOHANG)
            if done == pid:
                break
        except ChildProcessError:
            break

    try: os.close(master)
    except OSError: pass
    try: os.kill(pid, signal.SIGHUP)
    except (ProcessLookupError, OSError): pass
    return 0

if __name__ == '__main__':
    sys.exit(main())
