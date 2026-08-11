"""Correctness patch: BartForSequenceClassification's EOS-token pooling does
not survive ONNX export via the classic TorchScript tracer.

``modeling_bart.py``'s ``BartForSequenceClassification.forward`` selects the
sentence representation with a **value**-dependent boolean mask:

    eos_mask = input_ids.eq(self.config.eos_token_id)
    sentence_representation = hidden_states[eos_mask, :].view(...)[:, -1, :]

torch.export's symbolic-shape tracer correctly refuses to trace this (that
refusal, from ``GuardOnDataDependentSymNode``, was the earlier
``torch.export`` failure — see ``_optimum_py314_shim.py``). Forcing the
legacy JIT tracer instead makes the export *succeed*, but silently: the
tracer records ``hidden_states[eos_mask, :]`` as a concrete ``NonZero`` +
``view`` sequence baked to the shape of whatever dummy input optimum
generated, and that reshape does not generalize to a real input's token
pattern.

Measured, not assumed. Comparing the exported ONNX graph's raw logits against
the same model run eager in PyTorch on three real classification prompts:

    premise                         PyTorch (entail, contra)   ONNX (entail, contra)
    "Photosynthesis..." / Educational    1.37 > -0.92 (right)       ~similar (right)
    "Reuters: markets rallied..." / News 3.86 > 0.87  (right)      -2.34 < 2.99 (INVERTED)
    "best weeknight tomato pasta" / Food 3.4  > 0.6   (right)      -2.29 < 2.47 (INVERTED)

Two of three cases come out with entailment and contradiction backwards —
confidently wrong, not merely noisy — and this is present in the **fp32**
export before any quantization, so quantization is not the cause.

The fix used by several public workarounds for this exact issue: replace the
boolean-mask gather with an index computed from ``attention_mask`` — the
position of the last real (non-padding) token, which for BART's tokenizer
*is* the EOS token position, by construction, on any well-formed input. That
computation is pure arithmetic plus integer (not boolean) advanced indexing,
which traces correctly for any batch size or sequence length.

Import and call ``patch()`` before exporting; call ``unpatch()`` after (or
just let the process exit — this only matters for the export step, never for
inference, since transformers.js reimplements ``forward`` from the ONNX graph
itself and never touches this Python code again).
"""

from __future__ import annotations

import torch
from transformers.models.bart.modeling_bart import (
    BartForSequenceClassification,
    Seq2SeqSequenceClassifierOutput,
)
from torch.nn import BCEWithLogitsLoss, CrossEntropyLoss, MSELoss

_original_forward = BartForSequenceClassification.forward


