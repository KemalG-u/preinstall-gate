"""Read a bounded file-selection and move declaration from YAML or Markdown."""

import importlib.util
import json
import re
import sys
from pathlib import Path

from yaml import YAMLError
from yaml.nodes import MappingNode, ScalarNode, SequenceNode


spec = importlib.util.spec_from_file_location("workflow_yaml", Path(__file__).with_name("workflow-analiz.py"))
yaml_reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(yaml_reader)

MAX_FILE = 96 * 1024
MAX_FILES = 12
MAX_RULES = 12
FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})([^`~\r\n]*)$")
EXTENSION = re.compile(r"\.?[A-Za-z0-9][A-Za-z0-9_+-]{0,11}\Z")
DEVICE = re.compile(r"(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)", re.I)
CONTINUATION = re.compile(r"\badd\b[^.!?\n]{0,100}\bmove(?:[- ]action)?\b[^.!?\n]{0,90}\b(?:to|into|under|in)\b[^.!?\n]{0,50}\brule\b", re.I)


def fields(node, allowed):
    if not isinstance(node, MappingNode):
        return None
    result = {key.value: (key, value) for key, value in node.value}
    return result if result.keys() <= allowed else None


def val(items, key):
    return items.get(key, (None, None))[1]


def scalar(node):
    return node.value if isinstance(node, ScalarNode) else None


def values(node):
    return node.value if isinstance(node, SequenceNode) else [node]


def boolean(node, default):
    if node is None:
        return default
    value = (scalar(node) or "").lower()
    # BaseLoader exposes both plain and quoted values. A deliberately narrow
    # subset keeps typed declarations consistent with the upstream schema.
    if value == "true":
        return True
    if value == "false":
        return False
    raise ValueError("unsupported boolean")


def location(value, folder=False):
    if not value or len(value) > 140 or re.search(r'[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069{}$%<>:"|?*]', value):
        return None
    value = value.replace("\\", "/")
    if value.startswith("/") or (folder and not value.endswith("/")):
        return None
    value = value.removesuffix("/")
    parts = value.split("/")
    if any(not part or part in {".", ".."} or part.strip() != part or part.endswith(".") or DEVICE.match(part) for part in parts):
        return None
    if any("~" in part and (part != "~" or index != 0) for index, part in enumerate(parts)):
        return None
    if parts == ["~"]:
        return None
    return value


def position(node, offset):
    return offset + node.start_mark.line + 1


def actions(node, offset):
    if not isinstance(node, SequenceNode) or not 1 <= len(node.value) <= 5:
        return None
    result = []
    for item in node.value:
        action = fields(item, {"echo", "move"})
        if action is None or len(action) != 1:
            return None
        name, (key, value) = next(iter(action.items()))
        value = scalar(value)
        if name == "move":
            value = location(value, folder=True)
        if not value or len(value) > 140 or any(char in value for char in "{}\r\n\0"):
            return None
        result.append((name, value, position(key, offset)))
    if [name for name, _, _ in result].count("move") > 1 or any(item[0] == "move" for item in result[:-1]):
        return None
    return result


def selection(node, offset):
    if not isinstance(node, SequenceNode) or not 1 <= len(node.value) <= 2:
        return None
    result = {}
    for item in node.value:
        filt = fields(item, {"extension", "name"})
        if filt is None or len(filt) != 1:
            return None
        name, (key, value) = next(iter(filt.items()))
        if name in result:
            return None
        if name == "extension":
            items = (scalar(value) or "").split() if isinstance(value, ScalarNode) else [scalar(v) for v in values(value)]
            if not 1 <= len(items) <= 8 or any(not item or not EXTENSION.fullmatch(item) for item in items):
                return None
            result[name] = (list(dict.fromkeys(item.lower().removeprefix(".") for item in items)), position(key, offset))
        else:
            options = fields(value, {"contains", "case_sensitive"})
            if options is None or "contains" not in options:
                return None
            tokens = [scalar(v) for v in values(val(options, "contains"))]
            if not 1 <= len(tokens) <= 8 or any(not token or token.strip() != token or not token.isascii() or not re.fullmatch(r"[\w -]{1,36}", token) for token in tokens):
                return None
            result[name] = ({"tokens": tokens, "caseSensitive": boolean(val(options, "case_sensitive"), True)}, position(key, offset))
    return result if "extension" in result else None


def read_rule(node, offset):
    items = fields(node, {"name", "enabled", "locations", "subfolders", "targets", "filters", "filter_mode", "actions"})
    if not items or not boolean(val(items, "enabled"), True):
        return None
    if ("targets" in items and scalar(val(items, "targets")) != "files") or ("filter_mode" in items and scalar(val(items, "filter_mode")) != "all"):
        return None
    paths = values(val(items, "locations"))
    if len(paths) != 1:
        return None
    source = location(scalar(paths[0]))
    filt = selection(val(items, "filters"), offset)
    steps = actions(val(items, "actions"), offset)
    if not source or not filt or not steps:
        return None
    return {"source": source, "recursive": boolean(val(items, "subfolders"), False), "filters": filt,
            "actions": steps, "locationLine": position(items["locations"][0], offset)}


def yaml_block(text, offset):
    root = yaml_reader.read_yaml(text)
    config = fields(root, {"rules"})
    if config and isinstance(val(config, "rules"), SequenceNode):
        return "rules", [rule for node in val(config, "rules").value[:MAX_RULES] if (rule := read_rule(node, offset))]
    fragment = fields(root, {"actions"})
    if fragment:
        return "actions", actions(val(fragment, "actions"), offset)
    return None, None


def markdown_blocks(text):
    lines = text.splitlines()
    opener = None
    in_comment = False
    for index, line in enumerate(lines):
        if opener:
            start, mark, is_yaml = opener
            ending = line.lstrip(" ")
            if len(line) - len(ending) <= 3 and len(ending.rstrip()) >= len(mark) and set(ending.rstrip()) == {mark[0]}:
                if is_yaml:
                    yield "\n".join(lines[start + 1:index]), start + 1, index
                opener = None
            continue
        if in_comment or "<!--" in line:
            start_comment = 0 if in_comment else line.index("<!--") + 4
            in_comment = line.find("-->", start_comment) == -1
            continue
        match = FENCE.fullmatch(line)
        if match:
            language = match[2].strip().lower()
            opener = index, match[1], language in {"yaml", "yml"}


def applicable(rule):
    return rule["actions"][-1][0] == "move" and rule["source"].lower() != rule["actions"][-1][1].lower()


def continuation(rule, steps):
    return bool(steps and steps[-1][0] == "move" and [step[:2] for step in rule["actions"]] == [step[:2] for step in steps[:-1]])


def parse_file(file):
    text = file["text"]
    if len(text.encode("utf8")) > MAX_FILE:
        return []
    path = file["name"]
    if re.search(r"\.ya?ml$", path, re.I):
        kind, rules = yaml_block(text, 0)
        return [rule for rule in rules if applicable(rule)] if kind == "rules" else []
    result = []
    lines = text.splitlines()
    pending = None
    for text, start, end in markdown_blocks(text):
        try:
            kind, content = yaml_block(text, start)
        except (ValueError, YAMLError):
            pending = None
            continue
        if kind == "actions" and pending:
            rule, previous_end = pending
            between = lines[previous_end + 1:start - 1]
            same_section = len(between) <= 22 and not any(line.lstrip().startswith("#") for line in between)
            if same_section and CONTINUATION.search("\n".join(between)) and continuation(rule, content):
                combined = {**rule, "actions": content, "continuationLine": previous_end + 2 + next(index for index, line in enumerate(between) if CONTINUATION.search(line))}
                if applicable(combined):
                    result.append(combined)
        pending = None
        if kind == "rules":
            result.extend(rule for rule in content if applicable(rule))
            if len(content) == 1 and not any(step[0] == "move" for step in content[0]["actions"]):
                pending = content[0], end
        if len(result) >= MAX_RULES:
            break
    return result[:MAX_RULES]


def main():
    max_input = 6 * MAX_FILES * MAX_FILE + 16 * 1024
    raw = sys.stdin.buffer.read(max_input + 1)
    if len(raw) > max_input:
        return 2
    files = json.loads(raw)
    if not isinstance(files, list) or len(files) > MAX_FILES:
        return 2
    output = []
    for file in files:
        try:
            output.extend({"path": file["name"], **rule} for rule in parse_file(file))
        except (ValueError, YAMLError):
            continue
    print(json.dumps(output, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
