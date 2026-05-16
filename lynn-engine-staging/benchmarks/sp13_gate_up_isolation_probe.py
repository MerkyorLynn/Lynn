#!/usr/bin/env python3
"""SP-13: Spark FP8 gate/up isolation kernel-math probe.

Phase 1 ship-decision investigation. Mirrors Codex R6000 P104 v2 AMBER + P105
"full > gateup wen" observation on Spark sm_121 FP8 path.

Question (kernel-math layer only):
  Does isolating gate/up FP8 (with Triton down) or down FP8 (with Triton
  gate/up) change kernel error characteristics in a way consistent with
  R6000 P105 finding ("full > gateup stable")?

LIMITATIONS:
  * Synthetic data — does NOT reproduce real-model layer-16 outlier patterns
  * Single forward — no drift accumulation across 40 layers
  * Does NOT answer greedy-stability / ship-decision — needs real-model probe

Matrix: 4 backends x 3 input distributions, 5 seeds each.

Backends:
  B1 triton_baseline   = Triton SP-01 autotuned gate_up_silu + Triton down_weighted_sum
  B2 hybrid_gateup_fp8 = spark_fp8 ext.gate_up + Python SiLU + Triton down_weighted_sum
  B3 hybrid_down_fp8   = Triton gate_up_silu + spark_fp8 ext.down + Python routing sum
  B4 full_fp8          = active_moe_spark_fp8 (= SP-12-D / SP-12-F path)

Reference: BF16 dequant of packed E2M1 weights + BF16 matmul (FP32 accumulator).

Output: JSON report + console matrix table.
"""
from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time
from pathlib import Path

import torch
import torch.nn.functional as F


# Lynn 27B active-MoE production shapes
HIDDEN = 2048
INTERMEDIATE = 512
NUM_EXPERTS = 256
TOP_K = 8


# E2M1 representable magnitudes (8 unique values, +/- sign = 16 codes)
E2M1_TABLE = torch.tensor([0.0, 0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0], dtype=torch.float32)


def gen_distribution(name, shape, device, seed):
    g = torch.Generator(device=device).manual_seed(seed)
    if name == 'gaussian':
        return torch.randn(*shape, generator=g, device=device, dtype=torch.float32) * 1.0
    if name == 'wide':
        return torch.randn(*shape, generator=g, device=device, dtype=torch.float32) * 2.5
    if name == 'outlier':
        base = torch.randn(*shape, generator=g, device=device, dtype=torch.float32) * 1.0
        mask = (torch.rand(*shape, generator=g, device=device) < 0.05)
        outliers = torch.randn(*shape, generator=g, device=device, dtype=torch.float32) * 8.0
        return torch.where(mask, outliers, base)
    raise ValueError('unknown distribution: ' + name)


def dequant_e2m1_per16(packed, scale, global_scale):
    table = E2M1_TABLE.to(packed.device)
    p = packed.to(torch.int64)
    lo = (p & 0x07).long()
    sign_lo = ((p >> 3) & 0x01).float() * -2.0 + 1.0
    hi = ((p >> 4) & 0x07).long()
    sign_hi = ((p >> 7) & 0x01).float() * -2.0 + 1.0
    mag_lo = table[lo] * sign_lo
    mag_hi = table[hi] * sign_hi
    out = torch.stack([mag_lo, mag_hi], dim=-1).reshape(*packed.shape[:-1], packed.shape[-1] * 2)
    K = out.shape[-1]
    scale_expanded = scale.unsqueeze(-1).expand(*scale.shape, 16).reshape(*scale.shape[:-1], scale.shape[-1] * 16)
    out = out * scale_expanded * global_scale.item()
    return out.float()


