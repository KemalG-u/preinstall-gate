"""Read explicit GitHub Actions output paths without evaluating YAML or shell."""

import json
import re
import sys

import yaml
from yaml.events import AliasEvent, CollectionEndEvent, CollectionStartEvent, NodeEvent
from yaml.nodes import MappingNode, ScalarNode, SequenceNode


MAX_FILE = 128 * 1024
MAX_FILES = 16
MAX_INPUT = MAX_FILES * (MAX_FILE * 6 + 1024)
MAX_JOBS = 100
MAX_LINKS = 256
ID = r"[A-Za-z_][A-Za-z0-9_-]{0,127}"
NEEDS_OUTPUT = re.compile(rf"needs\.({ID})\.outputs\.({ID})")
STEP_OUTPUT = re.compile(rf"\$\{{\{{\s*steps\.({ID})\.outputs\.({ID})\s*\}}\}}")
WRITE_OUTPUT = re.compile(
    rf"[ \t]*(?:echo[ \t]+|printf[ \t]+'%s\\n'[ \t]+)"
    rf"(?P<quote>['\"])(?P<key>{ID})=[A-Za-z0-9_. /:@,+-]*(?P=quote)"
    r'[ \t]+>>[ \t]+(?:"\$GITHUB_OUTPUT"|\$GITHUB_OUTPUT|"\$\{GITHUB_OUTPUT\}")[ \t]*'
)


class Unsupported(ValueError):
    pass


def mapping(node):
    if isinstance(node, MappingNode):
        return {key.value: (key, value) for key, value in node.value}
    return {}


def value(fields, key):
    return fields.get(key, (None, None))[1]


def scalar(node):
    return node.value if isinstance(node, ScalarNode) else ""


def line(node):
    return node.start_mark.line + 1


def label(text):
    return " ".join(text.split())[:160]


def ids(node):
    if isinstance(node, MappingNode):
        items = list(mapping(node))
    elif isinstance(node, SequenceNode):
        items = [scalar(item) for item in node.value]
    else:
        items = [scalar(node)]
    return list(dict.fromkeys(item for item in items if re.fullmatch(ID, item)))


def read_yaml(text):
    depth = 0
    for count, event in enumerate(yaml.parse(text, Loader=yaml.BaseLoader), start=1):
        if isinstance(event, AliasEvent) or (isinstance(event, NodeEvent) and event.anchor):
            raise Unsupported("YAML çapası veya takma adı bulunan dosya çözümlenemedi.")
        if getattr(event, "tag", None):
            raise Unsupported("Özel YAML etiketi bulunan dosya çözümlenemedi.")
        depth += isinstance(event, CollectionStartEvent) - isinstance(event, CollectionEndEvent)
        if count > 12000 or depth > 32:
            raise Unsupported("YAML yapısı inceleme sınırını aştı.")

    root = yaml.compose(text, Loader=yaml.BaseLoader)
    pending = [root]
    while pending:
        node = pending.pop()
        if isinstance(node, SequenceNode):
            pending.extend(node.value)
        if not isinstance(node, MappingNode):
            continue
        seen = set()
        for key, child in node.value:
            if not isinstance(key, ScalarNode) or key.value == "<<":
                raise Unsupported("Birleştirilmiş veya karmaşık YAML anahtarı çözümlenemedi.")
            if key.value in seen:
                raise Unsupported("Aynı YAML alanı birden çok kez tanımlanmış.")
            seen.add(key.value)
            pending.append(child)
    return root


def expressions(text):
    """Yield complete expressions, ignoring delimiters in single-quoted literals."""
    cursor = 0
    while (start := text.find("${{", cursor)) >= 0:
        cursor = start + 3
        in_string = False
        while cursor < len(text):
            if text[cursor] == "'":
                if in_string and text.startswith("''", cursor):
                    cursor += 2
                    continue
                in_string = not in_string
            elif not in_string and text.startswith("}}", cursor):
                yield text[start + 3:cursor].strip()
                cursor += 2
                break
            cursor += 1


