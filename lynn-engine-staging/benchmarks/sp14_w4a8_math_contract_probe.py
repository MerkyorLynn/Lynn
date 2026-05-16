#!/usr/bin/env python3
"""SP-14: Spark W4A8 mirror math contract gate (kernel-level, synthetic).

Phase 1 of three-gate ship validation per user 2026-05-16:
  Gate 1: math contract (this probe)
  Gate 2: 6-prompt greedy parity on real Lynn 27B
  Gate 3: 16k long-ctx smoke

R6000 P104/P105 numbers do NOT count as Spark validation.

Question: Does a true W4A8 mirror kernel on Spark sm_121 (FP8 E4M3 activation
+ E2M1 weight via LUT expand, FP8xFP8 MMA) recover the numerical fidelity that
SP-13 showed is broken in the current SP-12 W4A4 mirror (E2M1 activation)?

Backends:
  B1 Triton baseline       = current production SP-08 (BF16 act + E2M1 weight)
  B5 W4A8 gate/up hybrid   = NEW: FP8 E4M3 act + E2M1 weight LUT->FP8 + Python SiLU + Triton down
  B2_sp12 reference        = SP-12 W4A4 mirror (E2M1 act) -- failure reference

Expected if W4A8 is correct: B5 cosine > 0.999 across all distributions,
in particular outlier distribution (where B2_sp12 collapses to cos 0.5).

Reference: BF16 dequant of packed E2M1 weights + BF16 matmul (FP32 accumulator).
Limitations same as SP-13: synthetic only, single forward, no greedy parity.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import statistics
import sys
import time
from pathlib import Path

import torch
import torch.nn.functional as F
from torch.utils.cpp_extension import load


HIDDEN = 2048
INTERMEDIATE = 512
NUM_EXPERTS = 256
TOP_K = 8

E2M1_TABLE = torch.tensor([0.0, 0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0], dtype=torch.float32)
FP8_E4M3_MAX = 448.0


# ============================================================================
# W4A8 gate/up CUDA kernel
# ============================================================================
# Difference vs SP-12 spark_fp8.gate_up:
#   - A-side (activation) is RAW FP8 E4M3 bytes, NOT packed E2M1 with LUT decode
#   - Saves the LUT decode pass on activation
#   - Activation stays in FP8 (24x wider dynamic range than E2M1)

_CPP_SOURCE = r"""
#include <torch/extension.h>

torch::Tensor sp14_w4a8_gate_up(
    torch::Tensor act_fp8,              // [HIDDEN] uint8 raw FP8 E4M3
    torch::Tensor act_scale,            // [HIDDEN/16] f32 per-16 scale
    torch::Tensor expert_ids,           // [top_k] int32
    torch::Tensor gate_up_packed,       // [E, 2*INTER, HIDDEN/2] uint8 E2M1
    torch::Tensor gate_up_scale,        // [E, 2*INTER, HIDDEN/16] f32
    torch::Tensor gate_up_global_scale, // [1] f32
    int64_t intermediate
);

PYBIND11_MODULE(TORCH_EXTENSION_NAME, m) {
    m.def("w4a8_gate_up", &sp14_w4a8_gate_up, "SP-14 W4A8 gate_up: FP8 act, E2M1->FP8 LUT weight");
}
"""


_CUDA_SOURCE = r"""
#include <torch/extension.h>
#include <cuda_runtime.h>
#include <stdint.h>

