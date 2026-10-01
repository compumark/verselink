#!/usr/bin/env python3
"""Create a deterministic portable ZIP for the Windows telemetry tray app."""

import argparse
import pathlib
import zipfile


FIXED_TIME = (1980, 1, 1, 0, 0, 0)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--exe", required=True, type=pathlib.Path)
    parser.add_argument("--instructions", required=True, type=pathlib.Path)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    args = parser.parse_args()

    if not args.exe.is_file() or not args.instructions.is_file():
        raise SystemExit("release input file is missing")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    entries = [
        ("verselink-telemetry.exe", args.exe),
        ("INSTALLATION.txt", args.instructions),
    ]
    # Stored members avoid zlib-version-dependent deflate output and make the
    # archive bytes reproducible across builder environments.
    with zipfile.ZipFile(args.output, "w", compression=zipfile.ZIP_STORED, strict_timestamps=True) as archive:
        for name, source in entries:
            info = zipfile.ZipInfo(name, date_time=FIXED_TIME)
            info.compress_type = zipfile.ZIP_STORED
            info.create_system = 3
            info.external_attr = (0o100644 & 0xFFFF) << 16
            info.flag_bits = 0
            archive.writestr(info, source.read_bytes(), compress_type=zipfile.ZIP_STORED)


if __name__ == "__main__":
    main()