def script_expressions(text):
    """Check expressions on command lines, leaving shell comments out of the graph."""
    for script_line in text.splitlines():
        quote = None
        escaped = False
        for offset, char in enumerate(script_line):
            if escaped:
                escaped = False
            elif char == "\\" and quote != "'":
                escaped = True
            elif char in ("'", '"') and (not quote or char == quote):
                quote = None if quote else char
            elif not quote and char == "#" and (offset == 0 or script_line[offset - 1].isspace()):
                script_line = script_line[:offset]
                break
        yield from expressions(script_line)


def steps(fields):
    items = value(fields, "steps")
    if isinstance(items, SequenceNode):
        return [mapping(item) for item in items.value if isinstance(item, MappingNode)]
    return []


def job_shape(fields):
    runner = value(fields, "runs-on")
    return bool(scalar(runner) or isinstance(runner, (SequenceNode, MappingNode)) or scalar(value(fields, "uses")))


def references(fields, direct_fields, map_fields, step=None):
    prefix = "steps." if step is not None else ""
    for name in direct_fields:
        if name in fields:
            key, node = fields[name]
            content = scalar(node)
            found = script_expressions(content) if name == "run" else expressions(content)
            if name == "if" and "${{" not in content:
                found = [content.strip()]
            for expression in found:
                if match := NEEDS_OUTPUT.fullmatch(expression):
                    yield (*match.groups(), prefix + name, step, line(key))
    for name in map_fields:
        for item, (key, node) in mapping(value(fields, name)).items():
            if not re.fullmatch(ID, item):
                continue
            for expression in expressions(scalar(node)):
                if match := NEEDS_OUTPUT.fullmatch(expression):
                    yield (*match.groups(), prefix + name + "." + item, step, line(key))


def write_line(run_node, target, source_lines):
    commands = [item for item in scalar(run_node).splitlines() if item.strip()]
    if len(commands) != 1:
        return None
    match = WRITE_OUTPUT.fullmatch(commands[0])
    if not match or match["key"] != target:
        return None
    if run_node.style != "|":
        return line(run_node)
    for offset in range(line(run_node), run_node.end_mark.line):
        if offset < len(source_lines) and source_lines[offset].strip() == commands[0].strip():
            return offset + 1
    return None


def default_shell(fields):
    return scalar(value(mapping(value(mapping(value(fields, "defaults")), "run")), "shell"))


def output_mapping(fields, workflow_shell, source_lines):
    if scalar(value(fields, "uses")):
        return {}
    by_step = {}
    for step in steps(fields):
        step_id = scalar(value(step, "id"))
        if not step_id:
            continue
        if step_id in by_step:
            return {}
        by_step[step_id] = step

    outputs = {}
    for output, (key, node) in mapping(value(fields, "outputs")).items():
        match = STEP_OUTPUT.fullmatch(scalar(node).strip())
        if not match or not re.fullmatch(ID, output):
            continue
        step_id, step_output = match.groups()
        producer = by_step.get(step_id, {})
        run = value(producer, "run")
        if not (scalar(run) or scalar(value(producer, "uses"))):
            continue
        shell = scalar(value(producer, "shell")) or default_shell(fields) or workflow_shell
        runner = scalar(value(fields, "runs-on"))
        posix = shell in ("bash", "sh") or (not shell and re.fullmatch(r"(?:ubuntu|macos)-[\w.-]+", runner))
        outputs[output] = (line(key), step_id, write_line(run, step_output, source_lines) if posix else None)
    return outputs


def valid_dependencies(jobs):
    """Resolve only jobs whose entire declared dependency chain is present and acyclic."""
    pending = {job["id"]: set(job["needs"]) for job in jobs}
    valid = set()
    while ready := [job_id for job_id, needs in pending.items() if needs <= valid]:
        valid.update(ready)
        for job_id in ready:
            pending.pop(job_id)
    return valid


