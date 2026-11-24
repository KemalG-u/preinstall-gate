"""Trusted WSL2 + Bubblewrap + seccomp supervisor for Python CLI Lab runs.

Guarantees:
1. Source files and optional verified dependency files are written into a sterile temporary stage
   and bound READ-ONLY (`--ro-bind` / `--ro-bind-data`) inside Bubblewrap.
2. Synthesizes minimal `.dist-info/METADATA` inside `/work/repo` from inspected package metadata so
   modern Python CLIs calling `importlib.metadata.version(...)` or `entry_points()` work seamlessly
   without running `pip install` or executing setup scripts.
3. Trial workspace (`/work/deney`) is ephemeral bounded tmpfs inside Bubblewrap (`--size 8388608`).
4. Network is completely disabled (`--unshare-net`) AND `libseccomp.so.2` rejects every socket
   and host-bridge syscall (`AF_INET`, `AF_INET6`, `AF_VSOCK`, `AF_UNIX`, `connect`, `sendto`,
   `clone`, `fork`, `vfork`, `execveat`, `mount`, `ptrace`, `io_uring_*`) with `EPERM`.
5. No `/mnt`, `/home`, `/root`, `/etc`, `/proc`, `/run`, `/sys`, or Windows host env/secrets exist inside the sandbox.
6. In-process Python `sys.setprofile` tracer observes the exact AST-discovered producer return value
   (`objectId`, canonical `sha256`, `type`, `preview`, without exhausting generators/iterators) and natural
   downstream consumer argument reception in the SAME run (`runId`), detecting identity match, value match,
   or stale/mismatched consumption.
"""

import base64
import ctypes
import errno
import hashlib
import io
import json
import os
import re
import resource
import subprocess
import sys
import tempfile
import zipfile


class SandboxIncomplete(Exception):
    pass


def strict_json(text):
    def bad_constant(_):
        raise ValueError("non-JSON constant")

    return json.loads(text, parse_constant=bad_constant)


def bytes_fd(data):
    fd = os.memfd_create("labpy", os.MFD_CLOEXEC)
    try:
        written = os.write(fd, data)
        if written != len(data):
            raise OSError("short memfd write")
        os.lseek(fd, 0, os.SEEK_SET)
        return fd
    except BaseException:
        os.close(fd)
        raise


def network_and_process_filter():
    seccomp = ctypes.CDLL("libseccomp.so.2")
    seccomp.seccomp_init.argtypes = [ctypes.c_uint32]
    seccomp.seccomp_init.restype = ctypes.c_void_p
    seccomp.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    seccomp.seccomp_rule_add.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint]
    seccomp.seccomp_export_bpf.argtypes = [ctypes.c_void_p, ctypes.c_int]
    seccomp.seccomp_release.argtypes = [ctypes.c_void_p]
    ctx = seccomp.seccomp_init(0x7FFF0000)  # SCMP_ACT_ALLOW
    if not ctx:
        raise SandboxIncomplete("seccomp_init failed")
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
            if number < 0 and item in ("fork", "vfork"):
                continue
            if number < 0 or seccomp.seccomp_rule_add(ctx, 0x00050000 | errno.EPERM, number, 0):
                raise SandboxIncomplete(f"seccomp rule failed: {item}")
        fd = bytes_fd(b"")
        if seccomp.seccomp_export_bpf(ctx, fd) != 0:
            raise SandboxIncomplete("seccomp_export_bpf failed")
        os.lseek(fd, 0, os.SEEK_SET)
        result, fd = fd, None
        return result
    finally:
        seccomp.seccomp_release(ctx)
        if fd is not None:
            os.close(fd)