namespace {

// E2M1 -> FP8 E4M3 LUT (same as spark_fp8 -- only needed for weight side now)
constexpr uint32_t LUT_REG_0 = 0x3C383000;
constexpr uint32_t LUT_REG_1 = 0x4C484440;
constexpr uint32_t LUT_REG_2 = 0xBCB8B080;
constexpr uint32_t LUT_REG_3 = 0xCCC8C4C0;

__device__ __forceinline__ uint8_t lut_nibble_to_fp8(uint8_t nibble) {
    uint8_t bi = nibble & 0x0F;
    uint32_t reg;
    if (bi < 4)        reg = LUT_REG_0;
    else if (bi < 8)   reg = LUT_REG_1;
    else if (bi < 12)  reg = LUT_REG_2;
    else               reg = LUT_REG_3;
    uint8_t shift = (bi & 3) * 8;
    return (uint8_t)((reg >> shift) & 0xFF);
}

__device__ __forceinline__ uint32_t load_4_nibbles_as_fp8(const uint8_t* ptr, int byte_offset) {
    uint16_t bytes = *reinterpret_cast<const uint16_t*>(ptr + byte_offset);
    uint8_t n0 = (uint8_t)(bytes & 0x0F);
    uint8_t n1 = (uint8_t)((bytes >> 4) & 0x0F);
    uint8_t n2 = (uint8_t)((bytes >> 8) & 0x0F);
    uint8_t n3 = (uint8_t)((bytes >> 12) & 0x0F);
    uint8_t b0 = lut_nibble_to_fp8(n0);
    uint8_t b1 = lut_nibble_to_fp8(n1);
    uint8_t b2 = lut_nibble_to_fp8(n2);
    uint8_t b3 = lut_nibble_to_fp8(n3);
    return (uint32_t)b0 | ((uint32_t)b1 << 8) | ((uint32_t)b2 << 16) | ((uint32_t)b3 << 24);
}

__device__ __forceinline__ void fp8_mma_m16n8k32(
    const uint32_t a[4], const uint32_t b[2],
    float d[4]
) {
    asm volatile(
        "mma.sync.aligned.m16n8k32.row.col.f32.e4m3.e4m3.f32 "
        "{%0, %1, %2, %3}, "
        "{%4, %5, %6, %7}, "
        "{%8, %9}, "
        "{%10, %11, %12, %13};\n"
        : "=f"(d[0]), "=f"(d[1]), "=f"(d[2]), "=f"(d[3])
        : "r"(a[0]), "r"(a[1]), "r"(a[2]), "r"(a[3]),
          "r"(b[0]), "r"(b[1]),
          "f"(0.f), "f"(0.f), "f"(0.f), "f"(0.f)
    );
}

// W4A8: load 4 FP8 bytes DIRECTLY (no nibble unpacking, no LUT decode on A-side)
__device__ __forceinline__ void fill_a_w4a8_two_halves_vec(
    const uint8_t* act_fp8,
    int k_base, int lane,
    uint32_t a_low[4], uint32_t a_high[4]
) {
    const int byte_offset_low  = k_base + (lane & 3) * 4;
    const int byte_offset_high = k_base + (lane & 3) * 4 + 16;
    uint32_t r_low  = *reinterpret_cast<const uint32_t*>(act_fp8 + byte_offset_low);
    uint32_t r_high = *reinterpret_cast<const uint32_t*>(act_fp8 + byte_offset_high);
    a_low[0]  = r_low;  a_low[1]  = r_low;
    a_low[2]  = 0;       a_low[3]  = 0;
    a_high[0] = 0;       a_high[1] = 0;
    a_high[2] = r_high; a_high[3] = r_high;
}

// B-side: weight stays as E2M1 packed, decode via LUT (same as SP-12)
__device__ __forceinline__ void fill_b_8rows_two_halves_vec(
    const uint8_t* weight_rows_packed,
    int k_total,
    int k_base,
    int lane,
    uint32_t b_low[2], uint32_t b_high[2]
) {
    const int n_row = lane >> 2;
    const uint8_t* row_ptr = weight_rows_packed + n_row * (k_total / 2);
    const int byte_offset_low  = (k_base + (lane & 3) * 4) / 2;
    const int byte_offset_high = (k_base + (lane & 3) * 4 + 16) / 2;
    b_low[0]  = load_4_nibbles_as_fp8(row_ptr, byte_offset_low);
    b_low[1]  = 0;
    b_high[0] = 0;
    b_high[1] = load_4_nibbles_as_fp8(row_ptr, byte_offset_high);
}

__global__ void sp14_w4a8_gate_up_kernel(
    const uint8_t* __restrict__ act_fp8,
    const float*   __restrict__ act_scale,
    const int32_t* __restrict__ expert_ids,
    const uint8_t* __restrict__ gate_up_packed,
    const float*   __restrict__ gate_up_scale,
    float          gate_up_global_scale,
    int hidden,
    int intermediate,
    int top_k,
    float* __restrict__ gate_up_out
) {
    const int rows_per_tile = 8;
    const int num_row_tiles = (2 * intermediate) / rows_per_tile;
    const int slot = blockIdx.x / num_row_tiles;
    const int row_tile = blockIdx.x % num_row_tiles;
    if (slot >= top_k) return;

    const int expert_id = expert_ids[slot];
    const int row_start = row_tile * rows_per_tile;

    const uint8_t* expert_weight = gate_up_packed +
        (int64_t)expert_id * (2 * intermediate) * (hidden / 2) +
        (int64_t)row_start * (hidden / 2);
    const float* expert_scale = gate_up_scale +
        (int64_t)expert_id * (2 * intermediate) * (hidden / 16) +
        (int64_t)row_start * (hidden / 16);

    const int lane = threadIdx.x;
    const int n_col_a = (lane & 3) * 2 + 0;
    const int n_col_b = (lane & 3) * 2 + 1;

    float acc[4] = {0.f, 0.f, 0.f, 0.f};
    const int num_k32 = hidden / 32;
    const int k_div16 = hidden / 16;

    #pragma unroll 1
    for (int t = 0; t < num_k32; ++t) {
        const int k_base = t * 32;
        const float a_scale_low  = act_scale[k_base / 16];
        const float a_scale_high = act_scale[k_base / 16 + 1];
        const float w_scale_a_low  = expert_scale[n_col_a * k_div16 + k_base / 16];
        const float w_scale_b_low  = expert_scale[n_col_b * k_div16 + k_base / 16];
        const float w_scale_a_high = expert_scale[n_col_a * k_div16 + k_base / 16 + 1];
        const float w_scale_b_high = expert_scale[n_col_b * k_div16 + k_base / 16 + 1];

        uint32_t a_low[4], a_high[4];
        uint32_t b_low[2], b_high[2];
        fill_a_w4a8_two_halves_vec(act_fp8, k_base, lane, a_low, a_high);
        fill_b_8rows_two_halves_vec(expert_weight, hidden, k_base, lane, b_low, b_high);

        float d_low[4], d_high[4];
        fp8_mma_m16n8k32(a_low,  b_low,  d_low);
        fp8_mma_m16n8k32(a_high, b_high, d_high);

        const float scale_a_low  = a_scale_low  * w_scale_a_low  / gate_up_global_scale;
        const float scale_b_low  = a_scale_low  * w_scale_b_low  / gate_up_global_scale;
        const float scale_a_high = a_scale_high * w_scale_a_high / gate_up_global_scale;
        const float scale_b_high = a_scale_high * w_scale_b_high / gate_up_global_scale;

        acc[0] += d_low[0] * scale_a_low + d_high[0] * scale_a_high;
        acc[1] += d_low[1] * scale_b_low + d_high[1] * scale_b_high;
        acc[2] += d_low[2] * scale_a_low + d_high[2] * scale_a_high;
        acc[3] += d_low[3] * scale_b_low + d_high[3] * scale_b_high;
    }

    if (lane < 4) {
        const int64_t base = (int64_t)slot * (2 * intermediate) + row_start;
        gate_up_out[base + lane * 2 + 0] = acc[0];
        gate_up_out[base + lane * 2 + 1] = acc[1];
    }
}

}  // namespace

