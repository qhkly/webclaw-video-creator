# Remotion 最佳实践（项目内 vendored 指南）

本文件是给 AI 导演（Claude Code / Codex / ChatGPT 等 directing agent）和人类贡献者的
**项目内固定版本**参考资料，摘编自 Remotion 官方为 coding agent 发布的
Agent Skills 仓库。

- **来源**：<https://github.com/remotion-dev/skills>（`skills/remotion/SKILL.md` + `rules/*.md`）
- **Vendor 版本**：master@2026-10-08（快照时仓库无版本 tag；以 README/rules 目录结构为准）
- **升级方式**：
  1. 官方安装命令（装进用户全局/项目 `.claude/skills`，会污染共享环境，本项目**默认不用**）：
     `npx skills add remotion-dev/skills`
  2. 本项目的做法：重新对照上游 rules 目录，人工把差异合入本文件（保持"与本仓库实际用到的
     API 一致"的裁剪原则），并在提交信息里注明对照的上游 commit 日期。
- **本项目 Remotion 版本**：`^4.0.355`（见 `package.json`）。

官方 rules 覆盖面很广（3D、charts、Lottie、GIF、Tailwind……）；这里只保留与本项目
`remotion/src/` 模板和导演工作流直接相关的部分，并注明本项目对应的落点。

## 1. 动画必须由帧驱动（官方 rules/animations.md）

- 一切动画用 `useCurrentFrame()` 驱动；时间写秒再乘 `useVideoConfig().fps`。
- **禁止 CSS transition / CSS animation / Tailwind 动画 class**——服务端渲染帧时不生效。
- 本项目落点：所有模板（`remotion/src/compositions/*.tsx`）都用 `interpolate`/`spring`
  + `frame` prop，符合该规则；新增动效必须延续这个写法。

## 2. 插值与弹簧（官方 rules/timing.md）

- `interpolate(frame, [a, b], [from, to])` 默认不 clamp，超出区间会外推；入场/退场动画
  通常要 `{ extrapolateRight: 'clamp', extrapolateLeft: 'clamp' }`。
- `spring({ frame, fps })` 走物理曲线，从 0 到 1：
  - 自然不回弹：`config: { damping: 200 }`（官方推荐的"subtle reveal"配置）；
  - 轻快 UI 感：`{ damping: 20, stiffness: 200 }`；
  - 回弹入场只用于俏皮场景：`{ damping: 8 }`。
- 弹簧输出 0–1，用 `interpolate(springProgress, [0, 1], [x, y])` 映射到位移/缩放/旋转。
- 入场+退场可以用两个 spring 相减：`scale = inSpring - outSpring`。
- 本项目落点：`TitleSlide` 等用 `spring({ config: { damping: 18 } })` + `interpolate`
  clamp，符合；克制原则见第 7 节。

## 3. 时间轴与场景编排（官方 rules/sequencing.md）

- `<Sequence from durationInFrames>` 延迟元素出现；`<Series>` 让片段首尾相接。
- 官方建议给 `<Sequence>` 加 `premountFor` 提前挂载（预热图片/视频解码）。
- Sequence 内部的 `useCurrentFrame()` 是**局部帧**（从 0 开始），不是全局帧。
- 本项目落点：`VideoComposition` 手动累加 `from` 等价于 `<Series>`；如引入
  `premountFor` 需要升级 Remotion 版本时再评估。

## 4. 场景转场（官方 rules/transitions.md）

- 官方方案是 `@remotion/transitions` 的 `<TransitionSeries>` + `fade()/slide()/wipe()`
  + `linearTiming()/springTiming()`；转场会**重叠**相邻场景，总时长要减去转场时长。
- 本项目尚未安装该包；目前的"转场"是每个模板自带的入场/退场（crossfade 风格）。
  如需真正的整屏转场，再按官方命令安装：
  `npx remotion add @remotion/transitions`，并同步更新本文件与 `render.mjs` 时长计算。

## 5. 素材、音频与时长（官方 rules/assets.md / audio.md / get-audio-duration.md）

- 本地文件（TTS 音频、生成图片）渲染时不能走 `file://`：本项目 `scripts/lib/stage-media.mjs`
  已实现官方推荐等价方案——拷进 bundle `publicDir` 再用 `staticFile()`（`static:` 前缀）。
- **audio-first**：场景时长以真实音频时长为准（`video_tts_synthesize` 写回
  `duration = ceil(audio.duration)`），词级时间戳驱动字幕，而不是先定时长再配音。
- 视频 B-roll 用 `<OffthreadVideo>`（`Background.tsx` 已用）， muted 背景不抢旁白。

## 6. 字幕（官方 rules/display-captions.md）

- 官方模式：词级时间戳 → 分组（TikTok 风格页 + 当前词高亮）。本项目
  `remotion/src/caption-groups.ts` + `Captions.tsx` 已实现同款：按 16 单位/650ms 停顿分组、
  当前词高亮、长停顿后消失，避免残留旧句。
- 字幕安全区：底部 92×scale，避开模板正文（模板内容居中/上移）。9:16 竖屏时注意
  `fontSize` 随 `useScale()` 缩放，不遮挡画面主体。

## 7. 视觉质量底线（导演工作流约定；结合官方 measuring-text.md 的思路）

- 默认避免"纯文字卡片连续播放"：超过 2 个连续场景没有任何视觉资产
  （背景图/视频、ImageFrame 图）时，导演检查会告警（`mcp/director.mjs`）。
- 动效克制：Ken Burns（1.04→1.12 缩放 ±18px 平移，`Background.tsx`）、spring 入场
  （damping 18–200）、reveal/opacity 渐入；**不做**满屏抖动/闪烁/旋转等廉价特效。
- 文字溢出：官方提供 `@remotion/layout-utils` 的 `measureText()/fitText()/fillTextBox()`
  精确测量；本项目当前用排版留白 + 导演侧字符数启发式检查（`mcp/director.mjs`），
  若出现实际溢出再引入该包精确测量。
- CTA/品牌收尾单独设计（`CTA` 模板），不复用正文模板凑数。

## 8. 渲染流程（官方 render 实践 + 本项目约定）

- 先低清预览（720p）+ 抽帧/contact sheet 做视觉自检，再最终高分辨率渲染；
  对应 `video_director_preview` / `video_director_finalize`。
- 长视频渲染是慢操作（分钟级）：MCP 端已支持 `notifications/progress`。
