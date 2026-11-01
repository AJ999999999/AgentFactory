# The desk's pseudo-terminal on Mac and Linux (and in its tests): runs a command in a
# pty, copies the bytes it draws to stdout, and reads framed input from stdin, the
# same frames as scripts/windows/conpty.ps1:
#   [type: 1 byte][length: 4 bytes, little-endian][payload]
#   type 0: keys to type; 1: resize (cols, rows: 2 bytes each, little-endian); 2: close
#
#   python3 -I pty-bridge.py <cols> <rows> <folder> <command> [args...]
import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios


def size(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def write_all(fd, data):
    while data:
        n = os.write(fd, data)
        data = data[n:]


def main():
    cols, rows, folder, cmd = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3], sys.argv[4:]
    os.environ.setdefault("TERM", "xterm-256color")
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(folder)
        os.execvp(cmd[0], cmd)
    size(fd, cols, rows)
    pending = b""
    stdin_open = True
    while True:
        ready, _, _ = select.select([fd] + ([0] if stdin_open else []), [], [])
        if fd in ready:
            try:
                data = os.read(fd, 65536)
            except OSError as e:
                if e.errno != errno.EIO:
                    raise
                data = b""
            if not data:
                break
            write_all(1, data)
        if 0 in ready:
            chunk = os.read(0, 65536)
            if not chunk:
                # The desk went away: so does the terminal.
                stdin_open = False
                os.kill(pid, signal.SIGHUP)
                continue
            pending += chunk
            while len(pending) >= 5:
                kind, length = pending[0], struct.unpack("<I", pending[1:5])[0]
                if len(pending) < 5 + length:
                    break
                body, pending = pending[5:5 + length], pending[5 + length:]
                if kind == 0:
                    write_all(fd, body)
                elif kind == 1 and length >= 4:
                    c, r = struct.unpack("<HH", body[:4])
                    size(fd, c, r)
                    os.kill(pid, signal.SIGWINCH)
                elif kind == 2:
                    os.kill(pid, signal.SIGHUP)
    _, status = os.waitpid(pid, 0)
    sys.exit(os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else 0)


if __name__ == "__main__":
    main()