def workflow(text):
    if len(text.encode("utf-8")) > MAX_FILE:
        raise Unsupported("YAML dosyası 128 KiB sınırını aşıyor.")
    root = mapping(read_yaml(text))
    triggers = ids(value(root, "on"))
    definitions = mapping(value(root, "jobs"))
    if not triggers or not definitions:
        raise Unsupported("GitHub Actions tetikleyicisi ve iş tanımı birlikte bulunamadı.")
    limitations = ["Bağlar YAML tanımından okundu. Akış, koşullar ve komutlar çalıştırılmadı."]
    if len(definitions) > MAX_JOBS:
        limitations.append(f"İlk {MAX_JOBS} iş incelendi.")
    source_lines = text.splitlines()
    jobs, links, mappings = [], [], {}
    selected = list(definitions.items())[:MAX_JOBS]
    for job_id, (key, node) in selected:
        fields = mapping(node)
        if not re.fullmatch(ID, job_id) or not fields:
            continue
        needs = value(fields, "needs")
        runner = value(fields, "runs-on")
        jobs.append({"id": job_id, "line": line(key), "name": label(scalar(value(fields, "name"))),
                     "runner": label(scalar(runner) or ", ".join(ids(runner))),
                     "needs": ids(needs) if isinstance(needs, (SequenceNode, ScalarNode)) else [],
                     "outputs": list(mapping(value(fields, "outputs"))), "consumes": []})
        if job_shape(fields):
            mappings[job_id] = output_mapping(fields, default_shell(root), source_lines)

    if not jobs:
        raise Unsupported("YAML içinde okunabilir iş tanımı bulunamadı.")
    valid_jobs = valid_dependencies(jobs)
    unresolved = False
    for job in jobs:
        fields = mapping(definitions[job["id"]][1])
        reusable = bool(scalar(value(fields, "uses")))
        usage = list(references(fields, ("if", "runs-on", "continue-on-error", "timeout-minutes"),
                                ("with",) if reusable else ("env",)))
        if not reusable:
            for index, step in enumerate(steps(fields), start=1):
                is_action = bool(scalar(value(step, "uses")))
                if not is_action and not scalar(value(step, "run")):
                    continue
                step_label = label(scalar(value(step, "name")) or scalar(value(step, "id"))) or f"Adım {index}"
                step_fields = ("if", "continue-on-error", "timeout-minutes") if is_action else (
                    "if", "run", "working-directory", "continue-on-error", "timeout-minutes")
                usage.extend(references(step, step_fields, ("env", "with") if is_action else ("env",), step_label))

        job["consumes"] = list(dict.fromkeys(f"{origin}.{output}" for origin, output, _, _, _ in usage))
        for origin, output, field, step, target_line in dict.fromkeys(usage):
            binding = mappings.get(origin, {}).get(output)
            if not (job_shape(fields) and job["id"] in valid_jobs and origin in job["needs"] and binding):
                unresolved = True
                continue
            if len(links) == MAX_LINKS:
                if "Bağ sayısı inceleme sınırına ulaştı." not in limitations:
                    limitations.append("Bağ sayısı inceleme sınırına ulaştı.")
                break
            source_line, producer, producer_line = binding
            links.append({"from": origin, "to": job["id"], "output": output, "field": field, "step": step,
                          "line": target_line, "sourceLine": source_line, "producerStep": producer,
                          "producerLine": producer_line})
    if unresolved:
        limitations.append("Bazı çıktı başvurularında üretici adım, çıktı tanımı veya doğrudan iş bağı bulunamadı.")
    if any(scalar(value(mapping(node), "uses")) for _, (_, node) in selected):
        limitations.append("Çağrılan başka iş akışlarının içindeki üretim ve çıktı bağları izlenmedi.")
    limitations.append("Dolaylı başvurular ve birden fazla işlem içeren ifadeler kapsam dışında.")
    return {"triggers": triggers, "jobs": jobs, "links": links, "limitations": limitations}


def main():
    raw = sys.stdin.buffer.read(MAX_INPUT + 1)
    if len(raw) > MAX_INPUT:
        return 2
    files = json.loads(raw)
    if not isinstance(files, list) or len(files) > MAX_FILES:
        return 2
    results = {}
    for file in files:
        try:
            results[file["name"]] = {"graph": workflow(file["text"])}
        except Unsupported as error:
            results[file["name"]] = {"graph": None, "reason": str(error)}
        except yaml.YAMLError:
            results[file["name"]] = {"graph": None, "reason": "YAML yapısı okunamadı."}
    print(json.dumps(results, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
