#!/usr/bin/env node
/**
 * 本脚本已弃用 — 请看同目录 README.md 的 "LYNN_ERLE_RECORD_DIR" 路径。
 * 原设想走 sox + BlackHole,但 macOS 默认没装,且 Lynn 自己的 voice-ws 已经
 * 同时持有 mic/TTS 两路 PCM,内置双轨录制最简洁。
 */
console.error("此脚本已弃用,改用 voice-ws 的 LYNN_ERLE_RECORD_DIR 开关:");
console.error("  LYNN_ERLE_RECORD_DIR=/tmp/lynn-erle npm run dev");
console.error("  → 说一段话等 AI 回复 → 关 overlay → 看 /tmp/lynn-erle/*-{mic,tts}.wav");
console.error("  → node spike/05-erle-test/erle-bench.mjs <tts> <mic>");
process.exit(1);
