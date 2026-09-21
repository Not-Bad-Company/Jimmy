#!/usr/bin/env python3
"""
Manual verification for the /identify endpoint's speaker-embedding
similarity. Not part of the automated suite — requires real recorded
voice samples, which aren't available in a dev sandbox.

Usage:
    python tests/test_speaker_identify.py same_a.wav same_b.wav different.wav

same_a.wav and same_b.wav should be two short (2-5s) recordings of the
SAME person; different.wav a recording of a DIFFERENT person. Prints the
cosine similarity for same-speaker and different-speaker pairs so the
0.75 match threshold (backend/src/speaker/store.rs) can be sanity-checked
and retuned against real hardware.
"""

import sys
import json
import math
import urllib.request

BASE_URL = "http://127.0.0.1:8001"


def identify(path: str) -> list[float]:
    with open(path, "rb") as f:
        data = f.read()
    boundary = "----jimmyspeakertest"
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{path}"\r\n'
        f"Content-Type: application/octet-stream\r\n\r\n"
    ).encode() + data + f"\r\n--{boundary}--\r\n".encode()

    req = urllib.request.Request(
        f"{BASE_URL}/identify",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())["fingerprint"]


def cosine_similarity(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(y * y for y in b))
    return dot / (norm_a * norm_b) if norm_a and norm_b else 0.0


def main():
    if len(sys.argv) != 4:
        print(__doc__)
        sys.exit(1)

    same_a, same_b, different = sys.argv[1], sys.argv[2], sys.argv[3]

    fp_a = identify(same_a)
    fp_b = identify(same_b)
    fp_c = identify(different)

    same_sim = cosine_similarity(fp_a, fp_b)
    diff_sim = cosine_similarity(fp_a, fp_c)

    print(f"Same-speaker similarity:      {same_sim:.4f}")
    print(f"Different-speaker similarity: {diff_sim:.4f}")
    print(f"Current match threshold:      0.75")

    if same_sim < 0.75:
        print("WARNING: same-speaker similarity is BELOW the 0.75 threshold — "
              "the threshold needs lowering, or the recordings are too short/noisy.")
    if diff_sim >= 0.75:
        print("WARNING: different-speaker similarity is ABOVE the 0.75 threshold — "
              "the threshold needs raising, false-match risk.")
    if same_sim >= 0.75 > diff_sim:
        print("OK: threshold cleanly separates same- vs different-speaker in this sample.")


if __name__ == "__main__":
    main()
