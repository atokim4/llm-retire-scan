"""Checks that the Python twin returns the same segments as Node on the files bench/boundaries.ts wrote.

    python3 bench/parity.py <out-dir>
"""

import json
import sys
from dataclasses import asdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))
import timed_transcript as tt  # noqa: E402

folder = Path(sys.argv[1])
mismatches = 0
files = sorted(folder.glob("*.wav"))
for wav in files:
    node = json.loads(wav.with_suffix(".json").read_text())
    py = [asdict(s) for s in tt.detect_speech(tt.read_wav(wav.read_bytes()))]
    py = [{"start": s["start"], "end": s["end"], "audioStart": s["audio_start"], "audioEnd": s["audio_end"]} for s in py]
    same = py == node
    mismatches += not same
    print(f"{wav.name}: {len(node)} segments, {'same' if same else 'DIFFERENT'}")
print(f"{len(files) - mismatches}/{len(files)} files identical")
sys.exit(1 if mismatches else 0)
