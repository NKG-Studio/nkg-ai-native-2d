<div align="center">

# FrameLoop Studio

**让 2D 动画自己找到完美循环。**

从视频抽帧、智能循环分析、抠图修边，到 Sprite Sheet 与游戏引擎数据导出；既可以在浏览器中手动精修，也可以通过 MCP 交给 AI 完成批处理。

[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![Vite](https://img.shields.io/badge/Vite-7-646CFF?logo=vite&logoColor=white)](https://vite.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-STDIO-C5F76B)](https://modelcontextprotocol.io/)

</div>

![FrameLoop Studio 循环分析工作台](docs/images/frameloop-studio-cover.png)

## 为什么需要它

视频转序列帧并不难，难的是从几十甚至几百帧中找到真正自然的循环：首尾画面相似，不代表动作速度和方向也连续；重复末帧还可能在游戏里产生肉眼可见的停顿。

FrameLoop Studio 会分析周期、自相似、首尾闭合、运动能量、运动方向、静止片段和重复帧，给出多个可解释的循环候选。你可以直接采用候选，也可以在非破坏时间线上逐帧隐藏、恢复、重排和对比，最后再完成抠图与导出。

## 核心能力

- **视频本地抽帧**：原生 Video + Canvas 定点采样，素材无需上传服务器。
- **自动循环检测**：返回多个候选区间、置信度和分项诊断，不只比较首尾像素。
- **可视化精修**：差异曲线、重复帧/镜头切换标记、A/B 接缝对比、缩放时间线及完整撤销/重做。
- **抠图与修边**：任意色度键、Alpha 羽化、三帧时序稳定，以及独立的线性光前景色恢复 / 边缘去色溢出；调 Alpha 时不再靠侵蚀主体来消除彩边。
- **浏览器本地 AI 抠图**：按需加载 BEN2 置信度引导 Matting，优先 WebGPU，失败时自动回退 WASM。
- **专业 Sprite Sheet**：支持规则网格和 Tight Trim 紧凑排布、透明边界裁切、Pivot、逐帧时长与动画命名。
- **引擎友好导出**：PNG 配套 Generic、Aseprite、Godot 和 Unity 数据预设。
- **项目恢复**：视频、帧编辑、循环区间、抠图蒙版和导出设置均可保存到 IndexedDB。
- **AI 自动化接口**：本地 STDIO MCP 可探测视频、分析循环、导出帧和合成 Sprite Sheet，并返回候选接缝图供多模态模型复核。

## 五分钟上手

需要 Node.js 20 或更高版本。MCP 已包含对应平台的 FFmpeg/FFprobe npm 二进制依赖，不要求全局安装 FFmpeg。

```bash
git clone https://github.com/wqaetly/nkg-ai-native-2d.git
cd nkg-ai-native-2d
npm install
npm run dev
```

打开 `http://localhost:5173`，然后按下面的流程操作：

1. 拖入视频，设置分析 FPS、局部计算窗口与最短循环；工具会流式扫描完整视频，不再按最大帧数截断。
2. 查看自动候选和 A/B 接缝对比，确认或手动微调循环区间。
3. 选择色度键或本地 AI 抠图，用笔刷修复需要保留/移除的细节。
4. 选择排布、Pivot、帧时长与目标预设，导出 PNG 和配套数据。

没有合适素材时，可以直接点击页面中的 **载入内置 Demo** 体验完整工作流。

## 导出格式

| 预设 | 生成内容 | 适用场景 |
| --- | --- | --- |
| Generic JSON | Sprite Sheet PNG + 完整 Manifest | 自研引擎、脚本和二次转换 |
| Aseprite JSON | `frames`、`frameTags`、时长和裁切信息 | Aseprite CLI/工作流兼容数据 |
| Godot | Sprite Sheet PNG + `.tres` + companion JSON | `SpriteFrames` / `AtlasTexture` 动画资源 |
| Unity JSON | Sprite Sheet PNG + Unity 导入元数据 | 编辑器导入脚本、自定义 AssetPostprocessor |

Godot 预设用 `AtlasTexture` 的 `region` 与 `margin` 还原裁切帧；Unity 预设会转换到底部为原点的坐标，并输出归一化 Pivot 和 Pixels Per Unit。Unity 当前提供 JSON，而不是直接生成 `.meta`，避免覆盖项目自身的 GUID 与导入配置。

## 本地 AI 与隐私

首次使用 AI 抠图时，浏览器会从 Hugging Face 下载 BEN2 ONNX 模型，后续由浏览器缓存。视频帧、手工蒙版和推理结果不会由本项目上传。

BEN2 面向通用前景对象并会重点细化不确定边缘。对于纯色背景，色度键路径还会用已知背景色恢复半透明像素的前景 RGB，并只在轮廓局部抑制烘焙进去的色溢出；主体内部颜色不会随羽化参数一起被改写。顶部的 **保存项目** 会把当前工作写入浏览器 IndexedDB；目前提供一个“最近项目”槽位，新保存会覆盖旧存档，但不会修改磁盘上的源文件。

## 让 Codex 等 AI 调用

先构建 MCP 服务：

```bash
npm run build --workspace @frameloop/mcp
```

然后把 [.codex/config.toml.example](.codex/config.toml.example) 复制到你的项目配置，或执行：

```bash
codex mcp add frameloop -- node apps/mcp/dist/index.js
```

重启客户端后可以调用：

| MCP 工具 | 作用 | 写入文件 |
| --- | --- | --- |
| `inspect_video` | 读取时长、尺寸、FPS 与编码信息 | 否 |
| `analyze_video_loop` | 流式扫描完整视频，检测动作硬切，并筛选段首闭环与段内稳定周期 | 仅写临时报告缓存 |
| `read_analysis_report` | 分页读取任意长度视频或图片序列的窗口、动作段和候选结果 | 否 |
| `review_video_loop_candidates` | 按页回传候选循环首尾帧接缝图，供多模态 AI 复核 | 否 |
| `review_video_action_segments` | 回传每段八帧概览和候选六帧接缝图，供 AI 判断动作语义与最早完整闭环 | 否 |
| `analyze_sprite_sequence` | 分析图片序列的主周期、重复帧和镜头切换 | 否 |
| `export_loop_frames` | 按时间区间与 FPS 导出 PNG 序列 | 是 |
| `export_reviewed_action` | 按 AI 确认的排他结束帧导出动作并保存复核清单 | 是 |
| `compose_sprite_sheet` | 合成透明 Sprite Sheet 与 JSON 索引 | 是 |
| `create_action_export_plan` | 预检多个动作的边界、名称、冲突、文件数和磁盘空间 | 仅写临时计划 |
| `export_action_batch` | 按计划批量导出多个动作，支持失败、跳过和替换冲突策略 | 是 |
| `export_sprite_bundle` | 将多个动画合并为 Tight/Grid Atlas，并生成 Generic、Aseprite、Godot 或 Unity 数据 | 是 |
| `validate_sprite_bundle` | 检查 Atlas、Manifest、引擎配套文件、重复末帧、接缝与 Alpha 抖动 | 否 |
| `apply_chroma_key_batch` | 批量色度键、三帧时序稳定与边缘去色溢出 | 是 |
| `apply_ai_matte_batch` | 使用本地 BEN2/Transformers.js 批量生成透明 PNG | 是 |

长视频分析、图片序列分析、帧导出、Sprite 合成和批量抠图均支持 MCP 标准进度通知；客户端提供 `progressToken` 后即可显示持续进度。批量导出采用“先计划、后执行”两阶段设计：计划阶段不会写用户输出目录，执行前可以检查所有动作边界、文件冲突和预计磁盘占用。

推荐工作流：

1. AI 调用 `inspect_video` 和 `analyze_video_loop`，获得硬切动作段及每段 3–5 个代表候选。
2. AI 分页调用 `review_video_action_segments`，同时观察全段动作概览和候选接缝前后三帧。
3. AI 返回动作名称、最早有效结束帧、末帧是否重复首帧和 `export_end_exclusive`。
4. 单个动作可调用 `export_reviewed_action`；多个动作先调用 `create_action_export_plan`，确认计划后再调用 `export_action_batch`。
5. 需要透明背景时调用 `apply_chroma_key_batch` 或 `apply_ai_matte_batch`，最后使用 `export_sprite_bundle` 合并多动画 Atlas，并用 `validate_sprite_bundle` 做闭环校验。

## 循环评分是怎样工作的

算法先使用相对局部运动的突变检测硬切，即使角色占画面较小、背景颜色不变，也能发现直接从 idle 切到跑步的动作边界。每段同时保留 `segment_anchor`（从硬切段首开始）和 `periodic_core`（段内最早稳定周期）候选，再综合以下信号筛选起止点：

- `closure`：接缝两侧帧的感知距离。
- `motionMismatch`：接缝前后运动能量与质心速度方向差。
- `periodicityMismatch`：候选长度在序列自相似矩阵中的周期误差。
- `appearanceMismatch`：区间首尾的外观差异。
- `staticPenalty`：避免把几乎不动的片段误判成高质量循环。
- `duplicatePenalty`：识别会造成停顿的重复末帧。

这些可解释指标负责稳定地缩小范围，多模态模型则可以继续判断“挥刀是否收势”“脚步是否落地”等动作语义。

## 开发与验证

```bash
npm run typecheck
npm test
npm run build
```

```text
apps/web       React 浏览器工作台
apps/mcp       本地 STDIO MCP 服务
packages/core  循环检测与 Sprite 布局算法
```

## 当前边界与路线图

- 浏览器端会先用低分辨率特征流扫描完整视频，再只加载最佳循环候选的原始帧进入时间线；“分析窗口”控制单次计算量，不会截断视频。
- MCP 端直接消费 FFmpeg 原始像素流并使用重叠窗口，内存占用与视频总长度解耦；完整窗口结果写入临时报告，可由 `read_analysis_report` 分页读取。
- 动作分段使用局部突变而不是传统全画面固定阈值；候选同时覆盖段首闭环和段内周期核心，既支持直接起跑的规范循环，也支持带入场 / 收势的动作段。
- AI 复核图包含全段八帧概览和 `END-2 / END-1 / END / START / START+1 / START+2` 六帧接缝，可区分主体完整动作与火焰、衣摆等局部微循环。
- 自动评分是候选排序，不是绝对真值；动作语义仍建议由人或多模态模型复核。
- 项目存储目前只有一个本地槽位，尚未提供多项目命名、缩略图和配额管理。
- Unity 预设需要项目侧导入脚本；后续会提供可直接放入 `Editor/` 的导入器。
- 下一阶段计划加入稠密光流闭合误差、动作相位语义模型、可恢复 MCP Tasks，以及 Streamable HTTP 远程部署。

## 第三方项目

产品边界受到 [FrameRonin](https://github.com/systemchester/FrameRonin) 启发，本项目使用独立代码和独立架构实现。

- [BEN / BEN2](https://arxiv.org/abs/2501.06230)：置信度引导 Matting 的通用前景分割；浏览器使用 [MIT 许可的 Transformers.js ONNX 转换](https://huggingface.co/onnx-community/BEN2-ONNX)。
- [Transformers.js](https://github.com/huggingface/transformers.js)：Apache-2.0，提供浏览器 ONNX Runtime、WebGPU 与 WASM 推理。

如果这个工具帮你省下了逐帧试循环的时间，欢迎 Star、提交 Issue，或分享你的动画工作流。