def quantize_e2m1_per16(x):
    table = E2M1_TABLE.to(x.device)
    flat = x.dim() == 1
    if flat:
        x = x.unsqueeze(0)
    *batch, K = x.shape
    assert K % 16 == 0
    xg = x.reshape(*batch, K // 16, 16)
    abs_max = xg.abs().amax(dim=-1).clamp_min(1e-8)
    scale = abs_max / 6.0
    normalized = (xg.abs() / scale.unsqueeze(-1)).clamp(0, 6.0)
    diff = (normalized.unsqueeze(-1) - table.view(*([1] * (len(batch) + 2)), -1)).abs()
    mag = torch.argmin(diff, dim=-1)
    sign = (xg < 0).to(torch.uint8) * 8
    codes = (mag.to(torch.uint8) | sign).reshape(*batch, K)
    packed = (codes[..., 0::2] | (codes[..., 1::2] << 4))
    if flat:
        packed = packed.squeeze(0)
        scale = scale.squeeze(0)
    return packed.contiguous(), scale.contiguous()


def make_fixture(distribution, device, seed):
    act_bf16 = gen_distribution(distribution, (HIDDEN,), device, seed).to(torch.bfloat16)

    gate_up_f = gen_distribution('gaussian', (NUM_EXPERTS, 2 * INTERMEDIATE, HIDDEN), device, seed + 1)
    gate_up_f = gate_up_f * 0.05
    gu_packed_list, gu_scale_list = [], []
    for e in range(NUM_EXPERTS):
        p, s = quantize_e2m1_per16(gate_up_f[e])
        gu_packed_list.append(p)
        gu_scale_list.append(s)
    gate_up_packed = torch.stack(gu_packed_list, dim=0).contiguous()
    gate_up_scale = torch.stack(gu_scale_list, dim=0).contiguous()
    gate_up_global_scale = torch.tensor([1.0], dtype=torch.float32, device=device)

    down_f = gen_distribution('gaussian', (NUM_EXPERTS, HIDDEN, INTERMEDIATE), device, seed + 2)
    down_f = down_f * 0.05
    d_packed_list, d_scale_list = [], []
    for e in range(NUM_EXPERTS):
        p, s = quantize_e2m1_per16(down_f[e])
        d_packed_list.append(p)
        d_scale_list.append(s)
    down_packed = torch.stack(d_packed_list, dim=0).contiguous()
    down_scale = torch.stack(d_scale_list, dim=0).contiguous()
    down_global_scale = torch.tensor([1.0], dtype=torch.float32, device=device)

    g = torch.Generator(device=device).manual_seed(seed + 3)
    router_logits = torch.randn(NUM_EXPERTS, generator=g, device=device, dtype=torch.float32)
    routing_weights_full, expert_ids = torch.topk(router_logits, TOP_K)
    routing_weights = F.softmax(routing_weights_full, dim=-1)
    expert_ids = expert_ids.to(torch.int32)

    return {
        'act_bf16': act_bf16,
        'gate_up_packed': gate_up_packed,
        'gate_up_scale': gate_up_scale,
        'gate_up_global_scale': gate_up_global_scale,
        'down_packed': down_packed,
        'down_scale': down_scale,
        'down_global_scale': down_global_scale,
        'expert_ids': expert_ids,
        'routing_weights': routing_weights,
    }


def run_reference(fix):
    act_bf16 = fix['act_bf16']
    expert_ids = fix['expert_ids']
    routing_weights = fix['routing_weights']

    gu_packed = fix['gate_up_packed'][expert_ids.long()]
    gu_scale = fix['gate_up_scale'][expert_ids.long()]
    gu_global = fix['gate_up_global_scale']
    gate_up_w = dequant_e2m1_per16(gu_packed, gu_scale, gu_global)

    d_packed = fix['down_packed'][expert_ids.long()]
    d_scale = fix['down_scale'][expert_ids.long()]
    d_global = fix['down_global_scale']
    down_w = dequant_e2m1_per16(d_packed, d_scale, d_global)

    act_f32 = act_bf16.float()
    gate_up_out = torch.einsum('kij,j->ki', gate_up_w, act_f32)
    gate = gate_up_out[:, :INTERMEDIATE]
    up = gate_up_out[:, INTERMEDIATE:]
    inter = F.silu(gate) * up
    down_out = torch.einsum('kij,kj->ki', down_w, inter)
    out = (routing_weights.float().unsqueeze(1) * down_out).sum(dim=0)
    return out


def run_b1_triton_baseline(fix):
    from triton_kernels.nvfp4_moe import (
        nvfp4_grouped_gate_up_silu_sp01_autotuned,
        nvfp4_grouped_down_weighted_sum_sp01_autotuned,
    )
    inter = nvfp4_grouped_gate_up_silu_sp01_autotuned(
        fix['act_bf16'], fix['expert_ids'],
        fix['gate_up_packed'], fix['gate_up_scale'], fix['gate_up_global_scale'],
    )
    out = nvfp4_grouped_down_weighted_sum_sp01_autotuned(
        inter, fix['expert_ids'], fix['routing_weights'],
        fix['down_packed'], fix['down_scale'], fix['down_global_scale'],
    )
    return out.float()


def run_b2_hybrid_gateup_fp8(fix):
    from engine.spark_fp8 import _build_extension
    from triton_kernels.nvfp4_linear import quantize_fp4_m1_native
    from triton_kernels.nvfp4_moe import nvfp4_grouped_down_weighted_sum_sp01_autotuned

    ext = _build_extension()
    act_packed_fp4, act_scale_fp = quantize_fp4_m1_native(fix['act_bf16'].reshape(1, -1).contiguous())
    act_packed = act_packed_fp4.view(torch.uint8).reshape(-1).contiguous()
    act_scale = act_scale_fp.to(torch.float32).reshape(-1).contiguous()

    gate_up_out = ext.gate_up(
        act_packed, act_scale, fix['expert_ids'].to(torch.int32),
        fix['gate_up_packed'], fix['gate_up_scale'], fix['gate_up_global_scale'],
        INTERMEDIATE,
    )
    gate = gate_up_out[:, :INTERMEDIATE]
    up = gate_up_out[:, INTERMEDIATE:]
    inter_f32 = F.silu(gate) * up
    inter_bf16 = inter_f32.to(torch.bfloat16)

    out = nvfp4_grouped_down_weighted_sum_sp01_autotuned(
        inter_bf16, fix['expert_ids'], fix['routing_weights'],
        fix['down_packed'], fix['down_scale'], fix['down_global_scale'],
    )
    return out.float()


def run_b3_hybrid_down_fp8(fix):
    from engine.spark_fp8 import _build_extension, _quantize_e2m1_batched
    from triton_kernels.nvfp4_moe import nvfp4_grouped_gate_up_silu_sp01_autotuned

    ext = _build_extension()
    inter_bf16 = nvfp4_grouped_gate_up_silu_sp01_autotuned(
        fix['act_bf16'], fix['expert_ids'],
        fix['gate_up_packed'], fix['gate_up_scale'], fix['gate_up_global_scale'],
    )
    inter_packed, inter_scale = _quantize_e2m1_batched(inter_bf16.float().contiguous())
    down_out = ext.down(
        inter_packed.contiguous(), inter_scale.contiguous(),
        fix['expert_ids'].to(torch.int32),
        fix['down_packed'], fix['down_scale'], fix['down_global_scale'],
        HIDDEN,
    )
    out = (fix['routing_weights'].float().unsqueeze(1) * down_out).sum(dim=0)
    return out.float()


def run_b4_full_fp8(fix):
    from engine.spark_fp8 import active_moe_spark_fp8
    out = active_moe_spark_fp8(
        fix['act_bf16'], fix['expert_ids'], fix['routing_weights'],
        fix['gate_up_packed'], fix['gate_up_scale'], fix['gate_up_global_scale'],
        fix['down_packed'], fix['down_scale'], fix['down_global_scale'],
    )
    return out.float()


def compute_metrics(out, ref):
    o = out.float().flatten()
    r = ref.float().flatten()
    diff = (o - r).abs()
    cos = F.cosine_similarity(o.unsqueeze(0), r.unsqueeze(0)).item()
    rel_l2 = (diff.norm() / r.norm().clamp_min(1e-9)).item()
    max_abs = diff.max().item()
    return {'cosine': cos, 'rel_l2': rel_l2, 'max_abs': max_abs}


def safe_mean(xs):
    xs = [x for x in xs if x == x]
    return statistics.mean(xs) if xs else float('nan')


def safe_stdev(xs):
    xs = [x for x in xs if x == x]
    return statistics.stdev(xs) if len(xs) >= 2 else 0.0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--seeds', type=int, default=5)
    parser.add_argument('--distributions', nargs='+', default=['gaussian', 'wide', 'outlier'])
    parser.add_argument('--out', default='/lynn-engine/reports/sp01_autotune/sp13_gate_up_isolation.json')
    args = parser.parse_args()

    sys.path.insert(0, '/lynn-engine')

    device = torch.device('cuda')
    print('[sp13] device={} cap={}'.format(torch.cuda.get_device_name(0), torch.cuda.get_device_capability()))
    print('[sp13] distributions={} seeds_per={}'.format(args.distributions, args.seeds))
    print('[sp13] shape: HIDDEN={} INTER={} E={} TOP_K={}'.format(HIDDEN, INTERMEDIATE, NUM_EXPERTS, TOP_K))
    print()

    backends = {
        'B1_triton_baseline': run_b1_triton_baseline,
        'B2_hybrid_gateup_fp8': run_b2_hybrid_gateup_fp8,
        'B3_hybrid_down_fp8': run_b3_hybrid_down_fp8,
        'B4_full_fp8': run_b4_full_fp8,
    }

    all_results = {}
    for dist in args.distributions:
        print('\n=== Distribution: {} ==='.format(dist))
        dist_results = {bname: {'cosine': [], 'rel_l2': [], 'max_abs': []} for bname in backends}
        for seed in range(args.seeds):
            fix = make_fixture(dist, device, seed)
            ref = run_reference(fix)

            for bname, bfn in backends.items():
                try:
                    t1 = time.time()
                    out = bfn(fix)
                    torch.cuda.synchronize()
                    t_b = time.time() - t1
                    m = compute_metrics(out, ref)
                    dist_results[bname]['cosine'].append(m['cosine'])
                    dist_results[bname]['rel_l2'].append(m['rel_l2'])
                    dist_results[bname]['max_abs'].append(m['max_abs'])
                    cos_s = m['cosine']
                    rel_s = m['rel_l2']
                    max_s = m['max_abs']
                    print('  seed={} {}: cos={:.6f} rel_l2={:.6f} max_abs={:.3e} ({:.1f}ms)'.format(
                        seed, bname, cos_s, rel_s, max_s, t_b * 1000))
                except Exception as exc:
                    print('  seed={} {}: FAILED {}: {}'.format(seed, bname, type(exc).__name__, exc))
                    dist_results[bname]['cosine'].append(float('nan'))
                    dist_results[bname]['rel_l2'].append(float('nan'))
                    dist_results[bname]['max_abs'].append(float('nan'))

            del fix, ref
            torch.cuda.empty_cache()

        all_results[dist] = dist_results

    print('\n\n=== SUMMARY MATRIX (mean +/- std across {} seeds) ==='.format(args.seeds))
    header = '{:<12} {:<24} {:<22} {:<22} {:<14}'.format('Distribution', 'Backend', 'cosine (mean +/- std)', 'rel_l2 (mean +/- std)', 'max_abs (mean)')
    print(header)
    print('-' * len(header))
    for dist, dist_r in all_results.items():
        for bname, m in dist_r.items():
            c_mu, c_sd = safe_mean(m['cosine']), safe_stdev(m['cosine'])
            r_mu, r_sd = safe_mean(m['rel_l2']), safe_stdev(m['rel_l2'])
            x_mu = safe_mean(m['max_abs'])
            cos_str = '{:.6f}+/-{:.4f}'.format(c_mu, c_sd)
            rel_str = '{:.5f}+/-{:.4f}'.format(r_mu, r_sd)
            print('{:<12} {:<24} {:<22} {:<22} {:<14.3e}'.format(dist, bname, cos_str, rel_str, x_mu))

    summary = {
        'type': 'sp13_gate_up_isolation_probe',
        'date': time.strftime('%Y-%m-%dT%H:%M:%S', time.localtime()),
        'device': torch.cuda.get_device_name(0),
        'compute_capability': list(torch.cuda.get_device_capability()),
        'shape': {'hidden': HIDDEN, 'intermediate': INTERMEDIATE, 'num_experts': NUM_EXPERTS, 'top_k': TOP_K},
        'n_seeds_per_distribution': args.seeds,
        'distributions': args.distributions,
        'results': all_results,
        'limitations': [
            'synthetic data only - does not reproduce real-model layer-16 outlier patterns',
            'single forward pass - no drift accumulation across 40 layers',
            'does not measure greedy stability - needs real-model probe',
        ],
    }
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(summary, indent=2, ensure_ascii=False))
    print('\n[sp13] report written: {}'.format(out_path))


if __name__ == '__main__':
    main()
