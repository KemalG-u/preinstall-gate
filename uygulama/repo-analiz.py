"""General Python CLI & Producer->Natural-Consumer Static Analyzer (AST-only, zero code execution).

Discovers:
1. CLI entrypoints from `pyproject.toml` (PEP 621 `[project.scripts]`, Poetry `[tool.poetry.scripts]`,
   Flit `[tool.flit.scripts]`), `setup.cfg` (`console_scripts`), `setup.py` (AST-parsed `console_scripts`),
   and `<pkg>/__main__.py` (`python -m <pkg>`).
2. Package metadata & PEP 508 dependencies (including `[project.dependencies]`, Poetry, Flit, `setup.cfg`,
   `setup.py`, and dynamic `requirements.txt` references).
3. General CLI invocation schemas via AST (`argparse.ArgumentParser`, `add_subparsers`, `click`/`typer`
   commands, groups, options, arguments, `fileinput`, `sys.stdin`, `sys.argv`) WITHOUT any repository-name
   or tool-specific hardcoding.
4. Verified producer -> natural downstream repository consumer data handoffs (variable handoffs, direct nested
   call handoffs, `functools.partial` / callable alias handoffs, class method handoffs, and generator streams),
   ranked and deduplicated with plain-Turkish explanations.
"""

import ast
import configparser
import json
import re
import sys
import tomllib
from collections import deque

SCRIPT_TARGET = re.compile(
    r"^\s*([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*):([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)?)\s*(?:\[.*\])?\s*$",
    re.ASCII,
)
DEP_NAME_RE = re.compile(r"^\s*([A-Za-z0-9][A-Za-z0-9._-]*)")
ROOTS = ("src/", "")

UNSUPPORTED_DEPS = {
    "pywin32": "Windows'a özgü sistem API bağımlılığı (pywin32) Linux/WSL yalıtımında çalışmaz.",
    "winreg": "Windows kayıt defteri (winreg) Linux/WSL yalıtımında desteklenmez.",
    "pypiwin32": "Windows'a özgü sistem bağımlılığı Linux/WSL yalıtımında çalışmaz.",
    "wmi": "Windows WMI bağımlılığı Linux/WSL yalıtımında çalışmaz.",
    "pyqt5": "Masaüstü grafik arayüz (PyQt5) bağımlılığı komut satırı yalıtımında desteklenmez.",
    "pyqt6": "Masaüstü grafik arayüz (PyQt6) bağımlılığı komut satırı yalıtımında desteklenmez.",
    "pyside2": "Masaüstü grafik arayüz (PySide2) bağımlılığı komut satırı yalıtımında desteklenmez.",
    "pyside6": "Masaüstü grafik arayüz (PySide6) bağımlılığı komut satırı yalıtımında desteklenmez.",
    "wxpython": "Masaüstü grafik arayüz (wxPython) bağımlılığı komut satırı yalıtımında desteklenmez.",
    "tkinter": "Grafik pencere (tkinter) arayüzü yalıtılmış CLI laboratuvarında desteklenmez.",
    "pygame": "Grafik/oyun penceresi (pygame) yalıtılmış CLI laboratuvarında desteklenmez.",
}

STDLIB_SINKS = {
    "builtins.print": ("stdout", "print()"),
    "sys.stdout.write": ("stdout", "sys.stdout.write()"),
    "sys.stdout.buffer.write": ("stdout", "sys.stdout.buffer.write()"),
    "click.echo": ("stdout", "click.echo()"),
    "click.secho": ("stdout", "click.secho()"),
    "typer.echo": ("stdout", "typer.echo()"),
    "pathlib.Path.write_text": ("file", "Path.write_text()"),
    "pathlib.Path.write_bytes": ("file", "Path.write_bytes()"),
}

TRIVIAL_HELPER_NAMES = {
    "error", "_error", "warn", "_warn", "debug", "_debug", "log", "_log",
    "exit", "_exit", "usage", "_usage", "version", "_version",
}

TURKISH_VERB_MAP = {
    "parse": "ayrıştır",
    "loads": "metinden yükle",
    "load": "yükle",
    "read": "oku",
    "split": "parçala",
    "tokenize": "sözcüklerine ayır",
    "lex": "sözcük birimlerine ayır",
    "scan": "tara",
    "extract": "çıkar",
    "normalize": "standart biçime getir",
    "clean": "temizle",
    "sanitize": "arındır",
    "filter": "süz",
    "validate": "doğrula",
    "check": "denetle",
    "lint": "kural denetiminden geçir",
    "format": "biçimlendir",
    "render": "görünüme dönüştür",
    "convert": "dönüştür",
    "transform": "dönüştür",
    "compile": "derle",
    "build": "oluştur",
    "generate": "üret",
    "dump": "dışa aktar",
    "dumps": "metin olarak dışa aktar",
    "write": "yaz",
    "remove": "ayıkla",
    "align": "hizala",
    "expand": "genişlet",
    "merge": "birleştir",
    "diff": "farkını çıkar",
    "compare": "karşılaştır",
    "sort": "sırala",
    "count": "say",
    "analyze": "çözümle",
    "inspect": "incele",
    "encode": "kodla",
    "decode": "çöz",
    "handle": "işle",
    "process": "işle",
    "wrap": "satır genişliğine sar",
    "choose": "seç",
    "find": "bul",
    "get": "getir",
    "select": "seç",
    "escape": "kaçışla koru",
}

TURKISH_NOUN_MAP = {
    "tabular": "tablo",
    "table": "tablo",
    "tables": "tablolar",
    "data": "veri",
    "row": "satır",
    "rows": "satırlar",
    "col": "sütun",
    "cols": "sütunlar",
    "column": "sütun",
    "columns": "sütunlar",
    "colwidths": "sütun genişlikleri",
    "width": "genişlik",
    "fn": "işlevi",
    "first": "ilk",
    "iterable": "veri dizisi",
    "filter": "süzgeç",
    "stack": "zinciri",
    "lexer": "sözcük çözümleyici",
    "formatter": "biçimlendirici",
    "class": "sınıfı",
    "name": "adı",
    "filename": "dosya adı",
    "standard": "standart görünüm",
    "color": "renkli görünüm",
    "parsable": "ayrıştırılabilir satır görünümü",
    "header": "başlık",
    "headers": "başlıklar",
    "line": "satır",
    "lines": "satırlar",
    "separating": "ayırıcı",
    "sql": "SQL sorgusu",
    "statement": "ifade",
    "statements": "ifadeler",
    "query": "sorgu",
    "queries": "sorgular",
    "html": "HTML içeriği",
    "markdown": "Markdown metni",
    "md": "Markdown metni",
    "json": "JSON verisi",
    "yaml": "YAML yapılandırması",
    "yml": "YAML yapılandırması",
    "toml": "TOML yapılandırması",
    "csv": "CSV tablosu",
    "tsv": "TSV tablosu",
    "xml": "XML belgesi",
    "text": "metin",
    "string": "metin",
    "file": "dosya",
    "files": "dosyalar",
    "stream": "veri akışı",
    "config": "yapılandırma",
    "options": "seçenekler",
    "args": "argümanlar",
    "token": "sözcük birimi",
    "tokens": "sözcük birimleri",
    "tree": "ağaç yapısı",
    "ast": "sözdizimi ağacı",
    "node": "düğüm",
    "nodes": "düğümler",
    "schema": "şema",
    "report": "rapor",
    "summary": "özet",
    "output": "çıktı",
    "input": "girdi",
    "record": "kayıt",
    "records": "kayıtlar",
}


def module_path(module, files):
    prefix = module.replace(".", "/")
    return next(
        (
            root + prefix + suffix
            for root in ROOTS
            for suffix in (".py", "/__init__.py")
            if root + prefix + suffix in files
        ),
        None,
    )


def path_to_module(path):
    clean = path[4:] if path.startswith("src/") else path
    if clean.endswith("/__init__.py"):
        clean = clean[:-12]
    elif clean.endswith(".py"):
        clean = clean[:-3]
    return clean.replace("/", ".")


def names(node):
    if isinstance(node, ast.Name):
        return [node.id]
    if isinstance(node, (ast.List, ast.Tuple)):
        return [item.id for item in node.elts if isinstance(item, ast.Name)]
    return []


