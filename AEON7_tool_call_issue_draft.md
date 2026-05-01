## Summary

I observed a tool-calling regression with the `ghcr.io/aeon-7/vllm-spark-omni-q36:v1.2` / v2 Qwen3.6-35B-A3B-heretic NVFP4 setup on DGX Spark.

The model answers normal non-tool chat prompts, and the vLLM server is configured with the documented Qwen tool parser:

```text
--enable-auto-tool-choice
--tool-call-parser qwen3_coder
--reasoning-parser qwen3
```

However, when an OpenAI-compatible `tools` payload is present and `tool_choice` is `auto`, the model often does not commit to emitting a real tool call. Instead it spends the whole generation in reasoning about whether/how it should call the tool, then reaches the token limit with:

```text
content: null
tool_calls: []
finish_reason: length
```

This breaks agent workloads even though ordinary Q&A throughput looks excellent.

## Environment

- Hardware: DGX Spark / GB10 / `sm_121a`
- Image: `ghcr.io/aeon-7/vllm-spark-omni-q36:v1.2`
- Model: Qwen3.6-35B-A3B-heretic NVFP4, v2 multimodal-preserved layout
- Launch style: repo `examples/docker-compose.yml`
- Relevant flags:

```text
--served-model-name qwen36-35b-heretic qwen36-fast qwen36-deep
--quantization compressed-tensors
--enable-auto-tool-choice
--tool-call-parser qwen3_coder
--reasoning-parser qwen3
--speculative-config '{"method":"dflash","model":"/models/qwen36-dflash","num_speculative_tokens":15}'
```

## Minimal reproduction

```bash
curl -s http://localhost:8000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "qwen36-fast",
    "temperature": 0,
    "max_tokens": 2048,
    "tool_choice": "auto",
    "messages": [
      {
        "role": "user",
        "content": "Use the search_web tool to look up today'\''s Shenzhen weather, then answer in one short sentence."
      }
    ],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "search_web",
          "description": "Search the web for current information.",
          "parameters": {
            "type": "object",
            "properties": {
              "query": {
                "type": "string"
              }
            },
            "required": ["query"]
          }
        }
      }
    ]
  }'
```

## Expected behavior

The assistant should emit a parsed OpenAI tool call, for example:

```json
{
  "tool_calls": [
    {
      "type": "function",
      "function": {
        "name": "search_web",
        "arguments": "{\"query\":\"today Shenzhen weather\"}"
      }
    }
  ],
  "finish_reason": "tool_calls"
}
```

## Actual behavior

The model recognizes that a tool may be needed, but does not commit to the function call. It loops in reasoning until `max_tokens` is exhausted. The response has no usable content and no parsed tool call:

```text
finish_reason: length
content: null
tool_calls: []
```

Representative failure modes I saw:

1. Full reasoning pass, then EOS / no visible answer.
2. Lead-in text such as "I will check..." without a real tool call.
3. Markdown or pseudo-code describing a command/tool instead of emitting `tool_calls`.

## Control comparison

With the same OpenAI-compatible client path and Qwen parser:

- A non-heretic Qwen3.6-35B-A3B FP8 deployment emits real tool calls.
- The AEON-7 NVFP4/heretic deployment answers non-tool prompts normally.
- The failure appears specifically when the `tools` array is present and the model needs to decide whether to call.

That makes this look less like a vLLM parser/config problem and more like a model-behavior issue around tool-call decisiveness. My hypothesis is that the heretic / abliteration process may have weakened the "commit to tool emission" behavior while preserving general chat quality and throughput.

## Why I am opening this

The repo docs currently advertise agentic/OpenClaw usage and include:

```text
--tool-call-parser qwen3_coder
--enable-auto-tool-choice
```

So users may reasonably expect OpenAI-style tool calls to work. If tool calling is not a supported target for the heretic NVFP4 weights, it would be useful to document that limitation. If it is intended to work, this may need either:

- a non-heretic / tool-preserved quantization path,
- an upstream heretic weight fix,
- a suggested prompt/template workaround, or
- a tool-call smoke test in the benchmark suite.

Thanks for the Spark work here. The throughput is excellent; I am mainly reporting this because it is a 0/1 blocker for agent workloads.
