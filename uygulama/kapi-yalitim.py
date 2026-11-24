"""Trusted WSL supervisor. Candidate source is data until bubblewrap is active."""
import ctypes
import errno
import hashlib
import json
import os
import resource
import selectors
import subprocess
import sys
import time


class Incomplete(Exception):
    pass


def strict_json(text):
    def bad_constant(_):
        raise ValueError("non-JSON constant")
    return json.loads(text, parse_constant=bad_constant)


def as_json(value):
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"), allow_nan=False)


def bytes_fd(data):
    fd = os.memfd_create("kapi", os.MFD_CLOEXEC)
    try:
        written = os.write(fd, data)
        if written != len(data):
            raise OSError("short memfd write")
        os.lseek(fd, 0, os.SEEK_SET)
        return fd
    except BaseException:
        os.close(fd)
        raise


def network_filter():
    # Binding only pipes for MCP allows the OS to forbid all socket creation,
    # including WSL's host bridge (AF_VSOCK). Block async and namespace bypasses.
    seccomp = ctypes.CDLL("libseccomp.so.2")
    seccomp.seccomp_init.argtypes = [ctypes.c_uint32]
    seccomp.seccomp_init.restype = ctypes.c_void_p
    seccomp.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    seccomp.seccomp_rule_add.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint]
    seccomp.seccomp_export_bpf.argtypes = [ctypes.c_void_p, ctypes.c_int]
    seccomp.seccomp_release.argtypes = [ctypes.c_void_p]
    ctx = seccomp.seccomp_init(0x7FFF0000)  # SCMP_ACT_ALLOW; other architectures are rejected by libseccomp.
    if not ctx:
        raise Incomplete("sandbox")
    fd = None
    try:
        denied = (
            "socket socketpair connect bind listen accept accept4 sendto sendmsg sendmmsg "
            "io_uring_setup io_uring_enter io_uring_register "
            "clone clone3 fork vfork unshare setns mount umount2 pivot_root chroot "
            "fsopen fsconfig fsmount fspick move_mount open_tree mount_setattr "
            "open_by_handle_at name_to_handle_at ptrace process_vm_readv process_vm_writev "
            "pidfd_getfd bpf perf_event_open userfaultfd memfd_create keyctl add_key request_key "
            "init_module finit_module delete_module execveat"
        ).split()
        for item in denied:
            number = seccomp.seccomp_syscall_resolve_name(item.encode("ascii"))
            if number < 0 and item in ("fork", "vfork"):  # absent on native arm64
                continue
            if number < 0 or seccomp.seccomp_rule_add(ctx, 0x00050000 | errno.EPERM, number, 0):
                raise Incomplete("sandbox")
        fd = bytes_fd(b"")
        if seccomp.seccomp_export_bpf(ctx, fd) != 0:
            raise Incomplete("sandbox")
        os.lseek(fd, 0, os.SEEK_SET)
        result, fd = fd, None
        return result
    finally:
        seccomp.seccomp_release(ctx)
        if fd is not None:
            os.close(fd)


BOOT = """
import errno,json,os,socket,sys
assert not any(os.path.lexists(x) for x in ('/mnt','/run','/proc','/etc','/sys','/home','/root','/usr/local'))
assert dict(os.environ) == {'HOME':'/work/home','TMPDIR':'/work','LANG':'C.UTF-8','PATH':'/usr/bin','PWD':'/work'}
for family in (socket.AF_INET,socket.AF_INET6, getattr(socket,'AF_VSOCK',40),socket.AF_UNIX):
    try:
        sock=socket.socket(family,socket.SOCK_STREAM)
    except OSError as exc:
        assert exc.errno == errno.EPERM
    else:
        sock.close()
        raise RuntimeError('socket allowed')
print(json.dumps({'kapiBoundary':'checked'}),flush=True)
os.execv(sys.executable,[sys.executable,'-I','-B','-S','-u','/work/server.py'])
"""

