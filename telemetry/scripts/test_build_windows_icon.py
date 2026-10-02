#!/usr/bin/env python3
"""Verify the pinned Pillow generator reproduces the committed Windows icon."""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_windows_icon


class WindowsIconReproducibilityTest(unittest.TestCase):
    def test_generator_reproduces_committed_icon_byte_for_byte(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            generated = Path(directory) / "verselink.ico"
            build_windows_icon.generate_icon(generated)
            self.assertEqual(
                generated.read_bytes(), build_windows_icon.OUTPUT.read_bytes()
            )


if __name__ == "__main__":
    unittest.main()