HARNESS_CODE = r'''
import errno
import hashlib
import importlib
import inspect
import io
import json
import os
import runpy
import socket
import sys
import time
import traceback

def verify_boundary():
    forbidden = ('/mnt', '/run', '/proc', '/etc', '/sys', '/home', '/root', '/usr/local')
    exposed = [p for p in forbidden if os.path.lexists(p)]
    if exposed:
        raise RuntimeError('boundary_exposed:' + ','.join(exposed))
    expected_env = {
        'HOME': '/work/home',
        'TMPDIR': '/work/tmp',
        'LANG': 'C.UTF-8',
        'PATH': '/usr/bin',
        'PWD': '/work/deney',
        'NO_COLOR': '1',
    }
    if dict(os.environ) != expected_env:
        raise RuntimeError('unexpected_env:' + ','.join(sorted(os.environ.keys())))
    blocked_families = []
    for name, family in (('AF_INET', socket.AF_INET), ('AF_INET6', socket.AF_INET6),
                         ('AF_VSOCK', getattr(socket, 'AF_VSOCK', 40)), ('AF_UNIX', socket.AF_UNIX)):
        try:
            s = socket.socket(family, socket.SOCK_STREAM)
        except OSError as exc:
            if exc.errno != errno.EPERM:
                raise RuntimeError(f'socket_unexpected_errno:{name}:{exc.errno}')
            blocked_families.append(name)
        else:
            s.close()
            raise RuntimeError(f'socket_allowed:{name}')
    return {
        'isolatedPathsVerified': True,
        'envCleanVerified': True,
        'blockedSockets': blocked_families,
        'pythonVersion': sys.version.split()[0],
    }

def is_stream_or_iterator(val):
    if inspect.isgenerator(val) or inspect.isasyncgen(val) or isinstance(val, io.IOBase):
        return True
    # Iterator that is not a reusable container (iter(x) is x)
    if hasattr(val, '__next__') and hasattr(val, '__iter__') and not isinstance(val, (str, bytes, bytearray, list, tuple, dict, set, frozenset)):
        return True
    return False

def canonical_repr(val, depth=0):
    if depth > 4:
        return f'<{type(val).__name__}>'
    if val is None or isinstance(val, (bool, int, float)):
        return json.dumps(val, ensure_ascii=False)
    if isinstance(val, str):
        return 'str:' + val[:4096]
    if isinstance(val, (bytes, bytearray)):
        return 'bytes:' + bytes(val[:4096]).hex()
    if is_stream_or_iterator(val):
        # Never consume an iterator/generator inside the profiler! Bind identity safely.
        g_name = getattr(val, '__qualname__', None) or getattr(val, 'name', None) or type(val).__name__
        return f'stream:{type(val).__name__}:{g_name}:id={id(val)}'
    if isinstance(val, (list, tuple)):
        items = [canonical_repr(x, depth + 1) for x in val[:64]]
        return f'{type(val).__name__}({len(val)}):[' + ','.join(items) + ']'
    if isinstance(val, (set, frozenset)):
        items = sorted(canonical_repr(x, depth + 1) for x in list(val)[:64])
        return f'{type(val).__name__}({len(val)}):[' + ','.join(items) + ']'
    if isinstance(val, dict):
        pairs = [f'{canonical_repr(k, depth + 1)}:{canonical_repr(v, depth + 1)}'
                 for k, v in sorted(list(val.items())[:64], key=lambda kv: str(kv[0]))]
        return f'dict({len(val)}):{{' + ','.join(pairs) + '}}'
    if hasattr(val, '__dict__'):
        attrs = {k: v for k, v in list(vars(val).items())[:24] if not k.startswith('__')}
        return f'{type(val).__module__}.{type(val).__qualname__}:' + canonical_repr(attrs, depth + 1)
    try:
        return repr(val)[:2048]
    except Exception:
        return f'<{type(val).__name__}>'

def summarize_value(val):
    canon = canonical_repr(val)
    digest = hashlib.sha256(canon.encode('utf-8', 'replace')).hexdigest()
    if isinstance(val, str):
        preview = val[:240]
    elif isinstance(val, (bytes, bytearray)):
        preview = bytes(val[:240]).decode('utf-8', 'replace')
    elif is_stream_or_iterator(val):
        preview = f'<{type(val).__name__} akış nesnesi (tüketilmeden kimliği izlendi)>'
    else:
        try:
            preview = repr(val)[:240]
        except Exception:
            preview = f'<{type(val).__name__}>'
    return {
        'objectId': id(val),
        'type': type(val).__name__,
        'isStream': is_stream_or_iterator(val),
        'sha256': digest,
        'preview': preview,
    }

def snapshot_workspace(root):
    files = {}
    for base, dirs, names in os.walk(root):
        dirs.sort()
        for name in sorted(names):
            full = os.path.join(base, name)
            rel = os.path.relpath(full, root).replace('\\', '/')
            if os.path.islink(full) or not os.path.isfile(full):
                continue
            data = open(full, 'rb').read(262144)
            files[rel] = {
                'bytes': os.path.getsize(full),
                'sha256': hashlib.sha256(data).hexdigest(),
                'preview': data[:400].decode('utf-8', 'replace'),
            }
    return files

def unwrap_code_object(obj):
    # Unwrap Click Command/Group `.callback`, functools.wraps `__wrapped__`, staticmethod/classmethod
    seen = set()
    cur = obj
    while cur is not None and id(cur) not in seen:
        seen.add(id(cur))
        code = getattr(cur, '__code__', None)
        if code is not None:
            return code
        if hasattr(cur, 'callback') and getattr(cur, 'callback') is not None:
            cur = getattr(cur, 'callback')
            continue
        if hasattr(cur, '__wrapped__') and getattr(cur, '__wrapped__') is not None:
            cur = getattr(cur, '__wrapped__')
            continue
        if hasattr(cur, 'func') and getattr(cur, 'func') is not None:
            cur = getattr(cur, 'func')
            continue
        break
    return None

def resolve_code_object(module_name, qualname):
    try:
        mod = importlib.import_module(module_name)
        obj = mod
        for part in qualname.split('.'):
            obj = getattr(obj, part)
        return unwrap_code_object(obj)
    except Exception:
        return None

def main():
    boundary = verify_boundary()
    spec = json.loads(open('/work/meta/spec.json', 'r', encoding='utf-8').read())

    sys.path[:0] = ['/work/repo', '/work/deps']

    os.makedirs('/work/deney', exist_ok=True)
    for rel, content in spec.get('workspaceFiles', {}).items():
        safe_rel = os.path.normpath(rel).lstrip('/')
        if safe_rel.startswith('..') or ('/' in safe_rel and safe_rel.split('/')[0] == '..'):
            continue
        dst = os.path.join('/work/deney', safe_rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        with open(dst, 'w', encoding='utf-8', newline='\n') as fh:
            fh.write(content)

    os.chdir('/work/deney')
    before_files = snapshot_workspace('/work/deney')

    trace_cfg = spec.get('trace') or {}
    prod_mod = trace_cfg.get('producerModule')
    prod_qual = trace_cfg.get('producerQualname')
    cons_mod = trace_cfg.get('consumerModule')
    cons_qual = trace_cfg.get('consumerQualname')
    cons_is_natural = bool(trace_cfg.get('isNaturalRepoConsumer'))
    simulate_stale = bool(spec.get('simulateStaleConsumer'))

    prod_code = resolve_code_object(prod_mod, prod_qual) if prod_mod and prod_qual else None
    cons_code = resolve_code_object(cons_mod, cons_qual) if cons_is_natural and cons_mod and cons_qual else None

    trace_events = {
        'runId': spec['runId'],
        'producerObserved': False,
        'consumerObserved': False,
        'producerReturn': None,
        'consumerReceived': None,
        'identityMatch': False,
        'valueMatch': False,
        'matchedArgName': None,
        'status': 'unobserved',
    }
    held_refs = []

    def iter_candidate_values(code, loc):
        arg_count = code.co_argcount + code.co_kwonlyargcount
        names_list = list(code.co_varnames[:arg_count])
        idx = arg_count
        if code.co_flags & 0x04:
            if idx < len(code.co_varnames):
                names_list.append(code.co_varnames[idx])
            idx += 1
        if code.co_flags & 0x08:
            if idx < len(code.co_varnames):
                names_list.append(code.co_varnames[idx])
        for vname in names_list:
            if vname == 'self' or vname not in loc:
                continue
            val = loc[vname]
            yield (vname, val)
            if isinstance(val, (tuple, list)) and len(val) <= 12:
                for i, elem in enumerate(val):
                    yield (f'{vname}[{i}]', elem)
            if isinstance(val, dict) and vname in ('kwargs', 'options', 'opts', 'params', 'context'):
                for dk, dv in list(val.items())[:24]:
                    yield (f'{vname}[{dk!r}]', dv)

    def matches_produced_object(val, v_sum, prod_obj, prod_info):
        if simulate_stale:
            return False, False, None
        id_eq = val is prod_obj
        val_eq = v_sum['sha256'] == prod_info['sha256']
        if id_eq or val_eq:
            return id_eq, val_eq, ''
        # Check if producer returned a tuple/dict unpacked via `*res` or `**options` into consumer's parameter
        if isinstance(prod_obj, (tuple, list)) and len(prod_obj) <= 12:
            for idx, sub in enumerate(prod_obj):
                sub_sum = summarize_value(sub)
                if val is sub or v_sum['sha256'] == sub_sum['sha256']:
                    return (val is sub), (v_sum['sha256'] == sub_sum['sha256']), f'[{idx}]'
        elif isinstance(prod_obj, dict) and len(prod_obj) <= 32:
            for dk, sub in prod_obj.items():
                sub_sum = summarize_value(sub)
                if val is sub or v_sum['sha256'] == sub_sum['sha256']:
                    return (val is sub), (v_sum['sha256'] == sub_sum['sha256']), f'[{dk!r}]'
        return False, False, None

    prod_is_gen_fn = bool(prod_code is not None and (prod_code.co_flags & 0x20))

    def profiler(frame, event, arg):
        code = frame.f_code
        if prod_code is not None and code is prod_code and not prod_is_gen_fn and event == 'return':
            if not trace_events['consumerObserved'] or trace_events['status'] != 'verified_natural_consumer':
                held_refs.append((arg, summarize_value(arg)))
                trace_events['producerObserved'] = True
                trace_events['producerReturn'] = held_refs[-1][1]
        elif cons_code is not None and code is cons_code and event == 'call':
            if (trace_events['producerObserved'] or prod_is_gen_fn) and trace_events['status'] != 'verified_natural_consumer':
                trace_events['consumerObserved'] = True
                best_match = None
                first_non_self = None
                for vname, raw_val in iter_candidate_values(code, frame.f_locals):
                    val = '__BAYAT_ESKI_DEGER__' if simulate_stale else raw_val
                    v_sum = summarize_value(val)
                    if first_non_self is None:
                        first_non_self = (vname, v_sum)
                    # Direct generator object check: `val.gi_code is prod_code`!
                    if not simulate_stale and prod_is_gen_fn and inspect.isgenerator(val) and getattr(val, 'gi_code', None) is prod_code:
                        gen_sum = summarize_value(val)
                        prod_gen_info = {**gen_sum, 'preview': f'<generator {prod_code.co_name} nesnesi>'}
                        trace_events['producerObserved'] = True
                        best_match = (vname, gen_sum, True, True, prod_gen_info)
                        break
                    if not best_match:
                        for prod_obj, prod_info in reversed(held_refs):
                            id_eq, val_eq, suffix = matches_produced_object(val, v_sum, prod_obj, prod_info)
                            if id_eq or val_eq:
                                label = f'{vname} (kaynak{suffix})' if suffix else vname
                                matched_p = summarize_value(val) if suffix else prod_info
                                best_match = (label, v_sum, id_eq, val_eq, matched_p)
                                break
                    if best_match:
                        break
                if best_match:
                    vname, v_sum, id_eq, val_eq, matched_prod = best_match
                    trace_events['producerReturn'] = matched_prod
                    trace_events['matchedArgName'] = vname
                    trace_events['consumerReceived'] = v_sum
                    trace_events['identityMatch'] = id_eq
                    trace_events['valueMatch'] = val_eq
                    trace_events['status'] = 'verified_natural_consumer'
                elif first_non_self:
                    vname, v_sum = first_non_self
                    trace_events['matchedArgName'] = vname
                    trace_events['consumerReceived'] = v_sum
                    trace_events['identityMatch'] = False
                    trace_events['valueMatch'] = False
                    trace_events['status'] = 'mismatch_or_stale'
                else:
                    trace_events['status'] = 'consumer_called_no_args'

    class NonClosingTextCapture(io.TextIOWrapper):
        def __init__(self):
            self._raw_buf = io.BytesIO()
            super().__init__(self._raw_buf, encoding='utf-8', write_through=True)
        def close(self):
            try:
                self.flush()
            except Exception:
                pass
        def isatty(self):
            return False
        def get_bytes(self):
            try:
                self.flush()
            except Exception:
                pass
            return self._raw_buf.getvalue()

    stdin_bytes = spec.get('stdinText', '').encode('utf-8')
    stdin_buf = io.BytesIO(stdin_bytes)
    stdin_wrapper = io.TextIOWrapper(stdin_buf, encoding='utf-8')
    out_wrapper = NonClosingTextCapture()
    err_wrapper = NonClosingTextCapture()

    orig_stdin, orig_stdout, orig_stderr = sys.stdin, sys.stdout, sys.stderr
    sys.stdin, sys.stdout, sys.stderr = stdin_wrapper, out_wrapper, err_wrapper
    sys.argv = list(spec.get('argv') or ['cli'])

    exit_code = 0
    runtime_error = None
    started = time.monotonic()
    if prod_code is not None or cons_code is not None:
        sys.setprofile(profiler)
    try:
        ep = spec['entrypoint']
        if ep.get('callable'):
            mod = importlib.import_module(ep['module'])
            fn = mod
            for part in ep['callable'].split('.'):
                fn = getattr(fn, part)
            rv = fn()
            if isinstance(rv, int):
                exit_code = rv
        else:
            runpy.run_module(ep['module'], run_name='__main__', alter_sys=True)
    except SystemExit as exc:
        if exc.code is None:
            exit_code = 0
        elif isinstance(exc.code, int):
            exit_code = exc.code
        else:
            exit_code = 1
            err_wrapper.write(str(exc.code) + '\n')
    except BaseException as exc:
        exit_code = 1
        runtime_error = f'{type(exc).__name__}: {exc}'
        err_wrapper.write(traceback.format_exc()[-2000:])
    finally:
        sys.setprofile(None)
        sys.stdin, sys.stdout, sys.stderr = orig_stdin, orig_stdout, orig_stderr

    duration_ms = round((time.monotonic() - started) * 1000, 2)
    stdout_text = out_wrapper.get_bytes()[:131072].decode('utf-8', 'replace')
    stderr_text = err_wrapper.get_bytes()[:65536].decode('utf-8', 'replace')

    if not cons_is_natural and trace_events['producerObserved']:
        prod_prev = (trace_events['producerReturn'] or {}).get('preview', '')
        trace_events['status'] = 'producer_only_runtime_sink'
        trace_events['sinkMatchesStdout'] = bool(prod_prev and prod_prev in stdout_text)

    after_files = snapshot_workspace('/work/deney')
    fs_diff = {'created': [], 'modified': [], 'deleted': []}
    for p, meta in after_files.items():
        if p not in before_files:
            fs_diff['created'].append({'path': p, **meta})
        elif before_files[p]['sha256'] != meta['sha256']:
            fs_diff['modified'].append({'path': p, **meta})
    for p in before_files:
        if p not in after_files:
            fs_diff['deleted'].append(p)

    report = {
        'ok': True,
        'runId': spec['runId'],
        'exitCode': exit_code,
        'durationMs': duration_ms,
        'stdout': stdout_text,
        'stderr': stderr_text,
        'runtimeError': runtime_error,
        'boundary': boundary,
        'trace': trace_events,
        'fsDiff': fs_diff,
    }
    orig_stdout.write('\n__URUN_TANI_LAB_RESULT__:' + json.dumps(report, ensure_ascii=False) + '\n')
    orig_stdout.flush()

if __name__ == '__main__':
    main()
'''


