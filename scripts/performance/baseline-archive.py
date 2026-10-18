"""Preserve an explicitly enumerated baseline; never walk the working tree."""

import argparse
import hashlib
import json
import pathlib
import zipfile
from datetime import datetime, timezone


def digest(data):
    return hashlib.sha256(data).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True)
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    root = pathlib.Path(args.root).resolve(strict=True)
    manifest_path = pathlib.Path(args.manifest).resolve(strict=True)
    output = pathlib.Path(args.out).resolve()
    receipt = output.with_suffix(output.suffix + '.json')
    if output.exists() or receipt.exists():
        raise FileExistsError('Use a new archive and receipt path')
    manifest_bytes = manifest_path.read_bytes()
    manifest = json.loads(manifest_bytes.decode('utf-8-sig'))
    if not isinstance(manifest, list) or not 1 <= len(manifest) <= 2000:
        raise ValueError('Expected a bounded file manifest')

    files = {}
    for entry in manifest:
        relative = pathlib.PurePosixPath(entry['path'].replace('\\', '/'))
        if (relative.is_absolute() or '..' in relative.parts or not relative.parts
                or any(part in {'node_modules', '.git', 'dist', 'data'} for part in relative.parts)
                or any(part.startswith('.env') for part in relative.parts)
                or ':' in str(relative)):
            raise ValueError(f'Unsupported baseline member: {relative}')
        name = str(relative)
        if name in files:
            raise ValueError(f'Duplicate member: {name}')
        source = root.joinpath(*relative.parts).resolve(strict=True)
        if not source.is_relative_to(root) or not source.is_file():
            raise ValueError(f'Member leaves the baseline: {name}')
        body = source.read_bytes()
        if len(body) != entry['bytes'] or digest(body) != entry['sha256']:
            raise ValueError(f'Baseline differs from its initial manifest: {name}')
        files[name] = body

    output.parent.mkdir(parents=True, exist_ok=True)
    # Archive timestamps are a constant provenance marker, not source-file mtimes.
    # No dependency junction, generated build, credentials, or arbitrary root files.
    with zipfile.ZipFile(output, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for name, body in sorted(files.items()):
            info = zipfile.ZipInfo(name, date_time=(2026, 10, 18, 15, 22, 38))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            archive.writestr(info, body, compress_type=zipfile.ZIP_DEFLATED, compresslevel=6)

    with zipfile.ZipFile(output) as archive:
        if archive.testzip() is not None or set(archive.namelist()) != set(files):
            raise ValueError('Archive member/CRC verification failed')
        for name, body in files.items():
            if archive.read(name) != body:
                raise ValueError(f'Archive byte mismatch: {name}')
            # Verify the original baseline has remained unchanged while archiving.
            if root.joinpath(*pathlib.PurePosixPath(name).parts).read_bytes() != body:
                raise ValueError(f'Source changed while archiving: {name}')
    result = {
        'version': 1, 'verifiedAt': datetime.now(timezone.utc).isoformat(),
        'root': str(root), 'manifest': str(manifest_path), 'manifestSha256': digest(manifest_bytes),
        'archive': str(output), 'archiveSha256': digest(output.read_bytes()),
        'files': len(files), 'uncompressedBytes': sum(map(len, files.values())),
        'archiveBytes': output.stat().st_size, 'exactBytesVerified': True,
        'scope': 'Initial enumerated source/assets only, including pre-session uncommitted changes. '
                 'No dependencies/build/secrets. This is not the Git base commit alone.',
        'archiveTimestampPolicy': 'All ZIP entries use the session start UTC as a constant marker.',
    }
    with receipt.open('x', encoding='utf-8') as handle:
        json.dump(result, handle, indent=2)
        handle.write('\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
