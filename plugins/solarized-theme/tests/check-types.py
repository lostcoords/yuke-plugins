#!/usr/bin/env python3
"""Check the plugin and native probe against one Yuke SDK without changing a profile."""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--types-dir', type=Path, default=Path.home() / '.local/lib/yuke/types')
    args = parser.parse_args()
    sdk = args.types_dir.resolve(strict=True)
    plugin = Path(__file__).resolve().parents[1]
    files = [sdk / 'yuke.d.ts', sdk / 'yuke-modules.d.ts', plugin / 'index.js', plugin / 'tests/probe.js']
    with tempfile.TemporaryDirectory(prefix='solarized-types-') as directory:
        config = Path(directory) / 'tsconfig.json'
        config.write_text(json.dumps({
            'compilerOptions': {
                'allowJs': True, 'checkJs': True, 'noEmit': True, 'strict': True,
                'module': 'esnext', 'moduleResolution': 'bundler', 'target': 'es2022',
                'lib': ['esnext'], 'types': [],
            },
            'files': [str(path) for path in files],
        }))
        subprocess.run(['tsc', '-p', str(config)], check=True)
    print('PASS Solarized and native probe types against', sdk)


if __name__ == '__main__':
    main()
