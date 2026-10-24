# pet 素材（clawd / cloudling / cxb / cursor）

看板卡片上那只 pet 的素材。一个 agent 一套形象：

- **Claude** → clawd 像素螃蟹（`.pet-src/` 的默认主题），走 `<img>`
- **Codex** → cloudling 云宝（`.pet-src/cloudling`，作者 stlabslogo），**内联成 `<svg>`**
- **程小帮** → cxb 蓝卫衣短发女孩（`cxb-*.webp`），走 `<img>`
- **Cursor** → cursor 立方体小机器人（`cursor-*.webp`，方块 logo + 指针箭头），走 `<img>`

## 四套的通道与动效

clawd 每张 SVG 自带 `<style>` 与 `@keyframes`，内联到一张卡里会撞名，`<img>` 让每个 SVG
文档独立、CSS 天然隔离。

cloudling 的 27/28 个文件是脚本驱动（`requestAnimationFrame` + `setAttribute`），`<img>` 会禁脚本、
只剩一朵静止的云；而给它一个独立文档（`<object>`）的话，那份文档的画布在 Chromium 里**恒为不透明**
——`background: transparent` 实测无效，暗色卡片上就是一块白方块（clawd-on-desk 自己没这问题，
因为它的 pet 窗口是 `transparent: true` 的独立窗口）。所以云宝内联进宿主 DOM：内联的 SVG 是普通元素，
背景天然透明、跟着主题走。状态映射与实例级 id 改写写在 `src/renderer/src/lib/pet-art.ts`。

cxb 是位图（以程小帮应用图标为参考、用 gpt-image-2.5 生成并用参考图逐档编辑），没有自带动画。
它走 `<img>`，呼吸 / 摇摆 / 敲键盘这类轻动由宿主在 `styles.css` 里按 `.pet.cxb` 补；位图不涉及
CSS 撞名，也不需要云宝那套内联壳。

cursor 是 gpt-image-2.5 以 Cursor 的方块 logo 与指针箭头为参考生成的透明底位图（11 档姿势 +
6 张 mini），没有自带动画。走 `<img>`，宿主只做轻动；生成见 `scripts/build-cursor-pet.py`。

## 许可

clawd / cloudling 两套素材的版权与授权条款原文见 `.pet-src/LICENSE.clawd`。

cxb 是为程小帮生成的原创素材，形象取自已安装的程小帮应用图标（深棕短发、蓝卫衣、`</>` 徽章），
没有引入第三方素材。

cursor 是为 Cursor 生成的原创位图素材，形象取自 Cursor 的方块 logo 与指针箭头，没有引入第三方素材。

## 文件

| 文件 | 用途 |
| --- | --- |
| `clawd-*.svg` | Claude 各档状态的大图（44px 卡片）+ 折叠卡用的小号 mini |
| `clawd-*.still.svg` | 同上，`prefers-reduced-motion` 时换这一份 |
| `cxb-*.webp` | 程小帮 12 档：七档状态 + 打哈欠 / 打盹 / 瘫倒 / 睡着 / 醒来，256×256 |
| `cxb-mini-*.webp` | 折叠卡 24px 用，从各档头部裁的 128×128（6 张） |
| `cursor-*.webp` | Cursor 11 档：七档状态 + 打哈欠 / 打盹 / 瘫倒 / 睡着，256×256 |
| `cursor-mini-*.webp` | 折叠卡 24px 用（6 张，128×128） |
| `README.md` | 本文件 |

云宝不在这里——它只以内联的形态出现，素材落在生成物 `src/renderer/src/lib/pet-cloudling-art.ts`
（17 档：常驻状态 + 静止那串打哈欠 / 打盹 / 瘫倒 / 睡着 + 折叠卡 mini，failed 复用 mini-alert）。

## 重新生成

```bash
node scripts/build-pets.mjs                                    # clawd / cloudling
uv run --with pillow python scripts/build-cxb-pet.py           # 程小帮那套
uv run --with pillow python scripts/build-cursor-pet.py        # Cursor 那套
```

`.pet-src/` 里的原始素材与生成物都在仓库里，clone 下来就能重跑。`build-pets.mjs` 会重设
`viewBox`（原始留白过大，44px 里角色只有十几个像素），clawd 另写一份静态版。

cxb 的源图是 `.pet-src/cxb/*.png`（统一缩到 512 的透明底 PNG），`build-cxb-pet.py` 负责缩到
256、并裁出 mini 的 128。生成这些姿势的原始 1024 图与参考图在需求目录
`agent-live-status/cxb-pet/docs/cxb-pet/refs/`；要换形象时先重新生成姿势图、覆盖
`.pet-src/cxb/`，再跑脚本即可。

## 已知差异（别当 bug）

- **clawd 的 `done` / `failed` 是无限循环**：`clawd-happy.svg` / `clawd-error.svg` 自带
  `infinite` 动画，读了事件之后仍持续动，同屏多只时也各自动各自的。这是素材自带行为，
  用户已确认接受，不改成一次性。
- **两份静态版的停法不一样**：
  - clawd（`<img>`）进不去文档内部，构建期另出 `*.still.svg` 注入 `animation: none`；
    基础 `opacity: 0`、只靠 keyframes 显形的装饰（happy 的星星、thinking 的气泡与圆点、
    notification 的灯泡与光晕、mini-alert 的惊叹号）在生成时按文件置为可见，否则冻结后永久消失。
    error 的烟雾基础位置在头顶之外、硬置可见会悬空，所以取「无烟雾」的那一帧。
  - cxb 没有 still 版：位图本身的姿势就是完整的，宿主动画由
    `@media (prefers-reduced-motion: reduce)` 统一停。
  - 云宝是脚本驱动，`animation: none` 停不了 JS。挂载时给它的 `requestAnimationFrame` 套一道闸：
    放行首帧后不再调度——眼睛与姿态是脚本画的，整段剥掉会剩一朵没有表情的云；首帧里表情与姿态
    已就位，且只画一帧。同一个闸还负责「元素离开文档就不再排下一帧」，否则每换一次状态都会多一条
    空转的 rAF。见 `src/renderer/src/components/Pet.tsx` 的 `inlineShell`。
- **醒来（cxb）是瞬时档**：`cxb-wake.webp` 不挂在 `ThreadState` 上，只在「上一帧还睡着 / 瘫倒、
  这一帧转出静止」时由 `Pet` 先播 1.6s。折叠卡没有小号版，直接切目标姿势。