# No host HOME, /mnt, /etc, /run, /proc, IPC socket or package-manager tree.
# Only the trusted system interpreter, its standard library and selected shared
# libraries are read-only. The checked example files live in bounded tmpfs.
def launch(source, fds):
    if not os.access("/usr/bin/bwrap", os.X_OK):
        raise Incomplete("sandbox")
    python = os.path.realpath(sys.executable)
    version = f"{sys.version_info.major}.{sys.version_info.minor}"
    if python != "/usr/bin/python" + version:
        raise Incomplete("sandbox")
    flags = [
        "/usr/bin/bwrap", "--unshare-all", "--unshare-user", "--unshare-net", "--disable-userns",
        "--new-session", "--die-with-parent", "--clearenv", "--cap-drop", "ALL",
        "--ro-bind", python, python,
        "--ro-bind", "/usr/lib/python" + version, "/usr/lib/python" + version,
        "--symlink", "usr/lib", "/lib",
    ]
    arch = os.uname().machine
    if arch == "x86_64":
        multiarch, loader = "x86_64-linux-gnu", "ld-linux-x86-64.so.2"
        loader_arg = "/lib64/" + loader
    elif arch == "aarch64":
        multiarch, loader = "aarch64-linux-gnu", "ld-linux-aarch64.so.1"
        loader_arg = "/usr/lib/" + loader
    else:
        raise Incomplete("sandbox")
    library_root = "/usr/lib/" + multiarch + "/"
    flags.extend(("--ro-bind", library_root + loader, library_root + loader,
                  "--symlink", library_root + loader, loader_arg))
    for lib in (
        "libm.so.6", "libc.so.6", "libz.so.1", "libexpat.so.1", "libffi.so.8",
        "libcrypto.so.3", "libssl.so.3", "libzstd.so.1", "liblzma.so.5", "libbz2.so.1.0",
        "libsqlite3.so.0", "libuuid.so.1", "libpthread.so.0", "libdl.so.2", "librt.so.1",
        "libmpdec.so.4", "libgcc_s.so.1", "libstdc++.so.6",
    ):
        if os.path.isfile(library_root + lib):
            flags.extend(("--ro-bind", library_root + lib, library_root + lib))
    flags.extend((
        "--size", "8388608", "--tmpfs", "/work",
        "--dir", "/work/home", "--dir", "/work/ornek-belgeler",
        "--setenv", "HOME", "/work/home", "--setenv", "TMPDIR", "/work",
        "--setenv", "LANG", "C.UTF-8", "--setenv", "PATH", "/usr/bin",
        "--chdir", "/work",
    ))
    def file(content, path):
        fds.append(bytes_fd(content))
        flags.extend(("--perms", "0444", "--ro-bind-data", str(fds[-1]), path))
    file(source.encode("utf8"), "/work/server.py")
    for name in ("fatura.pdf", "rapor.pdf", "sozlesme.pdf", "notlar.txt"):
        content = (
            b"%PDF-1.4\n% Synthetic example label only, not an actual document.\n"
            if name.endswith(".pdf") else b"Sample labels for the local tool test.\n"
        )
        file(content, "/work/ornek-belgeler/" + name)
    fds.append(network_filter())
    flags.extend(("--seccomp", str(fds[-1]), "--", python, "-I", "-B", "-S", "-u", "-c", BOOT))

    supervisor = os.getpid()
    def limits():
        libc = ctypes.CDLL(None)
        if libc.prctl(1, 9, 0, 0, 0) != 0 or os.getppid() != supervisor:  # PR_SET_PDEATHSIG
            os._exit(90)
        for name, value in (
            (resource.RLIMIT_AS, 256 * 1024 * 1024),
            (resource.RLIMIT_CPU, 4),
            (resource.RLIMIT_FSIZE, 1024 * 1024),
            (resource.RLIMIT_NOFILE, 64),
            (resource.RLIMIT_CORE, 0),
        ):
            resource.setrlimit(name, (value, value))
    return subprocess.Popen(
        flags, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        cwd="/", env={"PATH": "/usr/bin", "LANG": "C.UTF-8"}, pass_fds=fds, preexec_fn=limits,
    )


