# 制片手册（Director workflow 的行业基线）

> 调研日期：2026-10-10。来源见每节末尾。数字是行业通行的起点，不是死规矩——导演（上层 Agent）可以为创意突破它们，但要有理由。
>
> 每条规则标明落地方式：**[检查]** = `mcp/director.mjs` 里的确定性检查，会作为 finding 出现在 `video_director_plan / preview / review` 里；**[渲染]** = 已内建在 Remotion 模板/字幕组件里；**[导演]** = 需要 Agent 看帧判断，工具不替它做审美决定。

## 1. 结构与时长

| 规则 | 数值 | 落地 |
|---|---|---|
| 开场钩子 | 前 3 秒决定去留，钩子在 3–5 秒内落地；用痛点、结果、反差开场，不用 logo 动画 | **[检查]** 首场景 > 5s 报 warning；开场内容 **[导演]** |
| 叙事骨架 | 0–5s 钩子/痛点 → 5–25s 展开问题 → 25–45s 方案 → 45–55s 差异化/佐证 → 收尾 CTA | **[导演]**；结尾 CTA **[检查]**（非 CTA 结尾报 nit） |
| 总时长 | 产品解说 60–90s；超过 90s 留存明显下降；竖屏短视频 ≤ 60s 为宜；社媒广告 15–30s | **[检查]** 16:9 > 90s、9:16 > 60s 报 nit |
| 一个场景一个节拍 | 单个静态镜头超过 ~10s 就显得拖；中途加小钩子提升完播 | **[检查]** > 10s 且非视频背景报 nit |

