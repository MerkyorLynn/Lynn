---
name: storyboard
description: "故事板生成：输入小说段落或场景描述，自动分镜并批量生成插图，保存到书桌 gallery/ 目录。"
tags: ["image", "creative", "novel"]
---

# Storyboard 故事板生成

当用户要求"给这段小说配插图"、"生成故事板"、"画分镜"时使用。

## 生成流程

1. **解析场景**：从用户输入中提取 3-5 个关键场景/镜头
2. **优化 Prompt**：将每个场景转为高质量英文图像 prompt（含风格、光线、构图）
3. **批量生成**：逐个调用 generate_image，seed 保持相同或递增以保证风格一致
4. **保存归档**：所有图片放入书桌 `gallery/storyboard_xxx/` 子目录
5. **输出清单**：列出每幅图的编号、场景描述和文件路径

## 风格建议
- 网文/古风：chinese ink painting, fantasy art
- 现代都市：photorealistic, cinematic lighting
- 科幻：cyberpunk, futuristic, neon lights
- 儿童/童话：watercolor, Studio Ghibli style

## 注意事项
- 每次批量不超过 5 张，避免 provider 限流
- 生成前确认用户期望的风格和尺寸
- 若用户未指定尺寸，默认 768x1024（竖屏，适合小说插图）