class Mcp:
    def __init__(self, process):
        self.process = process
        self.io = selectors.DefaultSelector()
        self.buffer = bytearray()
        self.bytes = {"out": 0, "err": 0}
        self.deadline = time.monotonic() + 8
        self.request_id = 0
        self.boundary = False
        os.set_blocking(self.process.stdin.fileno(), False)
        for name, pipe in (("out", self.process.stdout), ("err", self.process.stderr)):
            os.set_blocking(pipe.fileno(), False)
            self.io.register(pipe, selectors.EVENT_READ, name)

    def read(self, stage):
        while True:
            end = self.buffer.find(b"\n")
            if end >= 0:
                frame = self.buffer[:end]
                del self.buffer[:end + 1]
                try:
                    if end > 48 * 1024:
                        raise ValueError()
                    return strict_json(frame.decode("utf8"))
                except (ValueError, UnicodeError, RecursionError) as exc:
                    raise Incomplete(stage) from exc
            if len(self.buffer) > 48 * 1024:
                raise Incomplete("limit")
            left = self.deadline - time.monotonic()
            if left <= 0:
                raise Incomplete("limit")
            if not self.io.get_map():
                raise Incomplete(stage)
            events = self.io.select(left)
            if not events:
                raise Incomplete("limit")
            for key, _ in events:
                chunk = os.read(key.fd, 8192)
                if not chunk:
                    self.io.unregister(key.fileobj)
                    if key.data == "out":
                        raise Incomplete(stage)
                    continue
                self.bytes[key.data] += len(chunk)
                if self.bytes[key.data] > (96 if key.data == "out" else 16) * 1024:
                    raise Incomplete("limit")
                if key.data == "out":
                    self.buffer.extend(chunk)

    def send(self, method, params=None, notify=False):
        request = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            request["params"] = params
        if not notify:
            self.request_id += 1
            request["id"] = self.request_id
        raw = memoryview(as_json(request).encode("ascii") + b"\n")
        try:
            # A server can report its inventory and then stop reading stdin.
            # Even when an escaped Unicode request exceeds pipe capacity,
            # sending it must respect the same hard wall-clock limit.
            fd = self.process.stdin.fileno()
            with selectors.DefaultSelector() as writable:
                writable.register(fd, selectors.EVENT_WRITE)
                while raw:
                    left = self.deadline - time.monotonic()
                    if left <= 0 or not writable.select(left):
                        raise Incomplete("limit")
                    try:
                        size = os.write(fd, raw)
                    except BlockingIOError:
                        continue
                    if not size:
                        raise Incomplete("protocol")
                    raw = raw[size:]
        except (OSError, ValueError) as exc:
            raise Incomplete("protocol") from exc
        if notify:
            return None
        for _ in range(32):
            reply = self.read("protocol")
            if not isinstance(reply, dict) or reply.get("jsonrpc") != "2.0":
                raise Incomplete("protocol")
            if "method" in reply:
                # No server request may call the client or use its resources.
                if "id" in reply or reply["method"] == "notifications/tools/list_changed":
                    raise Incomplete("changed")
                continue
            if type(reply.get("id")) is not int or reply["id"] != self.request_id or not isinstance(reply.get("result"), dict) or "error" in reply:
                raise Incomplete("call" if method == "tools/call" else "protocol")
            return reply["result"]
        raise Incomplete("limit")

    def enumerate(self):
        if self.read("sandbox") != {"kapiBoundary": "checked"}:
            raise Incomplete("sandbox")
        self.boundary = True
        version = "2025-11-25"
        info = self.send("initialize", {
            "protocolVersion": version, "capabilities": {},
            "clientInfo": {"name": "urun-tani-kapi", "version": "1.0"},
        })
        selected = info.get("protocolVersion")
        capabilities = info.get("capabilities")
        if selected not in (version, "2025-06-18", "2025-03-26", "2024-11-05") or not isinstance(capabilities, dict) or not isinstance(capabilities.get("tools"), dict):
            raise Incomplete("protocol")
        self.send("notifications/initialized", notify=True)
        tools = []
        cursor = None
        seen = set()
        for _ in range(5):
            listing = self.send("tools/list", {} if cursor is None else {"cursor": cursor})
            page = listing.get("tools")
            if not isinstance(page, list):
                raise Incomplete("protocol")
            tools.extend(page)
            if len(tools) > 24:
                raise Incomplete("limit")
            if "nextCursor" not in listing or listing["nextCursor"] is None:
                break
            cursor = listing["nextCursor"]
            if not isinstance(cursor, str) or len(cursor) > 1024 or cursor in seen:
                raise Incomplete("protocol")
            seen.add(cursor)
        else:
            raise Incomplete("limit")
        names = set()
        result = []
        for tool in tools:
            if not isinstance(tool, dict):
                raise Incomplete("protocol")
            name, schema = tool.get("name"), tool.get("inputSchema")
            if not isinstance(name, str) or not name or len(name) > 128 or name in names or not isinstance(schema, dict):
                raise Incomplete("protocol")
            names.add(name)
            signature = hashlib.sha256(as_json(tool).encode("ascii")).hexdigest()
            result.append({
                "name": name, "title": tool.get("title"), "description": tool.get("description"),
                "inputSchema": schema, "signature": signature,
            })
        return result