torch::Tensor sp14_w4a8_gate_up(
    torch::Tensor act_fp8,
    torch::Tensor act_scale,
    torch::Tensor expert_ids,
    torch::Tensor gate_up_packed,
    torch::Tensor gate_up_scale,
    torch::Tensor gate_up_global_scale,
    int64_t intermediate
) {
    TORCH_CHECK(gate_up_packed.dim() == 3, "gate_up_packed must be [E, 2*INTER, HIDDEN/2]");
    const int hidden = act_fp8.numel();  // FP8 = 1 byte per element
    const int top_k = expert_ids.numel();
    auto out = torch::zeros({top_k, 2 * (int)intermediate},
                            torch::dtype(torch::kFloat32).device(act_fp8.device()));
    const int num_row_tiles = (2 * intermediate) / 8;
    const int total_blocks = top_k * num_row_tiles;
    sp14_w4a8_gate_up_kernel<<<total_blocks, 32>>>(
        act_fp8.contiguous().data_ptr<uint8_t>(),
        act_scale.contiguous().data_ptr<float>(),
        expert_ids.contiguous().data_ptr<int32_t>(),
        gate_up_packed.contiguous().data_ptr<uint8_t>(),
        gate_up_scale.contiguous().data_ptr<float>(),
        gate_up_global_scale.item<float>(),
        hidden,
        (int)intermediate,
        top_k,
        out.data_ptr<float>()
    );
    return out;
}
"""


_EXT = None


def build_extension():
    global _EXT
    if _EXT is not None:
        return _EXT
    build_dir = Path("/tmp/sp14_w4a8_build")
    if build_dir.exists():
        shutil.rmtree(build_dir)
    build_dir.mkdir(parents=True, exist_ok=True)
    cpp_path = build_dir / "sp14_bindings.cpp"
    cu_path = build_dir / "sp14_kernel.cu"
    cpp_path.write_text(_CPP_SOURCE)
    cu_path.write_text(_CUDA_SOURCE)
    arch = os.environ.get("LYNN_NATIVE_CUDA_ARCH", "sm_121a")
    _EXT = load(
        name="sp14_w4a8",
        sources=[str(cpp_path), str(cu_path)],
        build_directory=str(build_dir),
        extra_cflags=["-O3"],
        extra_cuda_cflags=["-O3", "--use_fast_math", f"-arch={arch}"],
        verbose=False,
    )
    return _EXT


# ============================================================================
# Helpers
# ============================================================================

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
    raise ValueError(name)


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


def quantize_fp8_e4m3_per16(x):
    """Quantize FP32/BF16 [K] to FP8 E4M3 bytes + per-16 FP32 scale.

    Returns: (fp8_bytes [K] uint8, scale [K/16] f32)
    """
    x = x.float()
    K = x.shape[-1]
    assert K % 16 == 0
    xg = x.reshape(*x.shape[:-1], K // 16, 16)
    abs_max = xg.abs().amax(dim=-1).clamp_min(1e-8)
    scale = abs_max / FP8_E4M3_MAX
    normalized = xg / scale.unsqueeze(-1)
    fp8 = normalized.to(torch.float8_e4m3fn)
    fp8_bytes = fp8.view(torch.uint8).reshape(*x.shape[:-1], K).contiguous()
    return fp8_bytes, scale.reshape(*x.shape[:-1], K // 16).contiguous()


# ============================================================================
# Fixture + reference (same as SP-13 for direct comparability)
# ============================================================================

def make_fixture(distribution, device, seed):
    act_bf16 = gen_distribution(distribution, (HIDDEN,), device, seed).to(torch.bfloat16)
    gate_up_f = gen_distribution('gaussian', (NUM_EXPERTS, 2 * INTERMEDIATE, HIDDEN), device, seed + 1) * 0.05
    gu_packed_list, gu_scale_list = [], []
    for e in range(NUM_EXPERTS):
        p, s = quantize_e2m1_per16(gate_up_f[e])
        gu_packed_list.append(p); gu_scale_list.append(s)
    gate_up_packed = torch.stack(gu_packed_list, dim=0).contiguous()
    gate_up_scale = torch.stack(gu_scale_list, dim=0).contiguous()
    gate_up_global_scale = torch.tensor([1.0], dtype=torch.float32, device=device)

    down_f = gen_distribution('gaussian', (NUM_EXPERTS, HIDDEN, INTERMEDIATE), device, seed + 2) * 0.05
    d_packed_list, d_scale_list = [], []
    for e in range(NUM_EXPERTS):
        p, s = quantize_e2m1_per16(down_f[e])
        d_packed_list.append(p); d_scale_list.append(s)
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
    """BF16 dequant + BF16 matmul reference (highest fidelity)."""
    expert_ids = fix['expert_ids']
    gu_packed = fix['gate_up_packed'][expert_ids.long()]
    gu_scale = fix['gate_up_scale'][expert_ids.long()]
    gate_up_w = dequant_e2m1_per16(gu_packed, gu_scale, fix['gate_up_global_scale'])

    d_packed = fix['down_packed'][expert_ids.long()]
    d_scale = fix['down_scale'][expert_ids.long()]
    down_w = dequant_e2m1_per16(d_packed, d_scale, fix['down_global_scale'])

    act_f32 = fix['act_bf16'].float()
    gate_up_out = torch.einsum('kij,j->ki', gate_up_w, act_f32)
    gate = gate_up_out[:, :INTERMEDIATE]
    up = gate_up_out[:, INTERMEDIATE:]
    inter = F.silu(gate) * up
    down_out = torch.einsum('kij,kj->ki', down_w, inter)
    out = (fix['routing_weights'].float().unsqueeze(1) * down_out).sum(dim=0)
    return out


# ============================================================================
# Backends
# ============================================================================

def run_b1_triton_baseline(fix):
    from triton_kernels.nvfp4_moe import (
        nvfp4_grouped_gate_up_silu_sp01_autotuned,
        nvfp4_grouped_down_weighted_sum_sp01_autotuned,
    )
    inter = nvfp4_grouped_gate_up_silu_sp01_autotuned(
        fix['act_bf16'], fix['expert_ids'],
        fix['gate_up_packed'], fix['gate_up_scale'], fix['gate_up_global_scale'])
    out = nvfp4_grouped_down_weighted_sum_sp01_autotuned(
        inter, fix['expert_ids'], fix['routing_weights'],
        fix['down_packed'], fix['down_scale'], fix['down_global_scale'])
    return out.float()


def run_b5_w4a8_hybrid(fix):
    """B5: NEW W4A8 gate/up + Python SiLU + Triton down (hybrid Phase 1 candidate)."""
    from triton_kernels.nvfp4_moe import nvfp4_grouped_down_weighted_sum_sp01_autotuned

    ext = build_extension()
    # FP8 E4M3 activation with per-16 scale
    act_fp8, act_scale = quantize_fp8_e4m3_per16(fix['act_bf16'])
    gate_up_out = ext.w4a8_gate_up(
        act_fp8, act_scale, fix['expert_ids'].to(torch.int32),
        fix['gate_up_packed'], fix['gate_up_scale'], fix['gate_up_global_scale'],
        INTERMEDIATE,
    )
    gate = gate_up_out[:, :INTERMEDIATE]
    up = gate_up_out[:, INTERMEDIATE:]
    inter_f32 = F.silu(gate) * up
    inter_bf16 = inter_f32.to(torch.bfloat16)

    out = nvfp4_grouped_down_weighted_sum_sp01_autotuned(
        inter_bf16, fix['expert_ids'], fix['routing_weights'],
        fix['down_packed'], fix['down_scale'], fix['down_global_scale'])
    return out.float()


def run_b2_sp12_w4a4(fix):
    """B2: SP-12 W4A4 mirror baseline (= SP-13 B2) -- failure reference."""
    sys.path.insert(0, '/lynn-engine')
    from engine.spark_fp8 import _build_extension
    from triton_kernels.nvfp4_linear import quantize_fp4_m1_native
    from triton_kernels.nvfp4_moe import nvfp4_grouped_down_weighted_sum_sp01_autotuned

    ext = _build_extension()
    act_packed_fp4, act_scale_fp = quantize_fp4_m1_native(fix['act_bf16'].reshape(1, -1).contiguous())
    act_packed = act_packed_fp4.view(torch.uint8).reshape(-1).contiguous()
    act_scale_fp4 = act_scale_fp.to(torch.float32).reshape(-1).contiguous()

    gate_up_out = ext.gate_up(
        act_packed, act_scale_fp4, fix['expert_ids'].to(torch.int32),
        fix['gate_up_packed'], fix['gate_up_scale'], fix['gate_up_global_scale'],
        INTERMEDIATE,
    )
    gate = gate_up_out[:, :INTERMEDIATE]
    up = gate_up_out[:, INTERMEDIATE:]
    inter_f32 = F.silu(gate) * up
    inter_bf16 = inter_f32.to(torch.bfloat16)

    out = nvfp4_grouped_down_weighted_sum_sp01_autotuned(
        inter_bf16, fix['expert_ids'], fix['routing_weights'],
        fix['down_packed'], fix['down_scale'], fix['down_global_scale'])
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
    parser.add_argument('--out', default='/lynn-engine/reports/sp01_autotune/sp14_w4a8_math_contract.json')
    args = parser.parse_args()

    sys.path.insert(0, '/lynn-engine')
    device = torch.device('cuda')

    print('[sp14] device={} cap={}'.format(torch.cuda.get_device_name(0), torch.cuda.get_device_capability()))
    print('[sp14] distributions={} seeds_per={}'.format(args.distributions, args.seeds))

    # Build extension once upfront
    print('[sp14] building W4A8 kernel extension...')
    t_build = time.time()
    build_extension()
    print('[sp14] build done in {:.1f}s'.format(time.time() - t_build))
    print()

    backends = {
        'B1_triton_baseline': run_b1_triton_baseline,
        'B5_w4a8_hybrid_NEW': run_b5_w4a8_hybrid,
        'B2_sp12_w4a4_ref': run_b2_sp12_w4a4,
    }

    # Math contract thresholds (PASS criteria)
    THRESHOLD_COSINE = 0.999
    THRESHOLD_REL_L2 = 0.05

    all_results = {}
    pass_matrix = {}

    for dist in args.distributions:
        print('\n=== Distribution: {} ==='.format(dist))
        dist_results = {bname: {'cosine': [], 'rel_l2': [], 'max_abs': []} for bname in backends}
        for seed in range(args.seeds):
            fix = make_fixture(dist, device, seed)
            ref = run_reference(fix)

            for bname, bfn in backends.items():
                try:
                    out = bfn(fix)
                    torch.cuda.synchronize()
                    m = compute_metrics(out, ref)
                    dist_results[bname]['cosine'].append(m['cosine'])
                    dist_results[bname]['rel_l2'].append(m['rel_l2'])
                    dist_results[bname]['max_abs'].append(m['max_abs'])
                    print('  seed={} {}: cos={:.6f} rel_l2={:.6f} max_abs={:.3e}'.format(
                        seed, bname, m['cosine'], m['rel_l2'], m['max_abs']))
                except Exception as exc:
                    print('  seed={} {}: FAILED {}: {}'.format(seed, bname, type(exc).__name__, exc))
                    dist_results[bname]['cosine'].append(float('nan'))
                    dist_results[bname]['rel_l2'].append(float('nan'))
                    dist_results[bname]['max_abs'].append(float('nan'))
            del fix, ref
            torch.cuda.empty_cache()

        all_results[dist] = dist_results

    # Build PASS matrix and summary
    print('\n\n=== SUMMARY ({} seeds per distribution) ==='.format(args.seeds))
    print('{:<12} {:<22} {:<20} {:<20} {:<12} {}'.format(
        'Distribution', 'Backend', 'cosine (mean+/-std)', 'rel_l2 (mean+/-std)', 'max_abs', 'GATE'))
    print('-' * 110)
    for dist, dist_r in all_results.items():
        for bname, m in dist_r.items():
            c_mu, c_sd = safe_mean(m['cosine']), safe_stdev(m['cosine'])
            r_mu, r_sd = safe_mean(m['rel_l2']), safe_stdev(m['rel_l2'])
            x_mu = safe_mean(m['max_abs'])
            cos_s = '{:.6f}+/-{:.4f}'.format(c_mu, c_sd)
            rel_s = '{:.5f}+/-{:.4f}'.format(r_mu, r_sd)
            cell_pass = (c_mu >= THRESHOLD_COSINE) and (r_mu <= THRESHOLD_REL_L2)
            gate = 'PASS' if cell_pass else 'FAIL'
            pass_matrix.setdefault(bname, []).append(cell_pass)
            print('{:<12} {:<22} {:<20} {:<20} {:<12.3e} {}'.format(
                dist, bname, cos_s, rel_s, x_mu, gate))

    # Overall gate verdict
    print('\n=== Math Contract Gate Verdict ===')
    print('Threshold: cosine >= {}, rel_l2 <= {}'.format(THRESHOLD_COSINE, THRESHOLD_REL_L2))
    overall = {}
    for bname, passes in pass_matrix.items():
        all_pass = all(passes)
        overall[bname] = all_pass
        print('  {}: {} ({}/{} cells pass)'.format(
            bname, 'PASS ALL' if all_pass else 'FAIL', sum(passes), len(passes)))

    w4a8_passed = overall.get('B5_w4a8_hybrid_NEW', False)
    if w4a8_passed:
        print('\n[sp14] *** W4A8 mirror Math Contract Gate PASSED ***')
        print('[sp14] Next: 6-prompt greedy parity on real Lynn 27B (Gate 2)')
        print('[sp14] Next: 16k long-ctx smoke (Gate 3)')
    else:
        print('\n[sp14] *** W4A8 mirror Math Contract Gate FAILED ***')
        print('[sp14] Do NOT proceed to real-model gates. Debug kernel first.')

    summary = {
        'type': 'sp14_w4a8_math_contract_gate',
        'date': time.strftime('%Y-%m-%dT%H:%M:%S', time.localtime()),
        'device': torch.cuda.get_device_name(0),
        'compute_capability': list(torch.cuda.get_device_capability()),
        'thresholds': {'cosine': THRESHOLD_COSINE, 'rel_l2': THRESHOLD_REL_L2},
        'n_seeds_per_distribution': args.seeds,
        'distributions': args.distributions,
        'results': all_results,
        'overall_pass': overall,
        'math_contract_gate_passed': w4a8_passed,
    }
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(summary, indent=2, ensure_ascii=False))
    print('\n[sp14] report: {}'.format(out_path))

    return 0 if w4a8_passed else 1


if __name__ == '__main__':
    sys.exit(main())
