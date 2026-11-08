#!/usr/bin/env python3
"""Package Vivaldi builds with a stable download name and no wrapper folder."""
import argparse
import hashlib
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parent.parent
ARCHIVE_NAME = 'Shieldmonkey-vivaldi.zip'
EXCLUDED = {'_metadata', '_locales', '.vite', '.DS_Store'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', type=Path, default=ROOT / 'releases')
    args = parser.parse_args()
    source = ROOT / 'dist-vivaldi'
    manifest = json.loads((source / 'manifest.json').read_text())
    if ('default_locale' in manifest or '__MSG_' in json.dumps(manifest)
            or manifest.get('action', {}).get('default_popup') != 'popup.html'):
        raise SystemExit('Run build:vivaldi before packaging.')

    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    output = output_dir / ARCHIVE_NAME
    temporary = output.with_suffix('.zip.tmp')
    try:
        with zipfile.ZipFile(temporary, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for path in sorted(source.rglob('*')):
                relative = path.relative_to(source)
                if any(part in EXCLUDED for part in relative.parts):
                    continue
                if path.is_symlink():
                    raise SystemExit(f'Unexpected symlink in build: {relative}')
                if path.is_dir():
                    archive.writestr(relative.as_posix() + '/', b'')
                else:
                    archive.write(path, relative.as_posix())
            archive.write(ROOT / 'docs/vivaldi-update-ja.txt', 'INSTALL-ja.txt')
        with zipfile.ZipFile(temporary) as archive:
            if archive.testzip() is not None or 'manifest.json' not in archive.namelist():
                raise SystemExit('Invalid Vivaldi archive.')
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    output.with_suffix('.zip.sha256').write_text(f'{digest}  {ARCHIVE_NAME}\n')
    print(f'{output} (version {manifest["version"]})')


if __name__ == '__main__':
    main()