def safe_rel_path(rel):
    if not isinstance(rel, str) or not rel or len(rel) > 512 or "\\" in rel or "\x00" in rel:
        raise ValueError("invalid relative path")
    parts = rel.split("/")
    if any(not p or p in (".", "..") for p in parts):
        raise ValueError("unsafe relative path")
    return "/".join(parts)


def write_synthetic_dist_info(repo_dir, package_meta):
    """Create read-only `<pkg>-<ver>.dist-info/METADATA` so `importlib.metadata.version(...)` works inside bwrap."""
    if not isinstance(package_meta, dict):
        return
    raw_name = str(package_meta.get("name") or "").strip()
    if not raw_name or not re.match(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$", raw_name):
        return
    norm_name = re.sub(r"[-_.]+", "_", raw_name)
    raw_ver = str(package_meta.get("version") or "0.0.0").strip()
    if not re.match(r"^[A-Za-z0-9.+!_-]{1,48}$", raw_ver):
        raw_ver = "0.0.0"
    dist_dir = os.path.join(repo_dir, f"{norm_name}-{raw_ver}.dist-info")
    if os.path.exists(dist_dir):
        return
    os.makedirs(dist_dir, exist_ok=True)
    meta_lines = [
        "Metadata-Version: 2.1",
        f"Name: {raw_name}",
        f"Version: {raw_ver}",
    ]
    desc = str(package_meta.get("description") or "").replace("\r", " ").replace("\n", " ").strip()
    if desc:
        meta_lines.append(f"Summary: {desc[:200]}")
    with open(os.path.join(dist_dir, "METADATA"), "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(meta_lines) + "\n")

    entrypoints = package_meta.get("entrypoints") or []
    if isinstance(entrypoints, list) and entrypoints:
        ep_lines = ["[console_scripts]"]
        for ep in entrypoints[:16]:
            if isinstance(ep, dict) and ep.get("cli") and ep.get("module") and ep.get("callable"):
                cli_n = str(ep["cli"]).strip()
                if " " not in cli_n and re.match(r"^[A-Za-z0-9._-]+$", cli_n):
                    ep_lines.append(f"{cli_n} = {ep['module']}:{ep['callable']}")
        if len(ep_lines) > 1:
            with open(os.path.join(dist_dir, "entry_points.txt"), "w", encoding="utf-8", newline="\n") as fh:
                fh.write("\n".join(ep_lines) + "\n")

    # Provide build-time `_version.py` shim if package imports `._version` (setuptools-scm / hatch-vcs) in source archive
    ver_parts = [int(p) for p in re.findall(r"\d+", raw_ver)[:3]] or [0, 0, 0]
    for entry in sorted(os.listdir(repo_dir)):
        pkg_dir = os.path.join(repo_dir, entry)
        init_file = os.path.join(pkg_dir, "__init__.py")
        ver_file = os.path.join(pkg_dir, "_version.py")
        if os.path.isdir(pkg_dir) and os.path.isfile(init_file) and not os.path.exists(ver_file):
            try:
                init_txt = open(init_file, "r", encoding="utf-8", errors="ignore").read(16384)
            except OSError:
                init_txt = ""
            if "_version" in init_txt:
                with open(ver_file, "w", encoding="utf-8", newline="\n") as vfh:
                    vfh.write(
                        f'__version__ = version = {raw_ver!r}\n'
                        f'__version_tuple__ = version_tuple = {tuple(ver_parts)!r}\n'
                    )


def extract_verified_wheels(wheels_spec, dest_dir):
    """Verify every wheel's SHA-256 against expected lock before unpacking pure/Linux files."""
    extracted = []
    total_bytes = 0
    for item in wheels_spec:
        expected_sha = item.get("sha256")
        if not isinstance(expected_sha, str) or len(expected_sha) != 64:
            raise ValueError(f"wheel_invalid_expected_sha:{item.get('filename')}")
        if isinstance(item.get("contentBase64"), str):
            try:
                raw = base64.b64decode(item["contentBase64"], validate=True)
            except Exception as exc:
                raise ValueError(f"wheel_base64_invalid:{item.get('filename')}") from exc
        else:
            wpath = item.get("wslPath")
            if not isinstance(wpath, str) or os.path.islink(wpath) or not os.path.isfile(wpath):
                raise ValueError(f"wheel_missing:{item.get('filename')}")
            raw = open(wpath, "rb").read(25 * 1024 * 1024)
        total_bytes += len(raw)
        if total_bytes > 48 * 1024 * 1024:
            raise ValueError("wheel_total_budget_exceeded")
        actual_sha = hashlib.sha256(raw).hexdigest()
        if actual_sha != expected_sha:
            raise ValueError(f"wheel_checksum_mismatch:{item.get('filename')}")
        with zipfile.ZipFile(io.BytesIO(raw)) as zf:
            for member in zf.infolist():
                if member.is_dir() or ".data/" in member.filename:
                    continue
                rel = safe_rel_path(member.filename)
                if (member.external_attr >> 16) & 0o170000 == 0o120000:
                    raise ValueError("wheel_symlink_rejected")
                out_file = os.path.join(dest_dir, rel)
                os.makedirs(os.path.dirname(out_file), exist_ok=True)
                with open(out_file, "wb") as fh:
                    fh.write(zf.read(member))
        extracted.append({"filename": item.get("filename"), "sha256": actual_sha})
    return extracted


def run_sandboxed(payload):
    if not os.access("/usr/bin/bwrap", os.X_OK):
        raise SandboxIncomplete("bwrap_missing")
    python = os.path.realpath(sys.executable)
    version = f"{sys.version_info.major}.{sys.version_info.minor}"
    if python != "/usr/bin/python" + version:
        raise SandboxIncomplete("unexpected_python_binary")

    arch = os.uname().machine
    if arch == "x86_64":
        multiarch, loader, loader_arg = "x86_64-linux-gnu", "ld-linux-x86-64.so.2", "/lib64/ld-linux-x86-64.so.2"
    elif arch == "aarch64":
        multiarch, loader, loader_arg = "aarch64-linux-gnu", "ld-linux-aarch64.so.1", "/usr/lib/ld-linux-aarch64.so.1"
    else:
        raise SandboxIncomplete("unsupported_arch")

    stage_root = tempfile.mkdtemp(prefix="urun-tani-lab-")
    fds = []
    try:
        repo_dir = os.path.join(stage_root, "repo")
        deps_dir = os.path.join(stage_root, "deps")
        os.makedirs(repo_dir, exist_ok=True)
        os.makedirs(deps_dir, exist_ok=True)

        raw_files = payload.get("sourceFiles") or []
        file_pairs = []
        has_src_pkg = any(
            f["name"].startswith("src/") and (f["name"].endswith("/__init__.py") or f["name"].count("/") == 1)
            for f in raw_files
        )
        for item in raw_files:
            rel = safe_rel_path(item["name"])
            content = item["text"].encode("utf-8")
            file_pairs.append([rel, hashlib.sha256(content).hexdigest()])
            mount_rel = rel[4:] if (has_src_pkg and rel.startswith("src/")) else rel
            target = os.path.join(repo_dir, mount_rel)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, "wb") as fh:
                fh.write(content)

        computed_evidence_sha = hashlib.sha256(
            json.dumps(sorted(file_pairs, key=lambda x: x[0]), separators=(",", ":")).encode("utf-8")
        ).hexdigest()
        expected_evidence_sha = payload.get("expectedSourceSha256")
        if expected_evidence_sha and computed_evidence_sha != expected_evidence_sha:
            return {
                "ok": False,
                "errorCode": "SOURCE_ARTIFACT_MISMATCH",
                "message": "İncelenen kaynak özeti ile çalıştırılacak kaynak dosyalarının özeti eşleşmedi; çalıştırma durduruldu.",
                "expectedSourceSha256": expected_evidence_sha,
                "actualSourceSha256": computed_evidence_sha,
            }

        write_synthetic_dist_info(repo_dir, payload.get("packageMeta"))

        try:
            verified_wheels = extract_verified_wheels(payload.get("wheels") or [], deps_dir)
        except ValueError as exc:
            return {
                "ok": False,
                "errorCode": "DEPENDENCY_VERIFICATION_FAILED",
                "message": f"Bağımlılık paketi doğrulaması başarısız oldu ({exc}); çalıştırma durduruldu.",
            }

        spec_bytes = json.dumps(payload["spec"], ensure_ascii=False).encode("utf-8")
        harness_bytes = HARNESS_CODE.encode("utf-8")

        library_root = f"/usr/lib/{multiarch}/"
        flags = [
            "/usr/bin/bwrap",
            "--unshare-all", "--unshare-user", "--unshare-net", "--disable-userns",
            "--new-session", "--die-with-parent", "--clearenv", "--cap-drop", "ALL",
            "--ro-bind", python, python,
            "--ro-bind", f"/usr/lib/python{version}", f"/usr/lib/python{version}",
            "--symlink", "usr/lib", "/lib",
            "--ro-bind", library_root + loader, library_root + loader,
            "--symlink", library_root + loader, loader_arg,
        ]
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
            "--dir", "/work/home",
            "--dir", "/work/tmp",
            "--dir", "/work/deney",
            "--dir", "/work/meta",
            "--ro-bind", repo_dir, "/work/repo",
            "--ro-bind", deps_dir, "/work/deps",
            "--setenv", "HOME", "/work/home",
            "--setenv", "TMPDIR", "/work/tmp",
            "--setenv", "LANG", "C.UTF-8",
            "--setenv", "PATH", "/usr/bin",
            "--setenv", "NO_COLOR", "1",
            "--chdir", "/work/deney",
        ))

        def bind_ro_bytes(data, dest):
            fd = bytes_fd(data)
            fds.append(fd)
            flags.extend(("--perms", "0444", "--ro-bind-data", str(fd), dest))

        bind_ro_bytes(spec_bytes, "/work/meta/spec.json")
        bind_ro_bytes(harness_bytes, "/work/meta/harness.py")

        seccomp_fd = network_and_process_filter()
        fds.append(seccomp_fd)
        flags.extend(("--seccomp", str(seccomp_fd), "--", python, "-I", "-B", "-S", "-u", "/work/meta/harness.py"))

        supervisor_pid = os.getpid()

        def preexec():
            libc = ctypes.CDLL(None)
            if libc.prctl(1, 9, 0, 0, 0) != 0 or os.getppid() != supervisor_pid:
                os._exit(90)
            resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
            resource.setrlimit(resource.RLIMIT_NOFILE, (96, 96))
            resource.setrlimit(resource.RLIMIT_FSIZE, (4 * 1024 * 1024, 4 * 1024 * 1024))
            resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
            resource.setrlimit(resource.RLIMIT_CPU, (8, 8))

        timeout_sec = min(15.0, max(2.0, float(payload.get("timeoutSec", 10.0))))
        proc = subprocess.Popen(
            flags,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env={},
            cwd="/tmp",
            close_fds=True,
            pass_fds=tuple(fds),
            preexec_fn=preexec,
        )
        try:
            out_b, err_b = proc.communicate(timeout=timeout_sec)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.communicate()
            return {
                "ok": False,
                "errorCode": "SANDBOX_TIMEOUT",
                "message": f"Yalıtılmış deneme {timeout_sec:.0f} saniye süre sınırını aştı ve durduruldu.",
            }

        out_text = out_b.decode("utf-8", "replace")
        err_text = err_b.decode("utf-8", "replace")
        marker = "__URUN_TANI_LAB_RESULT__:"
        if marker not in out_text:
            return {
                "ok": False,
                "errorCode": "SANDBOX_EXECUTION_FAILED",
                "message": "Yalıtılmış süreç beklenen doğrulama çıktısını üretemedi.",
                "exitCode": proc.returncode,
                "stderr": err_text[-1500:],
            }
        json_line = out_text.split(marker, 1)[1].splitlines()[0]
        parsed = strict_json(json_line)
        parsed["sourceEvidenceSha256"] = computed_evidence_sha
        parsed["verifiedWheels"] = verified_wheels
        parsed["sandboxSpec"] = {
            "engine": "WSL2 Ubuntu + Bubblewrap (bwrap) + libseccomp",
            "network": "closed (--unshare-net + seccomp AF_INET/AF_INET6/AF_VSOCK/AF_UNIX -> EPERM)",
            "mountedReadOnly": ["/usr/bin/python" + version, f"/usr/lib/python{version}", "/work/repo", "/work/deps"],
            "writableTmpfs": "/work/deney (8 MiB tmpfs)",
            "limits": {"memoryMiB": 512, "cpuSec": 8, "wallSec": timeout_sec, "maxFileSizeMiB": 4},
        }
        return parsed
    finally:
        for fd in fds:
            try:
                os.close(fd)
            except OSError:
                pass
        import shutil
        shutil.rmtree(stage_root, ignore_errors=True)


def main(raw_payload=None):
    raw = sys.stdin.read() if raw_payload is None else raw_payload
    payload = strict_json(raw)
    result = run_sandboxed(payload)
    sys.stdout.write(json.dumps(result, ensure_ascii=False) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
