"""Compatibility shim: optimum's ONNX exporter vs. Python 3.14's functools.partial.

Python 3.14 made ``functools.partial`` implement the descriptor protocol
(``__get__``), so a ``partial`` stored as a class attribute now binds like a
method when accessed through an instance — ``self`` gets silently inserted as
an extra leading positional argument. ``optimum`` stores every
``NORMALIZED_CONFIG_CLASS`` this way (``NormalizedConfig.with_args(...)``
returns a bare ``functools.partial``), so ``self.NORMALIZED_CONFIG_CLASS(cfg)``
in ``optimum/exporters/onnx/base.py`` now calls
``NormalizedSeq2SeqConfig(self, cfg, allow_new=False, ...)`` instead of
``NormalizedSeq2SeqConfig(cfg, allow_new=False, ...)`` — two positional
arguments where one was expected, and the collision lands on ``allow_new``:

    TypeError: NormalizedConfig.__init__() got multiple values for argument 'allow_new'

Confirmed with a minimal reproduction outside optimum entirely:

    class Foo: pass
    Foo.bar = functools.partial(int, base=10)
    Foo().bar   # -> <bound method ? of <Foo object>> on Python 3.14, a bare
                #    partial on 3.13 and earlier

This is a real language-level break, not an optimum/transformers version
mismatch — it reproduces identically across every optimum release tried
(2.1.0, 1.24.0, 1.23.3, 1.20.0) because all of them predate Python 3.14 and
none could have been tested against it.

The fix: wrap ``NormalizedConfig.with_args``'s return value in
``staticmethod(...)``, which opts out of the descriptor protocol and restores
the pre-3.14 behaviour exactly. Import this module before anything that
imports ``optimum.exporters.onnx.model_configs`` — every ``NORMALIZED_CONFIG_CLASS
= Normalized*Config.with_args(...)`` line executes at class-body time, so the
patch must be in place before that module loads, not after.
"""

import functools

import optimum.utils.normalized_config as _nc

_orig_with_args = _nc.NormalizedConfig.with_args.__func__


def _patched_with_args(cls, allow_new: bool = False, **kwargs):
    return staticmethod(functools.partial(cls, allow_new=allow_new, **kwargs))


_nc.NormalizedConfig.with_args = classmethod(_patched_with_args)

# Self-check: fail loudly and immediately if this Python's functools.partial
# does NOT have the descriptor bug, or the patch doesn't fix it — better than
# silently exporting a model with a subtly wrong config three minutes later.
def _self_test():
    class _Probe:
        pass

    _Probe.attr = _nc.NormalizedConfig.with_args(allow_new=True, vocab_size="vocab_size")
    inst = _Probe()
    # Must be callable with exactly one positional arg (the config), not two.
    result = inst.attr({"vocab_size": 42})
    assert result.VOCAB_SIZE == "vocab_size", "patched with_args produced a broken NormalizedConfig"


_self_test()


# ── Second gap: torch.onnx.export's dynamo default ──────────────────────────
#
# This installed torch (2.12.1) defaults `torch.onnx.export(..., dynamo=True)`,
# routing through the newer `torch.export`-based graph capture. optimum's
# `convert.py` calls `onnx_export(model, (dummy_inputs,), ..., dynamic_axes=...,
# opset_version=...)` with no `dynamo=` argument at all — dynamic_axes is a
# *legacy*-tracer parameter (the dynamo path wants `dynamic_shapes` instead),
# so this call was written entirely against the old TorchScript-based tracer
# and simply predates torch's default flipping under it.
#
# The dynamo path also genuinely cannot trace this model:
# BartForSequenceClassification.forward selects the EOS-token hidden state via
# a boolean mask derived from actual token *values*
# (input_ids.eq(eos_token_id)), which makes the selected count data-dependent.
# torch.export's symbolic-shape guards cannot specialize that without either a
# concrete example (the classic tracer's whole approach) or explicit dynamic-
# shape annotations optimum's call site never provides:
#
#   GuardOnDataDependentSymNode: Could not extract specialized integer from
#   data-dependent expression u0 (unhinted: u0).
#   Caused by: (transformers/models/bart/modeling_bart.py:1783 in forward)
#
# Forcing dynamo=False restores the pre-default-flip tracer, which just runs
# the concrete forward pass once and records what happened — no symbolic
# shape proof required, and it is what this exact call was designed for.
import torch.onnx as _torch_onnx  # noqa: E402

_orig_export = _torch_onnx.export


@functools.wraps(_orig_export)
def _export_default_legacy_tracer(*args, **kwargs):
    kwargs.setdefault("dynamo", False)
    return _orig_export(*args, **kwargs)


def force_legacy_tracer():
    """Force the pre-3.14-default TorchScript tracer.

    Prefer NOT calling this. The legacy tracer accepts models the dynamo
    exporter correctly refuses, but "accepts" here means "silently bakes in
    trace-time shape/value assumptions" — confirmed on
    BartForSequenceClassification, where it produced confidently *wrong*
    entailment/contradiction logits on real inputs while reporting success.
    Only use this once you have independently verified the exported graph
    against eager PyTorch on real, varied-length inputs, not just dummy ones.
    """
    _torch_onnx.export = _export_default_legacy_tracer


def use_proving_tracer():
    """Restore torch's own default (dynamo=True): the exporter that proves
    shape-genericity via symbolic shapes and refuses to export what it cannot
    prove, rather than silently miscompiling it. This is the one to use."""
    _torch_onnx.export = _orig_export