def _traced_safe_forward(
    self,
    input_ids=None,
    attention_mask=None,
    decoder_input_ids=None,
    decoder_attention_mask=None,
    head_mask=None,
    decoder_head_mask=None,
    cross_attn_head_mask=None,
    encoder_outputs=None,
    inputs_embeds=None,
    decoder_inputs_embeds=None,
    labels=None,
    use_cache=None,
    output_attentions=None,
    output_hidden_states=None,
    return_dict=None,
):
    return_dict = return_dict if return_dict is not None else self.config.use_return_dict
    if labels is not None:
        use_cache = False
    if input_ids is None and inputs_embeds is not None:
        raise NotImplementedError(
            f"Passing input embeddings is currently not supported for {self.__class__.__name__}"
        )

    outputs = self.model(
        input_ids,
        attention_mask=attention_mask,
        decoder_input_ids=decoder_input_ids,
        decoder_attention_mask=decoder_attention_mask,
        head_mask=head_mask,
        decoder_head_mask=decoder_head_mask,
        cross_attn_head_mask=cross_attn_head_mask,
        encoder_outputs=encoder_outputs,
        inputs_embeds=inputs_embeds,
        decoder_inputs_embeds=decoder_inputs_embeds,
        use_cache=use_cache,
        output_attentions=output_attentions,
        output_hidden_states=output_hidden_states,
        return_dict=return_dict,
    )
    hidden_states = outputs[0]  # last hidden state

    # ── The fix ──────────────────────────────────────────────────────────
    # Static, shape-generic replacement for the eos_mask boolean gather.
    # attention_mask.sum(dim=1) - 1 is the index of the last real token; for
    # BART that token is the EOS token by construction (it is appended after
    # the real content and never padded past), so this selects exactly the
    # hidden state the original code selected on well-formed input — without
    # any value-dependent boolean indexing for the tracer to mis-specialize.
    if attention_mask is not None:
        sequence_lengths = attention_mask.sum(dim=1) - 1
    else:
        sequence_lengths = torch.full(
            (hidden_states.size(0),), hidden_states.size(1) - 1,
            dtype=torch.long, device=hidden_states.device,
        )
    batch_indices = torch.arange(hidden_states.size(0), device=hidden_states.device)
    sentence_representation = hidden_states[batch_indices, sequence_lengths]
    # ─────────────────────────────────────────────────────────────────────

    logits = self.classification_head(sentence_representation)

    loss = None
    if labels is not None:
        labels = labels.to(logits.device)
        if self.config.problem_type is None:
            if self.config.num_labels == 1:
                self.config.problem_type = "regression"
            elif self.config.num_labels > 1 and (labels.dtype == torch.long or labels.dtype == torch.int):
                self.config.problem_type = "single_label_classification"
            else:
                self.config.problem_type = "multi_label_classification"
        if self.config.problem_type == "regression":
            loss_fct = MSELoss()
            loss = (
                loss_fct(logits.squeeze(), labels.squeeze())
                if self.config.num_labels == 1
                else loss_fct(logits, labels)
            )
        elif self.config.problem_type == "single_label_classification":
            loss_fct = CrossEntropyLoss()
            loss = loss_fct(logits.view(-1, self.config.num_labels), labels.view(-1))
        elif self.config.problem_type == "multi_label_classification":
            loss_fct = BCEWithLogitsLoss()
            loss = loss_fct(logits, labels)

    if not return_dict:
        output = (logits,) + outputs[1:]
        return ((loss,) + output) if loss is not None else output

    return Seq2SeqSequenceClassifierOutput(
        loss=loss,
        logits=logits,
        past_key_values=outputs.past_key_values,
        decoder_hidden_states=outputs.decoder_hidden_states,
        decoder_attentions=outputs.decoder_attentions,
        cross_attentions=outputs.cross_attentions,
        encoder_last_hidden_state=outputs.encoder_last_hidden_state,
        encoder_hidden_states=outputs.encoder_hidden_states,
        encoder_attentions=outputs.encoder_attentions,
    )


def patch():
    BartForSequenceClassification.forward = _traced_safe_forward


def unpatch():
    BartForSequenceClassification.forward = _original_forward


def _self_test():
    """Prove equivalence on a well-formed batch before trusting the export."""
    from transformers import AutoTokenizer

    tok = AutoTokenizer.from_pretrained("valhalla/distilbart-mnli-12-1")
    model_orig = BartForSequenceClassification.from_pretrained("valhalla/distilbart-mnli-12-1")
    model_orig.eval()

    pairs = [
        ("Reuters: markets rallied today.", "This web page is about News."),
        ("The best weeknight tomato pasta.", "This web page is about Food."),
        ("A lesson on photosynthesis for students.", "This web page is about Educational content."),
    ]
    enc = tok([p[0] for p in pairs], [p[1] for p in pairs], return_tensors="pt", padding=True)

    with torch.no_grad():
        original_logits = model_orig(**enc).logits

    patch()
    try:
        model_patched = BartForSequenceClassification.from_pretrained("valhalla/distilbart-mnli-12-1")
        model_patched.eval()
        with torch.no_grad():
            patched_logits = model_patched(**enc).logits
    finally:
        unpatch()

    max_diff = (original_logits - patched_logits).abs().max().item()
    assert max_diff < 1e-3, (
        f"patched forward diverges from the original by {max_diff} on a padded batch — "
        f"the replacement pooling is not equivalent, do not export with it"
    )
    print(f"self-test: patched forward matches original (max abs diff {max_diff:.2e})")


if __name__ == "__main__":
    _self_test()