def execute(payload):
    fds, process, client = [], None, None
    try:
        process = launch(payload["source"], fds)
        client = Mcp(process)
        tools = client.enumerate()
        if "tool" not in payload:
            return {"code": "ok", "boundary": True, "tools": tools}
        # Validate the inspected inventory inside the very process receiving
        # tools/call. A changed or missing definition never receives the call.
        expected = sorted((item["name"], item["signature"]) for item in payload["expected"])
        actual = sorted((item["name"], item["signature"]) for item in tools)
        if expected != actual or not any(t["name"] == payload["tool"] for t in tools):
            raise Incomplete("changed")
        reply = client.send("tools/call", {"name": payload["tool"], "arguments": payload["arguments"]})
        content = reply.get("content", [])
        if not isinstance(content, list):
            raise Incomplete("call")
        text = "\n".join(
            item["text"] for item in content if isinstance(item, dict) and item.get("type") == "text" and isinstance(item.get("text"), str)
        )[:4000]
        structured = reply.get("structuredContent")
        probe = isinstance(structured, dict) and structured.get("networkProbe") == "denied"
        return {"code": "call" if reply.get("isError") else "ok", "boundary": True,
                "text": text, "hasText": bool(text), "probe": probe}
    except Incomplete as exc:
        return {"code": str(exc), "boundary": bool(client and client.boundary)}
    finally:
        if client:
            client.io.close()
        if process:
            process.stdin.close()
            process.kill()
            process.wait(timeout=2)
            process.stdout.close()
            process.stderr.close()
        for fd in fds:
            os.close(fd)


def main():
    try:
        raw = sys.stdin.buffer.read(512 * 1024 + 1)
        if len(raw) > 512 * 1024:
            raise Incomplete("limit")
        payload = strict_json(raw)
        answer = execute(payload)
    except (OSError, ValueError, KeyError, AttributeError, TypeError, RecursionError, subprocess.SubprocessError):
        answer = {"code": "sandbox", "boundary": False}
    except Incomplete as exc:
        answer = {"code": str(exc), "boundary": False}
    print(as_json(answer), flush=True)


if __name__ == "__main__":
    main()
