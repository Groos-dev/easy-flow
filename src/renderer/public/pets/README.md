# pet 素材（clawd / cloudling）

看板卡片上那只 pet 的素材，来自开源桌面应用 **clawd-on-desk**。一个 agent 一套形象：

- **Claude** → clawd 像素螃蟹（`themes/clawd`），走 `<img>`
- **Codex** → cloudling 云宝（`themes/cloudling`，作者 stlabslogo），**内联成 `<svg>`**

通道不同是有原因的。clawd 每张 SVG 自带 `<style>` 与 `@keyframes`，内联到一张卡里会撞名，
`<img>` 让每个 SVG 文档独立、CSS 天然隔离。cloudling 的 27/28 个文件是脚本驱动
（`requestAnimationFrame` + `setAttribute`），`<img>` 会禁脚本、只剩一朵静止的云；而给它一个独立
文档（`<object>`）的话，那份文档的画布在 Chromium 里**恒为不透明**——`background: transparent`
实测无效，暗色卡片上就是一块白方块（clawd-on-desk 自己没这问题，因为它的 pet 窗口是
`transparent: true` 的独立窗口）。所以云宝内联进宿主 DOM：内联的 SVG 是普通元素，背景天然透明、
跟着主题走。状态映射与实例级 id 改写写在 `src/renderer/src/lib/pet-art.ts`。

## 许可

两套素材（clawd / cloudling）的版权与授权条款原文见 `.pet-src/LICENSE.clawd`。

## 文件

| 文件 | 用途 |
| --- | --- |
| `clawd-*.svg` | Claude 各档状态的大图（44px 卡片）+ 折叠卡用的小号 mini |
| `clawd-*.still.svg` | 同上，`prefers-reduced-motion` 时换这一份（`animation: none`） |
| `README.md` | 本文件 |

云宝不在这里——它只以内联的形态出现，素材落在生成物 `src/renderer/src/lib/pet-cloudling-art.ts`
（17 档：常驻状态 + 静止那串打哈欠 / 打盹 / 瘫倒 / 睡着 + 折叠卡 mini，failed 复用 mini-alert）。

## 重新生成

```bash
node scripts/build-pets.mjs   # 需要 .pet-src/ 里有 clawd + cloudling 原始素材
```

`.pet-src/` 里的原始素材与生成物都在仓库里，clone 下来就能重跑。脚本会重设 `viewBox`（原始留白过大，
44px 里角色只有十几个像素），clawd 另写一份静态版。

## 已知差异（别当 bug）

- **clawd 的 `done` / `failed` 是无限循环**：`clawd-happy.svg` / `clawd-error.svg` 自带
  `infinite` 动画，读了事件之后仍持续动，同屏多只时也各自动各自的。这是素材自带行为，
  用户已确认接受，不改成一次性。
- **两份静态版的停法不一样**：
  - clawd（`<img>`）进不去文档内部，构建期另出 `*.still.svg` 注入 `animation: none`；
    基础 `opacity: 0`、只靠 keyframes 显形的装饰（happy 的星星、thinking 的气泡与圆点、
    notification 的灯泡与光晕、mini-alert 的惊叹号）在生成时按文件置为可见，否则冻结后永久消失。
    error 的烟雾基础位置在头顶之外、硬置可见会悬空，所以取「无烟雾」的那一帧。
  - 云宝是脚本驱动，`animation: none` 停不了 JS。挂载时给它的 `requestAnimationFrame` 套一道闸：
    放行首帧后不再调度——眼睛与姿态是脚本画的，整段剥掉会剩一朵没有表情的云；首帧里表情与姿态
    已就位，且只画一帧。同一个闸还负责「元素离开文档就不再排下一帧」，否则每换一次状态都会多一条
    空转的 rAF。见 `src/renderer/src/components/Pet.tsx` 的 `inlineShell`。
