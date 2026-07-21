"""
Stubs torch and transformers before any test module imports d3_generate,
so the test suite doesn't need to download/load the real MusicGen model.
Only the pieces d3_generate.py actually touches are stubbed.
"""
import sys
import types
import numpy as np
import pytest


def _install_stubs():
    if "torch" in sys.modules and getattr(sys.modules["torch"], "_is_fake_stub", False):
        return sys.modules["transformers"]._call_log

    torch_stub = types.ModuleType("torch")
    torch_stub._is_fake_stub = True
    torch_stub.float16 = "float16"
    torch_stub.float32 = "float32"

    class _FakeTensor:
        pass
    torch_stub.Tensor = _FakeTensor

    class _CudaStub:
        @staticmethod
        def is_available():
            return False
        @staticmethod
        def get_device_name(i):
            return "fake-cuda"
        @staticmethod
        def manual_seed(s):
            pass

    torch_stub.cuda = _CudaStub()
    torch_stub.manual_seed = lambda s: None
    sys.modules["torch"] = torch_stub

    transformers_stub = types.ModuleType("transformers")
    call_log = []

    def fake_synthesiser(prompts, forward_params=None):
        is_batch = isinstance(prompts, list)
        prompt_list = prompts if is_batch else [prompts]
        call_log.append(len(prompt_list))
        max_new_tokens = (forward_params or {}).get("max_new_tokens", 1400)
        # MusicGen's codec runs at TOKENS_PER_SEC=50 -- mirror that here so
        # the fake model's output duration actually matches what a real
        # batched call would produce for the requested token count.
        sr = 32000
        n_samples = int(sr * (max_new_tokens / 50))
        outputs = []
        for p in prompt_list:
            audio = (0.1 * np.sin(2 * np.pi * 220 * np.linspace(0, n_samples / sr, n_samples))).astype(np.float32)
            outputs.append({"audio": audio, "sampling_rate": sr})
        return outputs if is_batch else outputs[0]

    transformers_stub.pipeline = lambda *a, **k: fake_synthesiser
    transformers_stub._call_log = call_log
    sys.modules["transformers"] = transformers_stub

    return call_log


@pytest.fixture
def call_log():
    """Records batch sizes seen by the fake MusicGen model for each test."""
    log = _install_stubs()
    log.clear()
    yield log


@pytest.fixture(autouse=True)
def _reset_d3_worker_state():
    """
    d3_generate.py's batch queue/worker are module-level globals bound to
    whichever event loop was running when they were created. Each test
    function gets its own fresh event loop, so a queue/task left over from
    a previous test would be bound to an already-closed loop -- reset them
    before every test so _ensure_worker() creates fresh ones on the
    current test's loop.
    """
    if "d3_generate" in sys.modules:
        sys.modules["d3_generate"]._queue = None
        sys.modules["d3_generate"]._worker_task = None
    yield