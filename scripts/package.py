"""Package source and plugin releases; whitelist files, never copy vault data.

产出两个包，均写入**本仓库目录内**，不散落到上级目录：

  obsidian-3d-mindmap-<version>-release.zip / .tar.gz   Obsidian 插件发行物
  obsidian-3d-mindmap-refresh-<version>-source.zip / .tar.gz   源码包

两个包都用白名单收件，并在打包后断言：不含 data.json、不含 _tmp/ 与
node_modules/ 前缀、不含 source map。这样私人 vault 内容、备份与凭据
不会因为打包而泄漏。
"""
from pathlib import Path
import hashlib
import json
import tarfile
import zipfile

root = Path(__file__).resolve().parent.parent
version = json.loads((root / 'manifest.json').read_text(encoding='utf-8'))['version']

release = root / f'obsidian-3d-mindmap-{version}-release'
source = root / f'obsidian-3d-mindmap-refresh-{version}-source'

common = ['README.md', 'CHANGELOG.md', 'THIRD_PARTY_NOTICES.md', 'LICENSE']
common = [name for name in common if (root / name).is_file()]

release_files = ['main.js', 'manifest.json', 'styles.css', *common]
source_files = ['package.json', 'package-lock.json', 'manifest.json', 'versions.json',
                'Cargo.toml', 'Cargo.lock', 'styles.css', '.gitignore', *common]


def directory_files(directory):
    return [str(file.relative_to(root)).replace('\\', '/') for file in (root / directory).rglob('*')
            if file.is_file() and not any(part in ('pkg', 'target', '__pycache__') for part in file.parts)]


release_files += directory_files('vendor') + directory_files('licenses') + directory_files('docs')
source_files += sum((directory_files(directory) for directory in
                     ['src', 'scripts', 'tests', 'crates', 'docs', 'vendor', 'licenses']), [])
# generated-physics.js 是 wasm-pack 产物，由 npm run build 重新生成
source_files = [name for name in source_files if name != 'src/generated-physics.js']


def assert_clean(names):
    for name in names:
        assert not name.startswith(('_tmp/', 'node_modules/')), f'forbidden entry: {name}'
        assert not name.endswith('data.json'), f'forbidden entry: {name}'
        assert not name.endswith('.map'), f'source map must not ship: {name}'


def build_zip(archive, names):
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for name in names:
            z.write(root / name, name)
    with zipfile.ZipFile(archive) as z:
        assert z.testzip() is None
        assert_clean(z.namelist())


def build_tar(archive, names, prefix):
    # prefix 必须是完整包名（不含扩展名）。不能用 Path.stem ——
    # 它对 `.tar.gz` 只去掉 `.gz`，会留下 `.tar` 变成目录名的一部分。
    with tarfile.open(archive, 'w:gz') as t:
        for name in names:
            t.add(root / name, arcname=f'{prefix}/{name}')
    with tarfile.open(archive, 'r:gz') as t:
        assert_clean(t.getnames())


results = []
for stem, names in [(release, release_files), (source, source_files)]:
    clean = sorted(set(names))
    assert_clean(clean)
    # 用字符串拼接而非 Path.with_suffix —— 版本号里的 `.0` 会被后者当成后缀吃掉
    for ext in ('.zip', '.tar.gz'):
        archive = root / f'{stem.name}{ext}'
        build_zip(archive, clean) if ext == '.zip' else build_tar(archive, clean, stem.name)
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        (root / f'{archive.name}.sha256').write_text(f'{digest}  {archive.name}\n', encoding='utf-8')
        results.append({'file': archive.name, 'files': len(clean),
                        'bytes': archive.stat().st_size, 'sha256': digest})

for item in results:
    print(json.dumps(item))