来源：[Zelios — Best video length 2026](https://zelios.agency/best-video-length/)、[Pexo — Explainer video best practices](https://pexo.ai/blog/explainer-video-best-practices-9457)、[Knowlify — Explainer video length guide](https://knowlify.com/articles/explainer-video-length-guide)、[Increditors — Video intro length](https://increditors.com/video-intro-length/)、[LunaBloom — Video best practices 2026](https://blog.lunabloomai.com/video-best-practices/)

## 2. 旁白语速与脚本长度

| 语言 | 舒适区间 | 本项目阈值 | 落地 |
|---|---|---|---|
| 中文 | 宣传片标准 210–220 字/分；播音 180–260 字/分；新闻 ~300 字/分 | > 260 字/分 nit，> 300 字/分 warning | **[检查]** |
| 英文 | ~150 wpm（60 秒稿 ≈ 140–150 词，留呼吸） | > 170 wpm nit，> 200 wpm warning | **[检查]** |

- 有音频时按真实音频时长算（audio-first），没有音频时按计划场景时长算——TTS 之前就能发现"这句话塞不进这个镜头"。
- 阈值用真实 Edge TTS 输出校准过：默认语速下 CCDub 旁白为 224–276 字/分，只有明显偏快的句子会被提示。
- 处理方式：删词或给场景更多时间。TTS 语速目前固定 `+0%`，不通过加速/减速来凑时长。

来源：[制片帮悦音 — 宣传片配音一分钟多少字](https://yueyin.zhipianbang.com/news/detail-9756.html)、[k1518 — 宣传片配音语速](https://www.k1518.com/show-146.html)、[Voicebros — 150 WPM script timing](https://voicebros.com/en/blog/voice-over-script-writing)、[The Voice Realm — VO words per minute](https://www.thevoicerealm.com/blog/voice-over-words-per-minute-script-timing/)

## 3. 字幕与安全区

| 规则 | 数值 | 落地 |
|---|---|---|
| 行长 | 英文 ≤ 42 字符/行；中文 ~16 字/行（Netflix 简中），最多 2 行 | 字幕按词组分组渲染 **[渲染]**；溢出 **[导演]** 看帧 |
| 阅读速度 | 英文 ≤ 17 CPS（成人）；中文 ≤ 9 字/秒 | 卡拉 OK 字幕跟随语音，语速检查覆盖 **[检查]** |
| 时长 | 单条 5/6 秒 – 7 秒；字幕与音频同步在 2–3 帧内 | 词级时间戳来自 TTS words.json **[渲染]** |
| 竖屏 UI 遮挡（1080×1920） | TikTok 底部 ~480px / 右侧 ~140px；Reels 底部 ~420px / 顶部 ~220px；Shorts 底部 ~320px / 右侧 ~180px | **[渲染]** 9:16 底部字幕抬高到画面 25%（距底 480px），宽度收到 74%；其他元素 **[导演]** 看帧 |
| 文字对比度 | WCAG AA：正文 4.5:1、大字 3:1；图上文字用 40–60% 黑色遮罩（scrim） | **[渲染]** 背景图叠 32–76% 渐变遮罩 + 46% 底色、字幕底板 62% + 描边阴影；**[导演]** 看帧确认 |
| 文字背后的运动 | 文字背后避免大面积运动（> 视野中心 10%） | Ken Burns 幅度克制（1.04→1.12）**[渲染]** |

来源：[Netflix — Timed Text Style Guide: Subtitle Timing](https://partnerhelp.netflixstudios.com/hc/en-us/articles/360051554394-Timed-Text-Style-Guide-Subtitle-Timing-Guidelines)、[Netflix — General Requirements](https://partnerhelp.netflixstudios.com/hc/en-us/articles/215758617-Timed-Text-Style-Guide-General-Requirements)、[Netflix 字幕制作风格指南（知乎）](https://zhuanlan.zhihu.com/p/503665159)、[Subanana — 中英字幕长度设定](https://subanana.com/zh-HK/blog/four-points-to-note-when-creating-video-subtitle)、[AdaptlyPost — Vertical video safe zones 2026](https://adaptlypost.com/blog/social-media-safe-zones-2026-complete-guide)、[Kreatli — Safe zone guide](https://kreatli.com/guides/safe-zone-guide)、[Smashing Magazine — Accessible text over images](https://www.smashingmagazine.com/2023/08/designing-accessible-text-over-images-part1/)、[W3C — Understanding SC 1.4.3](https://www.w3.org/TR/UNDERSTANDING-WCAG20/visual-audio-contrast-contrast.html)

## 4. 声音与响度

| 规则 | 数值 | 落地 |
|---|---|---|
| 交付响度 | YouTube/Spotify 以 -14 LUFS 为基准：更响会被压低，更轻**不会**被抬高；以人声为主的成片 -14 至 -16 LUFS | **[检查]** preview/finalize 用 FFmpeg EBU R128 测成片：> -13 或 < -19 LUFS 报 warning |
| 真峰值 | ≤ -1 dBTP（部分平台 -2） | **[检查]** > -1 dBFS 报 warning |
| 旁白 | 单条旁白先归一化 | 已有：`loudnorm=I=-16:LRA=7:TP=-1.5`（`scripts/lib/tts-audio.mjs`） |
| 背景音乐 | 起点比人声低 ~18dB，再凭耳朵调 | **[导演]**（品牌配置 `music.volume`） |

实测：ccdub-promo-zh-v1 成片为 -16.5 LUFS、真峰值 -4.9 dBFS，在目标区间内。

来源：[Critical Listening Lab — YouTube loudness](https://www.criticallisteninglab.com/en/learn/loudness/youtube)、[AudioForgePro — YouTube LUFS & true peak](https://audioforgepro.com/blog/youtube-lufs-normalization-guide)、[ClickyApps — LUFS targets for YouTube/TikTok/Spotify](https://clickyapps.com/creator/video/guides/lufs-targets-2025)、[Lance Blair — LUFS voiceover levels](https://lanceblairvo.com/lufs-voiceover-levels/)

## 5. 画面与运动

Remotion 实现细节（帧驱动动画、spring damping 200、Sequence、转场、素材 staging）见 [`docs/remotion-best-practices.md`](remotion-best-practices.md)。制片层面的要点：

- 不要连续纯文字卡片（**[检查]** 连续 > 2 张报 warning）；混用截图、产品画面、B-roll。
- 运动克制：Ken Burns、弹簧入场、视差、逐条揭示；不用廉价全屏特效。
- 先盘点已有素材再生成（asset-first）；生图走 `video_image_generate`，保留按次审批。

## 不做的事

- 工具不判断"好不好看"、不改写文案、不替 Agent 选镜头——这些留给上层导演看帧决定。
- 不引入付费平台 API，不新增 Pro 门槛；所有检查都是本地计算，对免费用户开放。
