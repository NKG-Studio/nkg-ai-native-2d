---
name: frameloop-video-to-sprite
description: 编排 FrameLoop MCP，将本地视频（包括一个视频中的多段序列帧动作）转换为经过多模态复核的 PNG 动作序列和已校验的 Sprite Atlas。用于 Codex 需要分析视频循环、分页复核动作、批量抽帧、抠图精修、生成 Generic/Aseprite/Godot/Unity 图集或验证最终交付物时。
---

# FrameLoop 视频转图集

使用 FrameLoop MCP 完成可审计的视频到 Sprite Bundle 工作流。把 MCP 当作执行与分析层，把本 Skill 当作编排、确认和质量门禁层。

## 工作原则

- 先分析和复核，后写入用户目录。
- 复核所有动作页；不要只采用启发式分数最高的候选。
- 优先选择最早完整主体动作循环；不要被特效、武器或局部摆动的短周期误导。
- 使用排他结束帧，避免把与首帧重复的闭环帧再次导出。
- 默认使用 `fail` 冲突策略；只有用户明确授权覆盖时才使用 `replace`。
- 在 `validate_sprite_bundle` 返回 `valid: true` 前，不要宣称最终图集完成。
- 明确披露采样 FPS、重采样、疑似漏分段和人工判断等限制。

## 前置检查

1. 确认 `frameloop` MCP 工具可用。若不可用，停止工作并指导用户构建、注册 MCP 和重启 Codex；不要假装调用工具。
2. 确认输入是 MCP 进程所在机器可访问的本地路径。
3. 确认用户期望的输出根目录、图集预设、透明背景需求和覆盖策略。缺省使用：
   - 分析 FPS：`12`
   - Bundle 预设：`generic`
   - Trim：`tight`
   - 冲突策略：`fail`
4. 对快速像素动画提高分析 FPS；对慢动作可保留默认值。不要声称分析 FPS 等于源视频逐帧保真。

## 维护运行记录

在整个任务中持续保存以下状态，不要依赖重新推断：

- `video_path`、媒体信息和分析 FPS
- `report_id`
- 已复核的动作分页范围与 `hasMore`
- 每段的名称、`action_index`、起始帧、`export_end_exclusive`、重复末帧判断、置信度和理由
- `plan_id`、冲突策略和用户确认状态
- 每段导出目录、动作 Manifest 和最终帧路径
- Bundle Manifest、Atlas、引擎配套文件和验证结果

## 执行工作流

### 1. 检查并分析视频

1. 调用 `inspect_video`，检查时长、尺寸、FPS、编码和容器。
2. 调用 `analyze_video_loop`。按已知动作速度设置 `fps`、最短/最长循环和窗口；未知时使用默认值并在结果中披露。
3. 保存 `report_id`、采样信息、动作数量、候选数量和场景切分。
4. 若动作数量与视频概览明显不符、候选为空或证据被截断，读取 [失败回退](references/recovery.md)，不要直接导出。

### 2. 分页复核所有动作

1. 调用 `review_video_action_segments`，从 `action_offset: 0` 开始分页。
2. 持续调用直到 `hasMore` 为 `false`；必要时用 `read_analysis_report` 查看完整窗口、候选和场景切分。
3. 对每段查看八帧动作概览和每个候选的六帧接缝。
4. 按 [质量门禁](references/quality-gates.md) 选择动作名称、开始帧和排他结束帧。
5. 若不同动作被合并、同一动作被误切或无法判断完整周期，读取 [失败回退](references/recovery.md)。不要把低置信度选择伪装成确定结果。

### 3. 计划并导出动作帧

单动作且边界已明确时，可调用 `export_reviewed_action`。多动作必须执行以下步骤：

1. 调用 `create_action_export_plan`，传入全部已复核动作。
2. 汇总计划中的动作名称、边界、预计帧数、输出目录、空间估算和冲突。
3. 在用户尚未明确授权执行该计划时，等待用户确认；计划阶段不得写入用户输出目录。
4. 确认后调用 `export_action_batch`。
5. 检查每项状态。存在 `failed` 时不要进入 Bundle 阶段；存在 `skipped` 时说明原因并确认是否接受不完整交付。

### 4. 选择背景处理

- 保留原背景：直接使用动作 PNG。
- 纯色或绿幕背景：优先调用 `apply_chroma_key_batch`。
- 复杂背景：调用 `apply_ai_matte_batch`，并披露本地模型可能需要下载且结果需要复核。

需要透明背景时：

1. 对所有输出调用 `analyze_matte_quality`。
2. 检查可疑孤立区域、主体孔洞和半透明边缘；不要把正常抗锯齿透明像素自动视为错误。
3. 仅根据明确坐标调用 `refine_matte_batch`；自动清理必须使用保守阈值。
4. 精修后再次调用 `analyze_matte_quality`，直到通过 [质量门禁](references/quality-gates.md) 或用户明确接受剩余风险。

### 5. 合并并验证 Sprite Bundle

1. 从成功导出的动作目录或精修目录收集按播放顺序排列的帧路径。
2. 调用 `export_sprite_bundle`，为每个动画提供唯一、稳定的名称。仅在用户指定时选择 Aseprite、Godot 或 Unity 预设。
3. 调用 `validate_sprite_bundle`。
4. 若 `valid` 为 `false`，按错误修复并重新导出；若只有警告，按 [质量门禁](references/quality-gates.md) 处理并披露。
5. 用户需要逐张最小 PNG 时，在验证通过后调用 `slice_sprite_sheet`，传入 Bundle Manifest；不要从预览图或截图反推已有 Manifest 的帧坐标。
6. 用户只提供外部图集时，先调用 `inspect_sprite_sheet_layout`，同时查看原图与候选叠加图。启发式建议不是最终决定；根据视觉复核选择 `grid`、`components`，或用 `regions` 明确提供 `rect`、`rotated_rect`、`polygon`。
7. 再次验证，直到 `valid: true`。

## 完成交付

仅在所有必需动作导出成功且 Bundle 验证通过后，报告完成。最终答复必须包含：

- 源视频和分析 FPS
- 动作列表、各动作帧数及复核置信度
- Atlas PNG、Bundle Manifest 和引擎配套文件路径
- 若请求独立切图：Sprite 输出目录、`sprites.json` 和实际切出帧数
- 逐动作 Manifest 或输出目录
- `validate_sprite_bundle` 的 `valid`、错误、警告和关键诊断
- 任何重采样、手工边界、低置信度或未解决的抠图风险

不要把 MCP 的启发式候选置信度描述为语义正确概率，也不要承诺支持任意视频无人值守一次成功。