def symbol(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        base = symbol(node.value)
        return (base + "." + node.attr) if base else None
    return None


def call_of(node):
    if isinstance(node, ast.Await):
        node = node.value
    return node if isinstance(node, ast.Call) else None


def calls(node):
    for child in ast.iter_child_nodes(node):
        if isinstance(child, (ast.stmt, ast.Lambda)):
            continue
        if isinstance(child, ast.Call):
            yield child
        yield from calls(child)


def quote_line(text, lineno):
    lines = text.splitlines()
    if 1 <= lineno <= len(lines):
        return lines[lineno - 1].strip()[:220]
    return ""


def written_names(statements):
    bound = set()
    pending = list(statements)
    while pending:
        node = pending.pop()
        if isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
            bound.add(node.id)
        if isinstance(node, ast.ExceptHandler) and node.name:
            bound.add(node.name)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            bound.add(node.name)
        elif not isinstance(node, (ast.Lambda, ast.Import, ast.ImportFrom)):
            pending.extend(ast.iter_child_nodes(node))
    return bound


def function_scope(function, module_aliases=None):
    args = function.args
    bound = written_names(function.body)
    if module_aliases:
        bound = {b for b in bound if b not in module_aliases}
    bound.update(item.arg for item in args.posonlyargs + args.args + args.kwonlyargs)
    bound.update(item.arg for item in (args.vararg, args.kwarg) if item)
    return bound


def nested_blocks(stmt):
    if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        return
    for field in ("body", "orelse", "finalbody"):
        block = getattr(stmt, field, [])
        if isinstance(block, list) and block:
            yield block
    for handler in getattr(stmt, "handlers", []):
        yield handler.body
    for case in getattr(stmt, "cases", []):
        yield case.body


def calls_in_body(function):
    for stmt in function.body:
        yield from calls(stmt)
        for block in nested_blocks(stmt):
            holder = ast.Module(body=block, type_ignores=[])
            yield from calls_in_body(holder)


def returns_value(function):
    """True when a function returns a non-None value OR yields stream items."""
    pending = list(function.body)
    while pending:
        node = pending.pop()
        if isinstance(node, ast.Return) and node.value is not None:
            if not isinstance(node.value, ast.Constant) or node.value.value is not None:
                return True
        if isinstance(node, (ast.Yield, ast.YieldFrom)):
            return True
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
            pending.extend(ast.iter_child_nodes(node))
    return False


def is_generator_function(function):
    pending = list(function.body)
    while pending:
        node = pending.pop()
        if isinstance(node, (ast.Yield, ast.YieldFrom)):
            return True
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
            pending.extend(ast.iter_child_nodes(node))
    return False


def data_names(node):
    if isinstance(node, ast.Name):
        return {node.id}
    if isinstance(node, ast.Call):
        return set().union(
            *(data_names(a) for a in node.args),
            *(data_names(k.value) for k in node.keywords),
        )
    if isinstance(
        node,
        (
            ast.JoinedStr,
            ast.FormattedValue,
            ast.BinOp,
            ast.Tuple,
            ast.List,
            ast.Dict,
            ast.Subscript,
            ast.Attribute,
            ast.Starred,
        ),
    ):
        return set().union(*(data_names(child) for child in ast.iter_child_nodes(node)))
    return set()


def const_str(node):
    return node.value if isinstance(node, ast.Constant) and isinstance(node.value, str) else None


class Repository:
    def __init__(self, files):
        self.files = files
        self.parsed = {}
        self.errors = []

    def read(self, module):
        if module in self.parsed:
            return self.parsed[module]
        path = module_path(module, self.files)
        if path is None:
            return None
        try:
            tree = ast.parse(self.files[path], filename=path)
        except UnicodeEncodeError:
            try:
                safe_src = self.files[path].encode("utf-8", "replace").decode("utf-8")
                tree = ast.parse(safe_src, filename=path)
            except (SyntaxError, ValueError, RecursionError):
                self.errors.append(path)
                self.parsed[module] = None
                return None
        except (SyntaxError, ValueError, RecursionError):
            self.errors.append(path)
            self.parsed[module] = None
            return None

        functions = {}
        classes = {}
        aliases = {}
        click_subcommands = {}
        click_params = {}
        module_bindings = written_names(tree.body)

        def inspect_decorators(fn_node, qualname):
            params = []
            for dec in fn_node.decorator_list:
                dec_call = dec if isinstance(dec, ast.Call) else None
                dec_sym = symbol(dec_call.func if dec_call else dec) or ""
                if "." in dec_sym and dec_sym.endswith(".command"):
                    grp = dec_sym.rsplit(".", 1)[0]
                    cmd_name = fn_node.name.replace("_", "-")
                    if dec_call:
                        if dec_call.args and const_str(dec_call.args[0]):
                            cmd_name = const_str(dec_call.args[0])
                        for kw in dec_call.keywords:
                            if kw.arg == "name" and const_str(kw.value):
                                cmd_name = const_str(kw.value)
                    click_subcommands.setdefault(grp, []).append((cmd_name, qualname))
                elif dec_call and (dec_sym.endswith(".option") or dec_sym.endswith(".argument")):
                    kind = "option" if dec_sym.endswith(".option") else "argument"
                    opt_strings = [const_str(a) for a in dec_call.args if const_str(a)]
                    kw_map = {kw.arg: kw.value for kw in dec_call.keywords if kw.arg}
                    is_flag = bool(
                        isinstance(kw_map.get("is_flag"), ast.Constant) and kw_map["is_flag"].value is True
                    )
                    required = bool(
                        isinstance(kw_map.get("required"), ast.Constant) and kw_map["required"].value is True
                    )
                    help_txt = const_str(kw_map.get("help")) or ""
                    type_repr = ast.unparse(kw_map["type"])[:80] if "type" in kw_map else ""
                    default_val = (
                        kw_map["default"].value
                        if "default" in kw_map
                        and isinstance(kw_map["default"], ast.Constant)
                        and isinstance(kw_map["default"].value, (str, int, float, bool))
                        else None
                    )
                    params.append(
                        {
                            "kind": kind,
                            "flags": opt_strings,
                            "isFlag": is_flag,
                            "required": required or (kind == "argument" and default_val is None),
                            "help": help_txt[:160],
                            "typeRepr": type_repr,
                            "default": default_val,
                        }
                    )
            if params:
                click_params[qualname] = list(reversed(params))

        def scan_top_statements(stmts):
            for node in stmts:
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    aliases.pop(node.name, None)
                    functions[node.name] = node
                    inspect_decorators(node, node.name)
                elif isinstance(node, ast.ClassDef):
                    aliases.pop(node.name, None)
                    methods = {}
                    for item in node.body:
                        if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                            methods[item.name] = item
                            qname = f"{node.name}.{item.name}"
                            functions[qname] = item
                            inspect_decorators(item, qname)
                    classes[node.name] = (node, methods)
                elif isinstance(node, ast.Import):
                    for item in node.names:
                        binding = item.asname or item.name.split(".")[0]
                        functions.pop(binding, None)
                        aliases[binding] = item.name if item.asname else item.name.split(".")[0]
                elif isinstance(node, ast.ImportFrom):
                    package = module.split(".") if path.endswith("/__init__.py") else module.split(".")[:-1]
                    if node.level:
                        up = node.level - 1
                        keep = max(0, len(package) - up)
                        base_parts = package[:keep] + ([node.module] if node.module else [])
                        base = ".".join(p for p in base_parts if p)
                    else:
                        base = node.module or ""
                    for item in node.names:
                        if item.name == "*":
                            continue
                        binding = item.asname or item.name
                        functions.pop(binding, None)
                        if base:
                            aliases[binding] = base + "." + item.name
                elif isinstance(node, ast.Try):
                    scan_top_statements(node.body)
                    for h in node.handlers:
                        scan_top_statements(h.body)
                elif isinstance(node, ast.If):
                    scan_top_statements(node.body)
                    scan_top_statements(node.orelse)

        scan_top_statements(tree.body)
        self.parsed[module] = (
            path,
            functions,
            classes,
            aliases,
            module_bindings,
            tree,
            click_subcommands,
            click_params,
        )
        return self.parsed[module]

    def resolve_class(self, module, ref, locals_):
        if not ref or ref.split(".")[0] in locals_:
            return None
        info = self.read(module)
        if not info:
            return None
        classes, aliases = info[2], info[3]
        if ref in classes:
            return (module, ref)
        prefix, sep, rest = ref.partition(".")
        alias = aliases.get(prefix)
        if not alias:
            return None
        expanded = alias + (sep + rest if sep else "")
        mod_part, _, cls_name = expanded.rpartition(".")
        if mod_part:
            target = self.read(mod_part)
            if target and cls_name in target[2]:
                return (mod_part, cls_name)
            if target and cls_name in target[3]:
                re_exp = target[3][cls_name]
                rmod, _, rcls = re_exp.rpartition(".")
                rtarget = self.read(rmod)
                if rtarget and rcls in rtarget[2]:
                    return (rmod, rcls)
        return None

    def resolve(self, module, ref, locals_, instance_types=None):
        if not ref:
            return None
        instance_types = instance_types or {}
        prefix, separator, rest = ref.partition(".")
        if prefix in instance_types and separator and rest:
            cls_mod, cls_name = instance_types[prefix]
            target = self.read(cls_mod)
            if target and f"{cls_name}.{rest}" in target[1]:
                return (cls_mod, f"{cls_name}.{rest}")
        if prefix == "self" and separator and rest and "." in str(locals_.get("__qualname__", "")):
            cls_name = str(locals_["__qualname__"]).split(".")[0]
            target = self.read(module)
            if target and f"{cls_name}.{rest}" in target[1]:
                return (module, f"{cls_name}.{rest}")
        if prefix in locals_:
            return None
        info = self.read(module)
        if not info:
            return None
        functions, aliases = info[1], info[3]
        if ref in functions:
            return (module, ref)
        alias = aliases.get(prefix)
        if alias is None:
            return None
        expanded = alias + (separator + rest if separator else "")
        parts = expanded.split(".")
        for split_idx in range(len(parts) - 1, 0, -1):
            mod_candidate = ".".join(parts[:split_idx])
            attr_candidate = ".".join(parts[split_idx:])
            target = self.read(mod_candidate)
            if target:
                if attr_candidate in target[1]:
                    return (mod_candidate, attr_candidate)
                first_attr, sep2, rem_attr = attr_candidate.partition(".")
                if first_attr in target[3]:
                    re_alias = target[3][first_attr] + (sep2 + rem_attr if sep2 else "")
                    rmod, _, rfunc = re_alias.rpartition(".")
                    rtarget = self.read(rmod)
                    if rtarget and rfunc in rtarget[1]:
                        return (rmod, rfunc)
        return None

    def external(self, module, ref, locals_):
        if not ref:
            return None
        prefix, separator, rest = ref.partition(".")
        if prefix in locals_:
            return None
        info = self.read(module)
        if not info:
            return None
        aliases, bindings = info[3], info[4]
        if prefix in aliases:
            return aliases[prefix] + (separator + rest if separator else "")
        if ref == "print" and prefix not in bindings:
            return "builtins.print"
        if ref in ("open", "len", "str", "list", "dict", "tuple") and prefix not in bindings:
            return "builtins." + ref
        return None

    def definition(self, key):
        info = self.read(key[0])
        if not info or key[1] not in info[1]:
            return None, None
        return info[0], info[1][key[1]]


def make_evidence(files, path, line, label, role):
    ev = {"path": path, "line": line, "label": label, "role": role, "origin": "source"}
    q = quote_line(files.get(path, ""), line)
    if q:
        ev["quote"] = q
    return ev


def consumed_parameters(function, call, used):
    positional = function.args.posonlyargs + function.args.args
    if positional and positional[0].arg == "self":
        positional = positional[1:]
    bound = [(parameter.arg, arg) for parameter, arg in zip(positional, call.args)]
    bound.extend((keyword.arg, keyword.value) for keyword in call.keywords if keyword.arg)
    return {parameter for parameter, arg in bound if bool(data_names(arg).intersection(used))}


def local_sinks(repo, module, block, incoming, scope):
    state = set(incoming)
    for stmt in block:
        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            continue
        for call in calls(stmt):
            ref = symbol(call.func) or ""
            writer = call.func
            if ref.endswith(".run_in_executor") and len(call.args) >= 3:
                writer = call.args[1]
            all_args = list(call.args) + [kw.value for kw in call.keywords]
            if not any(data_names(arg).intersection(state) for arg in all_args):
                continue
            ext = repo.external(module, symbol(writer), scope)
            if ext in ("sys.stdout.write", "sys.stdout.buffer.write", "builtins.print", "click.echo", "click.secho", "typer.echo"):
                yield call.lineno, "stdout"
            elif isinstance(writer, ast.Attribute) and writer.attr in ("write", "write_text", "write_bytes", "writelines", "dump"):
                yield call.lineno, "file_or_stream"
        for nested in nested_blocks(stmt):
            yield from local_sinks(repo, module, nested, state, scope)
        if isinstance(stmt, (ast.Assign, ast.AnnAssign)) and stmt.value is not None:
            targets = stmt.targets if isinstance(stmt, ast.Assign) else [stmt.target]
            assigned = written_names(targets)
            tracked = bool(data_names(stmt.value).intersection(state))
            state.difference_update(assigned)
            if tracked and all(isinstance(target, ast.Name) for target in targets):
                state.update(assigned)
        if isinstance(stmt, (ast.Return, ast.Raise, ast.Break, ast.Continue)):
            break


def classify_sink(repo, module, call, ref, scope):
    ext = repo.external(module, ref, scope)
    if ext in STDLIB_SINKS:
        return STDLIB_SINKS[ext]
    if isinstance(call.func, ast.Attribute) and call.func.attr in ("write", "writelines", "write_text", "write_bytes"):
        base_sym = symbol(call.func.value) or "çıktı akışı"
        if "stdout" in base_sym:
            return ("stdout", f"{base_sym}.{call.func.attr}()")
        return ("stream", f"{base_sym}.{call.func.attr}()")
    return None


def find_flows(repo, owner, block, scope, known=None, instances=None, callable_vars=None):
    state = dict(known or {})
    inst = dict(instances or {})
    c_vars = dict(callable_vars or {})
    for stmt in block:
        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            continue
        for consumer in calls(stmt):
            ref = symbol(consumer.func) or ""
            if not ref:
                continue
            expressions = list(consumer.args) + [keyword.value for keyword in consumer.keywords]
            direct_used = set()
            for expr in expressions:
                inner_call = call_of(expr)
                if inner_call:
                    inner_ref = symbol(inner_call.func) or ""
                    if repo.resolve(owner[0], inner_ref, scope, inst) or inner_ref in c_vars:
                        continue
                direct_used.update(data_names(expr))
            origins = {state[name] for name in direct_used if name in state}
            for origin in sorted(origins, key=lambda item: (item[1], item[0])):
                delivered = [name for name in origin[2] if name in direct_used and state.get(name) == origin]
                if delivered:
                    yield origin, consumer, ref, delivered, inst, c_vars

            for expr in expressions:
                inner = call_of(expr)
                if not inner:
                    continue
                inner_ref = symbol(inner.func) or ""
                producer = repo.resolve(owner[0], inner_ref, scope, inst)
                if not producer and inner_ref in c_vars:
                    producer = c_vars[inner_ref]
                if producer and producer != owner:
                    _, prod_def = repo.definition(producer)
                    if prod_def and returns_value(prod_def):
                        synthetic_name = prod_def.name.lstrip("_") + "_cikti"
                        origin = (producer, inner.lineno, (synthetic_name,))
                        yield origin, consumer, ref, [synthetic_name], inst, c_vars

        blocks = list(nested_blocks(stmt))
        for nested in blocks:
            yield from find_flows(repo, owner, nested, scope, state, inst, c_vars)

        if isinstance(stmt, (ast.Assign, ast.AnnAssign)):
            targets = stmt.targets if isinstance(stmt, ast.Assign) else [stmt.target]
            bound = [name for target in targets for name in names(target)]
            value = getattr(stmt, "value", None)
            for name in bound:
                state.pop(name, None)
            if len(bound) == 1 and value is not None:
                val_sym = symbol(value)
                if val_sym:
                    resolved_fn = repo.resolve(owner[0], val_sym, scope, inst)
                    if resolved_fn:
                        c_vars[bound[0]] = resolved_fn
                val_call = call_of(value)
                if val_call:
                    fn_sym = symbol(val_call.func) or ""
                    if fn_sym.endswith("partial") and val_call.args:
                        p_sym = symbol(val_call.args[0])
                        resolved_fn = repo.resolve(owner[0], p_sym, scope, inst)
                        if resolved_fn:
                            c_vars[bound[0]] = resolved_fn
                    cls_key = repo.resolve_class(owner[0], fn_sym, scope)
                    if cls_key:
                        inst[bound[0]] = cls_key

            call = call_of(value)
            if call and len(targets) == 1 and bound:
                call_sym = symbol(call.func) or ""
                producer = repo.resolve(owner[0], call_sym, scope, inst)
                if not producer and call_sym in c_vars:
                    producer = c_vars[call_sym]
                if producer and producer != owner:
                    _, prod_def = repo.definition(producer)
                    if prod_def and returns_value(prod_def):
                        origin = (producer, stmt.lineno, tuple(bound))
                        for name in bound:
                            state[name] = origin
                    else:
                        arg_used = set().union(
                            *(data_names(a) for a in call.args),
                            *(data_names(k.value) for k in call.keywords),
                        )
                        matched_origins = [state[n] for n in arg_used if n in state]
                        if len(matched_origins) == 1:
                            prev_origin = matched_origins[0]
                            for name in bound:
                                state[name] = (prev_origin[0], prev_origin[1], tuple(bound))
            elif isinstance(value, (ast.Attribute, ast.Call, ast.BinOp, ast.Subscript)) and len(bound) == 1:
                arg_used = data_names(value)
                matched_origins = [state[n] for n in arg_used if n in state]
                if len(matched_origins) == 1:
                    prev_origin = matched_origins[0]
                    for name in bound:
                        state[name] = (prev_origin[0], prev_origin[1], tuple(bound))

        if isinstance(stmt, (ast.Return, ast.Raise, ast.Break, ast.Continue)):
            break


def infer_sample_format_from_signals(imports, help_strings, extensions, doc_texts):
    """Infer input data shape strictly from AST imports, CLI option help/extensions, and docstrings.
    ZERO repository-name or tool-name checks!
    """
    imp_set = {i.lower() for i in imports}
    ext_set = {e.lower().lstrip(".") for e in extensions if e}
    signal_blob = " ".join(help_strings + doc_texts).lower()

    if "sql" in ext_set or re.search(r"\bsql\b|\bselect\b.*\bfrom\b|\bddl\b|\bdml\b", signal_blob):
        return "sql"
    if "yaml" in imp_set or "ruamel" in imp_set or "yaml" in ext_set or "yml" in ext_set or re.search(r"\byaml\b", signal_blob):
        return "yaml"
    if "tomllib" in imp_set or "tomli" in imp_set or "tomlkit" in imp_set or "toml" in ext_set or re.search(r"\btoml\b", signal_blob):
        return "toml"
    if (
        any("html" in i for i in imp_set)
        or "bs4" in imp_set
        or "lxml" in imp_set
        or "html" in ext_set
        or "htm" in ext_set
    ) and re.search(r"\bhtml\b|<p>|<div>|tag", signal_blob):
        # Check if converting Markdown -> HTML vs HTML -> text/Markdown
        if re.search(r"markdown\s+to\s+html|convert\s+markdown|from\s+markdown", signal_blob) and not any("html.parser" in i or "html.entities" in i for i in imp_set):
            return "markdown"
        return "html"
    if "md" in ext_set or "markdown" in ext_set or re.search(r"\bmarkdown\b", signal_blob) and not re.search(r"table\s+format|tabular", signal_blob):
        return "markdown"
    if "csv" in imp_set or "csv" in ext_set or "tsv" in ext_set or re.search(r"\btabular\b|\bcsv\b|\btsv\b|\bdelimit|\bcolumn", signal_blob):
        return "csv" if ("csv" in imp_set or "csv" in ext_set or "comma" in signal_blob) else "table"
    if "json" in imp_set and ("json" in ext_set or re.search(r"\bjson\b", signal_blob)):
        return "json"
    if "xml" in imp_set or "xml.etree" in imp_set or "xml" in ext_set:
        return "xml"
    if "dotenv" in signal_blob or ".env" in signal_blob or "key=value" in signal_blob:
        return "dotenv"
    return "text"


def extract_cli_schema(repo, entry_key, files, subcommand=None, target_fn_key=None):
    """Extract real CLI flags, positional arguments, subcommands, and input mode from AST."""
    visited = set()
    seeds = [entry_key]
    if target_fn_key and target_fn_key != entry_key:
        seeds.append(target_fn_key)
    queue = deque(seeds)

    uses_stdin = False
    uses_fileinput = False
    dash_means_stdin = False
    uses_sys_argv_file = False
    discovered_options = []
    entry_group_options = []
    positional_args = []
    subparsers_found = []
    imports_seen = set()
    extensions_seen = set()
    help_texts = []
    doc_texts = []

    while queue and len(visited) < 16:
        cur = queue.popleft()
        if cur in visited:
            continue
        visited.add(cur)
        mod_info = repo.read(cur[0])
        if not mod_info:
            continue
        path, functions, _, aliases, _, tree, _, click_params = mod_info
        fn = functions.get(cur[1])
        if not fn:
            continue

        # Do not dive into other Click subcommands when extracting schema for the entrypoint or a specific subcommand!
        is_seed = cur in seeds
        if not is_seed and cur[1] in click_params:
            continue

        for alias_target in aliases.values():
            imports_seen.add(alias_target.split(".")[0])
            imports_seen.add(alias_target)
        # Also include module-level imports of the package's root/__init__.py for accurate format signal detection
        pkg_root_mod = cur[0].split(".")[0]
        root_info = repo.read(pkg_root_mod)
        if root_info:
            for r_alias in root_info[3].values():
                imports_seen.add(r_alias.split(".")[0])
                imports_seen.add(r_alias)

        doc = ast.get_docstring(fn) or ast.get_docstring(tree) or ""
        if doc:
            doc_texts.append(doc[:600])

        # Click decorators on this function
        for cp in click_params.get(cur[1], []):
            if cp["help"]:
                help_texts.append(cp["help"])
            if cp["kind"] == "option":
                opt_item = {
                    "flags": cp["flags"],
                    "isFlag": cp["isFlag"],
                    "default": cp["default"],
                    "choices": [],
                    "help": cp["help"],
                }
                discovered_options.append(opt_item)
                if cur == entry_key and subcommand:
                    entry_group_options.append(opt_item)
            elif cp["kind"] == "argument":
                positional_args.append({
                    "name": cp["flags"][0] if cp["flags"] else "input",
                    "required": cp["required"],
                    "nargs": None,
                    "help": cp["help"],
                    "typeRepr": cp["typeRepr"],
                })
                if "File" in cp["typeRepr"]:
                    dash_means_stdin = True

        # Walk statements in function for stdin, fileinput, sys.argv, and argparse
        fn_src = ast.unparse(fn) if hasattr(ast, "unparse") else files.get(path, "")
        if "sys.stdin" in fn_src or ".stdin" in fn_src:
            uses_stdin = True
        if "fileinput" in fn_src:
            uses_fileinput = True
            uses_stdin = True
        if '== "-"' in fn_src or "== '-'" in fn_src:
            dash_means_stdin = True
        if "sys.argv[" in fn_src and "open(" in fn_src:
            uses_sys_argv_file = True

        for ext_match in re.findall(r"\.(sql|json|ya?ml|toml|csv|tsv|html?|md|markdown|xml|ini|cfg|env)\b", fn_src, re.IGNORECASE):
            extensions_seen.add(ext_match.lower())

        for call in calls_in_body(fn):
            ref = symbol(call.func) or ""
            # argparse `add_argument(...)`
            if ref.endswith("add_argument") and call.args:
                arg_strs = [const_str(a) for a in call.args if const_str(a)]
                if arg_strs:
                    kw_map = {kw.arg: kw.value for kw in call.keywords if kw.arg}
                    help_str = const_str(kw_map.get("help")) or ""
                    if help_str:
                        help_texts.append(help_str)
                    action_str = const_str(kw_map.get("action")) or ""
                    nargs_val = (
                        kw_map["nargs"].value
                        if "nargs" in kw_map and isinstance(kw_map["nargs"], ast.Constant)
                        else None
                    )
                    choices_list = []
                    if isinstance(kw_map.get("choices"), (ast.List, ast.Tuple, ast.Set)):
                        choices_list = [
                            elt.value
                            for elt in kw_map["choices"].elts
                            if isinstance(elt, ast.Constant) and isinstance(elt.value, (str, int))
                        ][:10]
                    default_val = (
                        kw_map["default"].value
                        if "default" in kw_map
                        and isinstance(kw_map["default"], ast.Constant)
                        and isinstance(kw_map["default"].value, (str, int, float, bool))
                        else None
                    )
                    if arg_strs[0].startswith("-"):
                        if action_str not in ("help", "version"):
                            discovered_options.append({
                                "flags": arg_strs,
                                "isFlag": action_str in ("store_true", "store_false", "count"),
                                "default": default_val,
                                "choices": choices_list,
                                "help": help_str[:160],
                            })
                    else:
                        type_repr = ast.unparse(kw_map["type"])[:80] if "type" in kw_map else ""
                        if "FileType" in type_repr:
                            dash_means_stdin = True
                        positional_args.append({
                            "name": arg_strs[0],
                            "required": nargs_val not in ("?", "*"),
                            "nargs": nargs_val,
                            "help": help_str[:160],
                            "typeRepr": type_repr,
                        })
            elif ref.endswith("add_parser") and call.args and const_str(call.args[0]):
                subparsers_found.append(const_str(call.args[0]))

            nxt = repo.resolve(cur[0], ref, function_scope(fn))
            if nxt and nxt not in visited:
                queue.append(nxt)

    required_pos_list = [p for p in positional_args if p["required"]]
    has_required_pos = len(required_pos_list) > 0
    has_optional_pos = any(not p["required"] for p in positional_args)

    # Check if positional argument looks like a raw string/pattern rather than a file path
    pos_names_blob = " ".join((p["name"] + " " + p.get("typeRepr", "")).lower() for p in positional_args)
    looks_like_file = (
        not positional_args
        or any(w in pos_names_blob for w in ("file", "path", "filename", "input", "source", "doc", "dosya", "klasor", "dir"))
        or uses_fileinput
        or uses_sys_argv_file
    )

    if len(required_pos_list) >= 2 and not looks_like_file:
        input_mode = "multi_positional_tokens"
    elif has_required_pos:
        input_mode = "file_arg" if looks_like_file else "positional_text"
    elif uses_fileinput or has_optional_pos or uses_sys_argv_file:
        input_mode = "file_arg"
    elif uses_stdin:
        input_mode = "stdin"
    else:
        input_mode = "file_arg"

    file_flag = None
    for opt in entry_group_options:
        fl_blob = " ".join(opt["flags"]).lower() + " " + opt.get("help", "").lower()
        if not opt["isFlag"] and any(w in fl_blob for w in ("--file", "location of the", "config file", ".env file", "dosya")):
            file_flag = opt["flags"][-1]
            break

    sample_format = infer_sample_format_from_signals(imports_seen, help_texts, extensions_seen, doc_texts)

    # Deduplicate options by first flag
    seen_opt = set()
    clean_options = []
    for opt in discovered_options:
        key = tuple(opt["flags"])
        if key not in seen_opt:
            seen_opt.add(key)
            clean_options.append(opt)

    return {
        "inputMode": input_mode,
        "subcommand": subcommand,
        "groupFileFlag": file_flag,
        "usesStdin": uses_stdin,
        "dashMeansStdin": dash_means_stdin,
        "positionalArgs": positional_args[:6],
        "options": clean_options[:16],
        "subcommands": subparsers_found[:10],
        "sampleFormat": sample_format,
    }


def translate_identifier_to_turkish(qualname):
    """Turn an English/Turkish Python function name into readable everyday Turkish."""
    raw = qualname.split(".")[-1].lstrip("_")
    parts = [p.lower() for p in re.split(r"[_\W]+", raw) if p]
    if not parts:
        return qualname
    # If already contains Turkish words, humanize spacing
    joined_raw = " ".join(parts)
    if any(w in joined_raw for w in ("satir", "ayristir", "bicimlendir", "rapor", "dosya", "oku", "yaz", "kontrol", "denetle")):
        return joined_raw

    verb = TURKISH_VERB_MAP.get(parts[0])
    stop_prepositions = {"to", "for", "by", "from", "with", "in", "of"}
    rest_words = [TURKISH_NOUN_MAP.get(w, w) for w in (parts[1:] if verb else parts) if w not in stop_prepositions]
    if verb and rest_words:
        phrase = " ".join(rest_words)
        return f"{phrase} adımını {verb}" if phrase.endswith(("veri", "verisi", "görünümü", "zinciri", "dizisi")) else f"{phrase} verisini {verb}"
    if verb:
        return f"girdiyi {verb}"
    mapped = [TURKISH_NOUN_MAP.get(w, w) for w in parts if w not in stop_prepositions]
    return " ".join(mapped)


def describe_job_in_turkish(
    cli,
    subcommand,
    producer_key,
    prod_def,
    consumer_key,
    consumer_label,
    is_natural_consumer,
    sink_kind,
    outputs,
    handed,
    cli_meta,
):
    prod_doc = (ast.get_docstring(prod_def) or "").strip()
    first_doc = prod_doc.splitlines()[0].strip() if prod_doc else ""
    prod_short = f"{producer_key[0]}.{producer_key[1]}"
    out_label = ", ".join(outputs)
    cmd_display = f"{cli} {subcommand}".strip() if subcommand else cli

    fmt = cli_meta.get("sampleFormat", "text")
    format_hints = {
        "table": ("sekme/boşluk ayrılmış tablo verisini", "düzenli ve hizalanmış tablo metni"),
        "csv": ("CSV/virgül ayrılmış satır ve sütun verisini", "yapılandırılmış tablo çıktısı"),
        "html": ("HTML etiketli belge metnini", "etiketlerden arındırılmış okunabilir metin"),
        "markdown": ("Markdown işaretli metni", "dönüştürülmüş belge çıktısı"),
        "sql": ("ham SQL sorgu metnini", "ayrıştırılmış ve kurallı SQL çıktısı"),
        "json": ("JSON biçimli veri girdisini", "işlenmiş/doğrulanmış veri çıktısı"),
        "yaml": ("YAML yapılandırma metnini", "denetlenmiş/ayrıştırılmış yapılandırma çıktısı"),
        "toml": ("TOML yapılandırma metnini", "ayrıştırılmış yapılandırma verisi"),
        "xml": ("XML belge metnini", "işlenmiş yapısal çıktı"),
        "dotenv": ("anahtar=değer (.env) satırlarını", "ayrıştırılmış ortam değişkeni kayıtları"),
        "text": ("verilen metin/dosya girdisini", f"işlenmiş ara sonuç ({out_label})"),
    }
    in_desc, out_desc = format_hints.get(fmt, format_hints["text"])

    is_digest = {"summary", "tree", "content"}.issubset(set(outputs)) and all(
        word in prod_doc.lower() for word in ("summary", "file", "content", "structure")
    )
    if is_digest:
        title = "Dosyalardan metin özeti oluştur"
        summary = "Kaynağı işleyip dosyaların yapısını ve içeriğini tek bir metne hazırlar."
        output_text = "Özet (summary), dosya ağacı (tree) ve dosya içerikleri (content)."
    else:
        prod_phrase = translate_identifier_to_turkish(producer_key[1])
        if is_natural_consumer and consumer_key:
            cons_phrase = translate_identifier_to_turkish(consumer_key[1])
            title = f"{cmd_display}: {prod_phrase} → {cons_phrase}"
        else:
            title = f"{cmd_display}: {prod_phrase} → çıktıya aktar"

        summary = (
            f"Kullanıcı `{cmd_display}` komutuna {in_desc} verdiğinde `{prod_short}` çalışır ve {out_desc} üretir."
            + (f" (Kaynak açıklaması: {first_doc[:140]})" if first_doc else "")
        )
        output_text = f"{out_desc} (kod içi değişken: `{out_label}`)"

    if is_natural_consumer and consumer_key:
        cons_short = f"{consumer_key[0]}.{consumer_key[1]}"
        consumer_text = (
            f"Deponun kendi sonraki adımı olan `{cons_short}` işlevi, üretilen `{', '.join(handed)}` ara çıktısını aynı koşuda doğrudan alır"
            + (" ve sonucu standart çıktıya/dosyaya yazar." if sink_kind else " ve bir sonraki dönüşümü tamamlar.")
        )
    else:
        if sink_kind == "stdout":
            consumer_text = f"Üretilen `{', '.join(handed)}` değeri `{consumer_label}` üzerinden doğrudan standart çıktıya (ekrana) yazılır."
        else:
            consumer_text = f"Üretilen `{', '.join(handed)}` değeri `{consumer_label}` adımına aktarılır."

    mode = cli_meta.get("inputMode")
    if mode == "stdin":
        input_text = "Standart girdi (stdin) üzerinden gönderilen örnek metin."
    elif mode == "positional_text":
        input_text = "Komut satırı argümanı olarak verilen örnek metin."
    else:
        input_text = "Geçici deney klasöründeki (`/work/deney`) örnek girdi dosyası."

    return title, summary, input_text, output_text, consumer_text


def find_jobs(repo, cli, start, manifest_path, manifest_line, files):
    visited = set()
    # Queue tuples: (owner_key, caller_callables, subcommand_name, subcommand_fn_key, depth)
    pending = deque([(start, None, None, None, 0)])
    raw_jobs = []
    job_ids = set()
    entry_path, entry = repo.definition(start)
    if not entry:
        return []

    cli_meta_cache = {}

    while pending and len(visited) < 56:
        owner, caller_info, subcmd, subcmd_fn_key, depth = pending.popleft()
        visit_key = (owner, subcmd)
        if visit_key in visited:
            continue
        visited.add(visit_key)
        path, function = repo.definition(owner)
        if not function:
            continue

        cache_key = (subcmd, subcmd_fn_key or start)
        if cache_key not in cli_meta_cache:
            cli_meta_cache[cache_key] = extract_cli_schema(
                repo, start, files, subcommand=subcmd, target_fn_key=subcmd_fn_key
            )
        cli_meta = cli_meta_cache[cache_key]

        scope = function_scope(function)
        if "." in owner[1]:
            scope = set(scope) | {"__qualname__"}
            scope_map = {k: True for k in scope}
            scope_map["__qualname__"] = owner[1]
        else:
            scope_map = {k: True for k in scope}

        found = list(find_flows(repo, owner, function.body, scope_map, callable_vars=caller_info))
        for (producer, line, outputs), consumer, ref, used, inst, c_vars in found:
            if not used:
                continue
            consumer_key = repo.resolve(owner[0], ref, scope_map, inst)
            if not consumer_key and ref in c_vars:
                consumer_key = c_vars[ref]
            sink_info = classify_sink(repo, owner[0], consumer, ref, scope_map)
            if not consumer_key and not sink_info:
                continue

            prod_leaf = producer[1].split(".")[-1].lower()
            cons_leaf = consumer_key[1].split(".")[-1].lower() if consumer_key else ""
            if prod_leaf in TRIVIAL_HELPER_NAMES or cons_leaf in TRIVIAL_HELPER_NAMES:
                continue

            consumer_function = repo.definition(consumer_key)[1] if consumer_key else None
            sinks = (
                list(
                    local_sinks(
                        repo,
                        consumer_key[0],
                        consumer_function.body,
                        consumed_parameters(consumer_function, consumer, set(used)),
                        function_scope(consumer_function),
                    )
                )
                if consumer_function
                else []
            )
            sink_kind = sink_info[0] if sink_info else (sinks[0][1] if sinks else None)
            is_natural = bool(consumer_key and consumer_key != producer)
            consumer_label = f"{consumer_key[0]}.{consumer_key[1]}()" if consumer_key else sink_info[1]

            sub_prefix = f"{subcmd}:" if subcmd else ""
            ident = f"python:{sub_prefix}{'.'.join(producer)}->" + (
                ".".join(consumer_key) if consumer_key else sink_info[0]
            )
            legacy_id = "python:" + ".".join(producer)
            use_id = legacy_id if legacy_id == "python:gitingest.ingestion.ingest_query" else ident
            if use_id in job_ids:
                continue
            job_ids.add(use_id)

            producer_path, definition = repo.definition(producer)
            is_gen = is_generator_function(definition)
            proof = []
            if manifest_path and manifest_line:
                proof.append(make_evidence(files, manifest_path, manifest_line, "Komutun tanımlandığı paket kaydı", "trigger"))
            proof.append(make_evidence(files, entry_path, entry.lineno, f"{cli} komutunun giriş işlevi", "trigger"))
            if subcmd and owner != start:
                proof.append(make_evidence(files, path, function.lineno, f"`{subcmd}` alt komut işlevi ({owner[1]})", "trigger"))
            proof.append(make_evidence(files, producer_path, definition.lineno, f"Ara çıktıyı üreten işlev ({producer[1]})", "producer"))
            proof.append(make_evidence(files, path, line, "Ara çıktının üretildiği çağrı satırı", "producer"))
            proof.append(make_evidence(files, path, consumer.lineno, f"Ara çıktıyı tüketen adım ({consumer_label})", "consumer"))
            if consumer_key:
                consumer_path, consumer_def = repo.definition(consumer_key)
                if consumer_path and consumer_def:
                    proof.append(make_evidence(files, consumer_path, consumer_def.lineno, f"Doğal tüketici işlev tanımı ({consumer_key[1]})", "consumer"))
                for sink_line, _ in sinks[:2]:
                    proof.append(make_evidence(files, consumer_path, sink_line, "Tüketicinin çıktıyı aktardığı satır", "consumer"))

            title, summary, input_desc, output_desc, consumer_desc = describe_job_in_turkish(
                cli,
                subcmd,
                producer,
                definition,
                consumer_key,
                consumer_label,
                is_natural,
                sink_kind,
                outputs,
                used,
                cli_meta,
            )

            is_public_prod = not producer[1].split(".")[-1].startswith("_")
            is_public_cons = bool(consumer_key and not consumer_key[1].split(".")[-1].startswith("_"))
            # Strongly prefer top-level / low-depth CLI orchestration flows and public functions over deep private micro-helpers!
            rank = (
                3 if is_natural else 1,
                2 if (is_public_prod and is_public_cons) else (1 if is_public_prod or is_public_cons else 0),
                -depth,
                1 if (sinks or sink_info) else 0,
                0 if not is_gen else -1,
                len(used),
            )
            cmd_trigger = f"{cli} {subcmd}".strip() if subcmd else cli
            raw_jobs.append({
                "id": use_id,
                "origin": "source",
                "title": title,
                "summary": summary,
                "input": input_desc,
                "output": output_desc,
                "consumer": consumer_desc,
                "trigger": f"`{cmd_trigger}` komutu çalıştırıldığında (`{entry_path}:{entry.lineno}`).",
                "evidence": proof,
                "flowSpec": {
                    "cli": cli,
                    "subcommand": subcmd,
                    "entrypoint": {"module": start[0], "callable": start[1], "path": entry_path, "line": entry.lineno},
                    "orchestrator": {"module": owner[0], "callable": owner[1], "path": path, "depth": depth},
                    "producer": {
                        "module": producer[0],
                        "qualname": producer[1],
                        "path": producer_path,
                        "line": definition.lineno,
                        "callLine": line,
                        "variables": list(outputs),
                        "isGenerator": is_gen,
                        "isPrivateHelper": not is_public_prod,
                    },
                    "consumer": {
                        "kind": "repo_function" if is_natural else "runtime_sink",
                        "isNaturalRepoConsumer": is_natural,
                        "module": consumer_key[0] if consumer_key else "builtins",
                        "qualname": consumer_key[1] if consumer_key else (sink_info[1] if sink_info else ref),
                        "path": repo.definition(consumer_key)[0] if consumer_key else path,
                        "line": repo.definition(consumer_key)[1].lineno if consumer_key and repo.definition(consumer_key)[1] else consumer.lineno,
                        "callLine": consumer.lineno,
                        "variables": list(used),
                    },
                    "invocation": cli_meta,
                },
                "run": None,
                "_rank": rank,
            })

        local_callables = dict(caller_info or {})
        local_instances = {}
        for node in ast.walk(function):
            if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
                tname = node.targets[0].id
                vsym = symbol(node.value)
                if vsym:
                    rf = repo.resolve(owner[0], vsym, scope_map)
                    if rf and tname not in local_callables:
                        local_callables[tname] = rf
                vcall = call_of(node.value)
                if vcall:
                    fn_sym = symbol(vcall.func) or ""
                    if fn_sym.endswith("partial") and vcall.args:
                        psym = symbol(vcall.args[0])
                        rf = repo.resolve(owner[0], psym, scope_map)
                        if rf and tname not in local_callables:
                            local_callables[tname] = rf
                    cls_key = repo.resolve_class(owner[0], fn_sym, scope_map)
                    if cls_key:
                        local_instances[tname] = cls_key

        # Follow Click/Typer subcommands decorated with `@<owner>.command(...)`
        mod_info = repo.read(owner[0])
        if mod_info:
            for sub_cmd_name, sub_fn in mod_info[6].get(owner[1], []):
                sub_key = (owner[0], sub_fn)
                if (sub_key, sub_cmd_name) not in visited:
                    pending.append((sub_key, local_callables, sub_cmd_name, sub_key, depth + 1))

        # Also scan other modules that imported this Click group and registered `@cli.command(...)`
        for other_mod_path in list(files.keys()):
            if not other_mod_path.endswith(".py"):
                continue
            other_mod = path_to_module(other_mod_path)
            if other_mod == owner[0]:
                continue
            other_info = repo.read(other_mod)
            if not other_info:
                continue
            other_aliases = other_info[3]
            for local_grp, target_sym in other_aliases.items():
                if target_sym == f"{owner[0]}.{owner[1]}":
                    for sub_cmd_name, sub_fn in other_info[6].get(local_grp, []):
                        sub_key = (other_mod, sub_fn)
                        if (sub_key, sub_cmd_name) not in visited:
                            pending.append((sub_key, local_callables, sub_cmd_name, sub_key, depth + 1))

        for call in calls_in_body(function):
            key = repo.resolve(owner[0], symbol(call.func), scope_map, local_instances)
            if key and (key, subcmd) not in visited:
                _, callee_def = repo.definition(key)
                callee_callables = {}
                if callee_def:
                    pos_params = [p.arg for p in (callee_def.args.posonlyargs + callee_def.args.args)]
                    if pos_params and pos_params[0] == "self":
                        pos_params = pos_params[1:]
                    for p_name, c_arg in zip(pos_params, call.args):
                        asym = symbol(c_arg)
                        if asym in local_callables:
                            callee_callables[p_name] = local_callables[asym]
                        elif asym:
                            rf = repo.resolve(owner[0], asym, scope_map, local_instances)
                            if rf:
                                callee_callables[p_name] = rf
                pending.append((key, callee_callables or local_callables, subcmd, subcmd_fn_key, depth + 1))
            for arg in call.args:
                arg_sym = symbol(arg)
                arg_key = repo.resolve(owner[0], arg_sym, scope_map, local_instances) if arg_sym else None
                if arg_key and (arg_key, subcmd) not in visited:
                    pending.append((arg_key, local_callables, subcmd, subcmd_fn_key, depth + 1))

    raw_jobs.sort(key=lambda job: job.pop("_rank"), reverse=True)

    # Deduplicate redundant fan-outs from the exact same internal producer AND prefer top-level CLI orchestrator flows over deep library helper chains!
    deduped = []
    producer_counts = {}
    used_titles = set()
    has_direct_entry_natural = any(
        j["flowSpec"]["orchestrator"]["module"] == start[0] and j["flowSpec"]["consumer"]["isNaturalRepoConsumer"]
        for j in raw_jobs
    )
    has_top_level_public = any(
        not j["flowSpec"]["producer"]["isPrivateHelper"] and j["flowSpec"]["consumer"]["isNaturalRepoConsumer"]
        for j in raw_jobs
    )

    for job in raw_jobs:
        prod_id = (
            job["flowSpec"]["cli"],
            job["flowSpec"]["subcommand"],
            job["flowSpec"]["producer"]["module"],
            job["flowSpec"]["producer"]["qualname"],
        )
        is_priv = job["flowSpec"]["producer"]["isPrivateHelper"]
        is_cons_priv = job["flowSpec"]["consumer"]["qualname"].startswith("_")
        # When direct CLI entrypoint natural flows exist, skip deep double-private internal formatting micro-helpers
        if has_direct_entry_natural and is_priv and is_cons_priv and job["flowSpec"]["orchestrator"]["module"] != start[0]:
            continue
        max_per_prod = 1 if (is_priv and has_top_level_public) else 2
        if producer_counts.get(prod_id, 0) >= max_per_prod:
            continue
        producer_counts[prod_id] = producer_counts.get(prod_id, 0) + 1

        base_title = job["title"]
        if base_title in used_titles:
            cons_q = job["flowSpec"]["consumer"]["qualname"]
            job["title"] = f"{base_title} ({cons_q})"
        used_titles.add(job["title"])
        deduped.append(job)
        if len(deduped) >= 8:
            break

    return deduped


def parse_requirements_txt(text):
    deps = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or line.startswith("-"):
            continue
        line = line.split("#", 1)[0].strip()
        if line:
            deps.append(line)
    return deps


def parse_entrypoints_and_metadata(files):
    scripts = []
    gui_scripts = []
    dependencies = []
    requires_python = None
    project_name = None
    project_version = None
    project_description = None
    project_license = None

    has_modern_manifest_deps = False
    pyproject_text = files.get("pyproject.toml", "")
    if pyproject_text:
        try:
            data = tomllib.loads(pyproject_text)
            proj = data.get("project", {}) or {}
            poetry = data.get("tool", {}).get("poetry", {}) or {}
            flit = data.get("tool", {}).get("flit", {}).get("metadata", {}) or {}
            if "dependencies" in proj or "dynamic" in proj or "name" in proj or "dependencies" in poetry or "requires" in flit:
                has_modern_manifest_deps = True

            project_name = proj.get("name") or poetry.get("name") or flit.get("module")
            project_version = proj.get("version") or poetry.get("version")
            project_description = proj.get("description") or poetry.get("description")
            lic = proj.get("license") or poetry.get("license")
            if isinstance(lic, str):
                project_license = lic
            elif isinstance(lic, dict):
                project_license = lic.get("text") or lic.get("file")
            requires_python = proj.get("requires-python") or flit.get("requires-python")

            deps = proj.get("dependencies") or []
            if isinstance(deps, list):
                dependencies.extend(str(d) for d in deps)
            flit_deps = flit.get("requires") or []
            if isinstance(flit_deps, list) and not dependencies:
                dependencies.extend(str(d) for d in flit_deps)
            poetry_deps = poetry.get("dependencies", {})
            if isinstance(poetry_deps, dict) and not dependencies:
                for k, v in poetry_deps.items():
                    if k.lower() == "python":
                        continue
                    if isinstance(v, dict) and v.get("optional"):
                        continue
                    spec_ver = v.get("version", "") if isinstance(v, dict) else (v if isinstance(v, str) else "")
                    if isinstance(spec_ver, str) and spec_ver.startswith("^"):
                        base_v = spec_ver[1:]
                        dependencies.append(f"{k}>={base_v}")
                    elif isinstance(spec_ver, str) and spec_ver[:1] in "<>=!~":
                        dependencies.append(f"{k}{spec_ver}")
                    else:
                        dependencies.append(k)

            lines_map = {}
            for idx, raw_line in enumerate(pyproject_text.splitlines(), 1):
                if "=" in raw_line and not raw_line.lstrip().startswith("#"):
                    key_part = raw_line.split("=", 1)[0].strip().strip("'\"")
                    lines_map.setdefault(key_part, idx)

            proj_scripts = (
                proj.get("scripts")
                or poetry.get("scripts")
                or data.get("tool", {}).get("flit", {}).get("scripts")
                or {}
            )
            if isinstance(proj_scripts, dict):
                for cli, target in list(proj_scripts.items())[:12]:
                    if isinstance(target, str):
                        m = SCRIPT_TARGET.match(target)
                        if m:
                            scripts.append((cli, m.group(1), m.group(2), "pyproject.toml", lines_map.get(cli, 1)))
            proj_extras = proj.get("optional-dependencies") or {}
            if isinstance(proj_extras, dict) and isinstance(proj_extras.get("cli"), list):
                for cd in proj_extras["cli"]:
                    if str(cd) not in dependencies:
                        dependencies.append(str(cd))
            proj_gui = proj.get("gui-scripts") or {}
            if isinstance(proj_gui, dict):
                gui_scripts.extend(proj_gui.keys())
        except (tomllib.TOMLDecodeError, AttributeError):
            pass

    setup_cfg = files.get("setup.cfg", "")
    if setup_cfg:
        parser = configparser.ConfigParser()
        try:
            parser.read_string(setup_cfg)
            if parser.has_section("metadata") or parser.has_section("options"):
                has_modern_manifest_deps = True
            if not project_name and parser.has_option("metadata", "name"):
                project_name = parser.get("metadata", "name").strip()
            if not project_version and parser.has_option("metadata", "version"):
                v = parser.get("metadata", "version").strip()
                if not v.startswith(("attr:", "file:")):
                    project_version = v
            if not project_description and parser.has_option("metadata", "description"):
                project_description = parser.get("metadata", "description").strip()
            if not project_license and parser.has_option("metadata", "license"):
                project_license = parser.get("metadata", "license").strip()
            if not requires_python and parser.has_option("options", "python_requires"):
                requires_python = parser.get("options", "python_requires").strip()
            if not dependencies and parser.has_option("options", "install_requires"):
                for line in parser.get("options", "install_requires").splitlines():
                    line = line.strip()
                    if line and not line.startswith("#"):
                        dependencies.append(line)
            if parser.has_option("options.extras_require", "cli"):
                for line in parser.get("options.extras_require", "cli").splitlines():
                    line = line.strip()
                    if line and not line.startswith("#") and line not in dependencies:
                        dependencies.append(line)
            if parser.has_option("options.entry_points", "console_scripts"):
                for raw in parser.get("options.entry_points", "console_scripts").splitlines():
                    if "=" in raw:
                        cli, rhs = raw.split("=", 1)
                        cli = cli.strip()
                        m = SCRIPT_TARGET.match(rhs.strip())
                        if m and not any(s[0] == cli for s in scripts):
                            scripts.append((cli, m.group(1), m.group(2), "setup.cfg", 1))
        except configparser.Error:
            pass

    setup_py = files.get("setup.py", "")
    if setup_py:
        try:
            stree = ast.parse(setup_py, filename="setup.py")
            top_consts = {}
            for stmt in stree.body:
                if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1 and isinstance(stmt.targets[0], ast.Name):
                    tname = stmt.targets[0].id
                    if isinstance(stmt.value, ast.Constant) and isinstance(stmt.value.value, str):
                        top_consts[tname] = stmt.value.value
                    elif isinstance(stmt.value, (ast.List, ast.Tuple)):
                        elts = [e.value for e in stmt.value.elts if isinstance(e, ast.Constant) and isinstance(e.value, str)]
                        if elts:
                            top_consts[tname] = elts
            for node in ast.walk(stree):
                if isinstance(node, ast.Call) and (symbol(node.func) or "").endswith("setup"):
                    for kw in node.keywords:
                        if kw.arg == "name" and not project_name:
                            project_name = const_str(kw.value) or (
                                top_consts.get(kw.value.id) if isinstance(kw.value, ast.Name) and isinstance(top_consts.get(kw.value.id), str) else None
                            )
                        elif kw.arg == "version" and not project_version:
                            project_version = const_str(kw.value) or (
                                top_consts.get(kw.value.id) if isinstance(kw.value, ast.Name) and isinstance(top_consts.get(kw.value.id), str) else None
                            )
                        elif kw.arg == "description" and not project_description:
                            project_description = const_str(kw.value)
                        elif kw.arg == "install_requires" and not dependencies:
                            has_modern_manifest_deps = True
                            if isinstance(kw.value, (ast.List, ast.Tuple)):
                                for elt in kw.value.elts:
                                    if const_str(elt):
                                        dependencies.append(const_str(elt))
                            elif isinstance(kw.value, ast.Name) and isinstance(top_consts.get(kw.value.id), list):
                                dependencies.extend(top_consts[kw.value.id])
                        elif kw.arg == "entry_points" and isinstance(kw.value, ast.Dict):
                            for k, v in zip(kw.value.keys, kw.value.values):
                                if const_str(k) == "console_scripts" and isinstance(v, (ast.List, ast.Tuple)):
                                    for elt in v.elts:
                                        sval = const_str(elt)
                                        if sval and "=" in sval:
                                            cli, rhs = sval.split("=", 1)
                                            m = SCRIPT_TARGET.match(rhs.strip())
                                            if m and not any(s[0] == cli.strip() for s in scripts):
                                                scripts.append((cli.strip(), m.group(1), m.group(2), "setup.py", elt.lineno))
        except SyntaxError:
            pass

    if not dependencies and not has_modern_manifest_deps and "requirements.txt" in files:
        dependencies.extend(parse_requirements_txt(files["requirements.txt"]))

    if not scripts:
        for path, text in sorted(files.items()):
            if path.endswith("/__main__.py"):
                mod = path_to_module(path)
                pkg = mod[:-9] if mod.endswith(".__main__") else mod
                try:
                    mtree = ast.parse(text, filename=path)
                    fn_names = [n.name for n in mtree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]
                    chosen = "main" if "main" in fn_names else ("run" if "run" in fn_names else (fn_names[0] if fn_names else None))
                    if chosen:
                        scripts.append((f"python -m {pkg}", mod, chosen, path, 1))
                    else:
                        # Module-level execution calling an imported `main()` inside `if __name__ == "__main__":`
                        for node in ast.walk(mtree):
                            if isinstance(node, ast.Call):
                                csym = symbol(node.func)
                                if csym and csym.split(".")[-1] in ("main", "cli", "run"):
                                    scripts.append((f"python -m {pkg}", mod, csym, path, node.lineno))
                                    break
                except SyntaxError:
                    pass

    return {
        "name": project_name,
        "version": project_version or "0.0.0",
        "description": project_description,
        "license": project_license,
        "requiresPython": requires_python,
        "dependencies": dependencies,
        "scripts": scripts,
        "guiScripts": gui_scripts,
    }


def evaluate_support(meta, jobs, py_file_count):
    reasons = []
    if py_file_count == 0:
        return {
            "supported": False,
            "code": "NO_PYTHON_SOURCE",
            "reason": "Bu depoda incelenebilir Python kaynak dosyası bulunamadı.",
            "nextStep": "Herkese açık bir Python komut satırı (CLI) deposu bağlantısı verin veya JS/TS kaynakları için statik inceleme sonuçlarına bakın.",
        }
    for dep in meta["dependencies"]:
        # Ignore Windows-only conditional dependencies such as `colorama; sys_platform == "win32"` when checking Linux blocks!
        marker_part = dep.split(";", 1)[1].lower() if ";" in dep else ""
        if "win32" in marker_part and "linux" not in marker_part and "!=" not in marker_part:
            continue
        m = DEP_NAME_RE.match(dep)
        if not m:
            continue
        dep_key = m.group(1).lower().replace("-", "").replace("_", "")
        for bad, msg in UNSUPPORTED_DEPS.items():
            if dep_key == bad.replace("-", "").replace("_", ""):
                reasons.append(msg)
    if meta["guiScripts"] and not meta["scripts"]:
        reasons.append("Bu depo yalnızca grafik pencere (GUI) komutu tanımlıyor; yalıtılmış CLI laboratuvarında pencere arayüzü çalıştırılmaz.")
    if reasons:
        return {
            "supported": False,
            "code": "UNSUPPORTED_ENVIRONMENT",
            "reason": " ".join(reasons),
            "nextStep": "Ağ ve grafik arayüz gerektirmeyen, standart girdi veya dosya ile çalışan bir Python CLI deposu seçin.",
        }
    if not meta["scripts"]:
        return {
            "supported": False,
            "code": "NO_CLI_ENTRYPOINT",
            "reason": "Bu Python deposunda çalıştırılabilir bir komut satırı girişi (`[project.scripts]`, `console_scripts` veya `__main__.py`) bulunamadı; yalnızca kütüphane olarak tasarlanmış olabilir.",
            "nextStep": "Statik kod kanıtlarını inceleyebilir veya doğrudan komut satırı girişi olan bir Python aracı seçebilirsiniz.",
        }
    if not jobs:
        return {
            "supported": False,
            "code": "NO_VERIFIED_FLOW",
            "reason": "Komut girişi bulundu ancak üretici işlevden sonraki tüketici adıma geçen doğrulanabilir bir iç veri akışı AST ile kanıtlanamadı.",
            "nextStep": "Ürün görmediği akışı uydurmaz; kaynak dosyalarını statik olarak inceleyebilir veya açık veri dönüşümü yapan bir CLI aracı deneyebilirsiniz.",
        }
    return {
        "supported": True,
        "code": "SUPPORTED_PYTHON_CLI",
        "reason": "Herkese açık Python CLI girişi ve üretici → tüketici veri akışı kaynak kodda doğrulandı; WSL2 + Bubblewrap (ağ kapalı) yalıtımında denenebilir.",
        "nextStep": "Bir işi seçip A ve B girdileriyle gerçek yalıtılmış denemeyi çalıştırabilirsiniz.",
    }


def analyze(data):
    raw_files = {item["name"]: item["text"] for item in data.get("files", []) if "name" in item and "text" in item}
    meta = parse_entrypoints_and_metadata(raw_files)
    py_files = {k: v for k, v in raw_files.items() if k.endswith(".py")}
    repo = Repository(py_files)
    jobs = {}

    for cli, module, target_attr, mpath, mline in meta["scripts"][:12]:
        record = repo.read(module)
        if not record:
            continue
        start_key = (module, target_attr) if target_attr in record[1] else repo.resolve(module, target_attr, {})
        if start_key and repo.definition(start_key)[1] is not None:
            for job in find_jobs(repo, cli, start_key, mpath, mline, raw_files):
                jobs.setdefault(job["id"], job)

    limitations = [f"{path} Python olarak ayrıştırılamadı." for path in repo.errors[:5]]
    if meta["scripts"] and not jobs:
        limitations.append("Python komut tanımı bulundu. Çıktıyı hangi sonraki adımın kullandığı kaynakta doğrulanamadı.")
    elif not meta["scripts"] and py_files:
        limitations.append("Python komut tanımları okunamadı veya bu depo bir CLI komutu tanımlamıyor.")

    manifest_used = [m for m in ("pyproject.toml", "setup.cfg", "setup.py", "requirements.txt") if m in raw_files]
    analyzed = [*manifest_used, *dict.fromkeys(record[0] for record in repo.parsed.values() if record)]
    job_list = list(jobs.values())[:10]
    support = evaluate_support(meta, job_list, len(py_files))

    return {
        "jobs": job_list,
        "analyzedPaths": analyzed,
        "limitations": limitations,
        "pythonMeta": {
            "name": meta["name"],
            "version": meta["version"],
            "description": meta["description"],
            "license": meta["license"],
            "requiresPython": meta["requiresPython"],
            "dependencies": meta["dependencies"],
            "entrypoints": [
                {"cli": c, "module": m, "callable": fn, "manifest": mp, "line": ml}
                for c, m, fn, mp, ml in meta["scripts"]
            ],
            "support": support,
        },
    }


if __name__ == "__main__":
    print(json.dumps(analyze(json.load(sys.stdin))))
