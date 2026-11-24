"""Run the reviewed Gitingest CLI on the trial directory, with an offline tokenizer."""

import asyncio
import hashlib
import io
import os
import re
import runpy
import sys
import zipfile
from pathlib import Path


SOURCE_SHA256 = "993157ba94075ef20a21538cb4191cb05d2835a09c8574036af350aa3cd9054e"
SOURCE_NAME = re.compile(r"[^/]+/src/(gitingest/(?:[A-Za-z_]\w*/)*[A-Za-z_]\w*\.py)", re.ASCII)
HASH = re.compile(r'--hash=sha256:([\da-f]{64})')


def reject_external_effects(event, args):
    if event == 'socket.connect' or event == 'socket.getaddrinfo' or event in (
        'subprocess.Popen', 'os.system', 'os.posix_spawn', 'os.startfile', 'os.exec', 'os.spawn',
    ):
        raise PermissionError('Local example has no network or external processes.')


class LocalLoopPolicy(asyncio.DefaultEventLoopPolicy):
    def __init__(self):
        super().__init__()
        # Windows creates a private loopback socket pair for this event loop.
        self.loop = super().new_event_loop()

    def new_event_loop(self):
        loop, self.loop = self.loop, None
        if loop is None:
            return super().new_event_loop()
        return loop


def expand_wheels(wheels, lock):
    hashes = set(HASH.findall(lock.read_text(encoding='utf-8')))
    destination = Path('dependencies')
    destination.mkdir()
    for wheel in sorted(wheels.glob('*.whl')):
        if wheel.is_symlink() or not wheel.is_file() or wheel.stat().st_size > 10 * 1024 * 1024:
            raise ValueError('Invalid dependency archive')
        archive = wheel.read_bytes()
        sha = hashlib.sha256(archive).hexdigest()
        if sha not in hashes:
            raise ValueError('Dependency checksum mismatch')
        hashes.remove(sha)
        with zipfile.ZipFile(io.BytesIO(archive)) as package:
            for member in package.infolist():
                if member.is_dir() or '.data/' in member.filename:
                    continue
                package.extract(member, destination)
    if hashes:
        raise ValueError('Dependency archives missing')
    return destination.resolve()


def main():
    source, wheels, lock = map(Path, sys.argv[1:])
    dependency_dir = expand_wheels(wheels, lock)
    archive = source.read_bytes()
    if hashlib.sha256(archive).hexdigest() != SOURCE_SHA256:
        raise ValueError('Source checksum mismatch')
    with zipfile.ZipFile(io.BytesIO(archive)) as package:
        for name in package.namelist():
            match = SOURCE_NAME.fullmatch(name)
            if match:
                target = Path('code', match[1])
                target.parent.mkdir(parents=True, exist_ok=True)
                with target.open('xb') as handle:
                    handle.write(package.read(name))
    sys.path[:0] = [str(Path('code').resolve()), str(dependency_dir)]
    # The CLI reads only this fixed sample. A missing tokenizer file cannot trigger a download.
    os.environ['GIT_PYTHON_REFRESH'] = 'quiet'
    os.environ['GIT_PYTHON_GIT_EXECUTABLE'] = str(Path('unused-git').resolve())
    asyncio.set_event_loop_policy(LocalLoopPolicy())
    sys.addaudithook(reject_external_effects)
    sys.argv = ['gitingest', 'example', '-o', '-']
    runpy.run_module('gitingest', run_name='__main__', alter_sys=True)


if __name__ == '__main__':
    main()
