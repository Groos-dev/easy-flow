# pet 素材（clawd / cloudling）

看板卡片上那只 pet 的素材，来自开源桌面应用 **clawd-on-desk**。一个 agent 一套形象：

- **Claude** → clawd 像素螃蟹（`themes/clawd`），走 `<img>`
- **Codex** → cloudling 云宝（`themes/cloudling`，作者 stlabslogo），走 `<object>`

通道不同是有原因的：clawd 每张 SVG 自带 `<style>` 与 `@keyframes`，内联到一张卡里会撞名，`<img>` 让每个
SVG 文档独立、CSS 天然隔离；cloudling 的 27/28 个文件是脚本驱动（`requestAnimationFrame` + `setAttribute`），
`<img>` 会禁脚本、只剩一朵静止的云，所以必须用 `<object>`。状态映射写在
`src/renderer/src/lib/pet-art.ts`。

## 许可（原文见 `.pet-src/LICENSE.clawd`）

> **All Rights Reserved.** … you may NOT copy, modify, distribute, or use any artwork from this
> directory without explicit written permission from the copyright holder(s), **except for personal
> use of the Clawd on Desk application as distributed by this project**.
>
> **The Clawd character is the property of Anthropic.** Clawd pixel art in this project is
> fan-created and may not be used for commercial purposes.

例外只覆盖「使用 Clawd on Desk 这个应用本身」，把图拷进另一个应用不在例外里；Clawd 这个角色本身
是 Anthropic 的。这里按「本地自用、不公开分发」处理：素材留在本地仓库，**不要 push**。

## 文件

| 文件 | 用途 |
| --- | --- |
| `clawd-*.svg` | Claude 六档状态的大图（44px 卡片）+ 折叠卡用的小号 mini |
| `cloudling-*.svg` | Codex 六档状态的大图（44px 卡片）+ 折叠卡用的小号 mini |
| `*.still.svg` | 同上，`prefers-reduced-motion` 时换这一份（两份都停掉动画） |
| `*.svg` 文件头 | 每份素材的来源与许可说明 |

只落地六档要用的那几张（clawd 6 + mini 5，cloudling 6 + mini 5），`.pet-src/` 里多出来的状态
（yawn / sleeping / juggling …）不生成。

## 重新生成

```bash
node scripts/build-pets.mjs   # 需要 .pet-src/ 里有 clawd + cloudling 原始素材
```

**仅本机可重跑**：脚本依赖的 `.pet-src/`（原始拷贝）被 `.gitignore` 忽略，且只有本机有；
干净 clone 里跑不了，只能拿到已提交的生成物。脚本会重设 `viewBox`（原始留白过大，
44px 里角色只有十几个像素）并另写一份静态版。

## 已知差异（别当 bug）

- **clawd 的 `done` / `failed` 是无限循环**：`clawd-happy.svg` / `clawd-error.svg` 自带
  `infinite` 动画，读了事件之后仍持续动，六档同屏时也各自动各自的。这是素材自带行为，
  用户已确认接受，不改成一次性。
- **两份静态版的停法不一样**：
  - clawd（`<img>`）进不去文档内部，构建期另出 `*.still.svg` 注入 `animation: none`；
    基础 `opacity: 0`、只靠 keyframes 显形的装饰（happy 的星星、thinking 的气泡与圆点、
    notification 的灯泡与光晕、mini-alert 的惊叹号）在生成时按文件置为可见，否则冻结后永久消失。
    error 的烟雾基础位置在头顶之外、硬置可见会悬空，所以取「无烟雾」的那一帧。
  - cloudling（`<object>`）是脚本驱动，`animation: none` 停不了 JS。它的 `.still.svg` 保留脚本、
    只给 `requestAnimationFrame` 套一道闸：放行首帧后不再调度——眼睛与姿态是脚本画的，整段剥掉
    会剩一朵没有表情的云（五档会变空）；首帧里表情/姿态已就位，且只画一帧。
