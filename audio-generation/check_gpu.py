"""E-1 — is this machine ready to time generation on the RTX 5060?

    python audio-generation/check_gpu.py

The RTX 5060 is Blackwell (compute capability 12.0, sm_120). It needs PyTorch >= 2.7
built against CUDA 12.8 (the cu128 wheels). An older wheel imports fine and then fails at
the first kernel launch, which is a bad moment to find out in the middle of an overnight
run. This script exits non-zero unless torch can actually run a half-precision matmul on
the GPU, and prints the facts that belong in the results header.
"""

from __future__ import annotations

import sys


def main() -> int:
    try:
        import torch
    except Exception as e:
        print(f"FAIL: torch is not importable ({e})")
        return 1

    print(f"torch {torch.__version__}, CUDA build {torch.version.cuda}")
    if not torch.cuda.is_available():
        print("FAIL: torch.cuda.is_available() is False. Install the cu128 wheels:\n"
              "  pip install torch --index-url https://download.pytorch.org/whl/cu128")
        return 1

    name = torch.cuda.get_device_name(0)
    cap = torch.cuda.get_device_capability(0)
    mem = torch.cuda.get_device_properties(0).total_memory / 2**30
    print(f"device: {name}, capability {cap}, {mem:.1f} GiB")

    ok = True
    if "5060" in name and cap != (12, 0):
        print(f"WARN: an RTX 5060 should report (12, 0), got {cap}")
    if cap >= (12, 0) and not (torch.version.cuda and tuple(int(x) for x in torch.version.cuda.split(".")[:2]) >= (12, 8)):
        print("FAIL: Blackwell needs a CUDA 12.8+ build of torch")
        ok = False

    try:
        a = torch.randn(1024, 1024, device="cuda", dtype=torch.float16)
        torch.cuda.synchronize()
        (a @ a).sum().item()
        print("fp16 matmul on the GPU: ok")
    except Exception as e:
        print(f"FAIL: could not run a kernel on the GPU ({type(e).__name__}: {e})")
        ok = False

    print("READY" if ok else "NOT READY")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
