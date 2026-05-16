#!/usr/bin/env python3
"""SP-14 timing bench: B5 W4A8 gate/up vs B1 Triton baseline (gate/up only)."""
from __future__ import annotations

import sys
import time

import torch
import torch.nn.functional as F


HIDDEN = 2048
INTERMEDIATE = 512
NUM_EXPERTS = 256
TOP_K = 8
N_ITERS = 200
N_WARMUP = 10


def main():
    sys.path.insert(0, '/lynn-engine')
    sys.path.insert(0, '/lynn-engine/benchmarks')
    from sp14_w4a8_math_contract_probe import (
        build_extension, make_fixture, quantize_fp8_e4m3_per16,
    )
    from triton_kernels.nvfp4_moe import (
        nvfp4_grouped_gate_up_silu_sp01_autotuned,
    )

    device = torch.device('cuda')
    print('[sp14-bench] building W4A8 ext...')
    ext = build_extension()
    fix = make_fixture('gaussian', device, seed=0)

    # --- B1 Triton gate/up + silu (production baseline) ---
    for _ in range(N_WARMUP):
        _ = nvfp4_grouped_gate_up_silu_sp01_autotuned(
            fix['act_bf16'], fix['expert_ids'],
            fix['gate_up_packed'], fix['gate_up_scale'], fix['gate_up_global_scale'])
    torch.cuda.synchronize()

    t_evt_s = torch.cuda.Event(enable_timing=True)
    t_evt_e = torch.cuda.Event(enable_timing=True)
    t_evt_s.record()
    for _ in range(N_ITERS):
        out_b1 = nvfp4_grouped_gate_up_silu_sp01_autotuned(
            fix['act_bf16'], fix['expert_ids'],
            fix['gate_up_packed'], fix['gate_up_scale'], fix['gate_up_global_scale'])
    t_evt_e.record()
    torch.cuda.synchronize()
    b1_us = t_evt_s.elapsed_time(t_evt_e) / N_ITERS * 1000.0
    print('[sp14-bench] B1 Triton gate/up+silu (production): {:.2f} us/call'.format(b1_us))

    # --- B5 W4A8 gate/up + Python silu (NEW) ---
    # Pre-compute FP8 activation cast cost separately for clarity
    for _ in range(N_WARMUP):
        act_fp8, act_scale = quantize_fp8_e4m3_per16(fix['act_bf16'])
        gate_up_out = ext.w4a8_gate_up(
            act_fp8, act_scale, fix['expert_ids'].to(torch.int32),
            fix['gate_up_packed'], fix['gate_up_scale'], fix['gate_up_global_scale'],
            INTERMEDIATE,
        )
        gate = gate_up_out[:, :INTERMEDIATE]
        up = gate_up_out[:, INTERMEDIATE:]
        inter = F.silu(gate) * up
    torch.cuda.synchronize()

    t_evt_s.record()
    for _ in range(N_ITERS):
        act_fp8, act_scale = quantize_fp8_e4m3_per16(fix['act_bf16'])
        gate_up_out = ext.w4a8_gate_up(
            act_fp8, act_scale, fix['expert_ids'].to(torch.int32),
            fix['gate_up_packed'], fix['gate_up_scale'], fix['gate_up_global_scale'],
            INTERMEDIATE,
        )
        gate = gate_up_out[:, :INTERMEDIATE]
        up = gate_up_out[:, INTERMEDIATE:]
        inter = F.silu(gate) * up
    t_evt_e.record()
    torch.cuda.synchronize()
    b5_us = t_evt_s.elapsed_time(t_evt_e) / N_ITERS * 1000.0
    print('[sp14-bench] B5 W4A8 gate/up + py-silu (NEW): {:.2f} us/call'.format(b5_us))

    speedup = b1_us / b5_us
    delta_pct = (b1_us - b5_us) / b1_us * 100
    print()
    print('=== gate/up-only speedup ===')
    print('  B1 Triton baseline:  {:.2f} us'.format(b1_us))
    print('  B5 W4A8 hybrid NEW:  {:.2f} us'.format(b5_us))
    print('  speedup ratio:       {:.3f}x ({:+.1f}% time delta)'.format(speedup, -delta_pct))

    # Project net TPS uplift estimate
    print()
    print('=== TPS uplift projection (very rough) ===')
    print('  Assume current Spark production TPS = 49.37 (SP-08 autotune verified)')
    print('  Assume decode-step latency budget: ~20 ms/token (1/49.37 * 1000)')
    print('  Gate/up contribution to 40 layers (decode-only): {:.1f} ms saved per token if {:+.1f}% gate/up time'.format(
        (b1_us - b5_us) * 40 / 1000, -delta_pct))
    saved_ms = (b1_us - b5_us) * 40 / 1000
    new_step_ms = 20.27 - saved_ms
    new_tps = 1000.0 / new_step_ms if new_step_ms > 0 else float('inf')
    uplift_pct = (new_tps - 49.37) / 49.37 * 100
    print('  Estimated new TPS:    {:.1f} (vs 49.37 baseline, {:+.1f}%)'.format(new_tps, uplift_pct))
    print('  NOTE: linear extrapolation. Real uplift depends on other decode-step components.')


if __name__ == '__main__':
    main()
