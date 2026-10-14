# pet 素材（clawd）

看板卡片上那只 pet 的素材，来自开源桌面应用 **clawd-on-desk**：

- 仓库：https://github.com/rullerzhou-afk/clawd-on-desk
- 取用范围：`assets/svg/` 里的 clawd 默认主题（`themes/clawd/theme.json`）
- 落地方式：`scripts/build-pets.mjs` 从 `.pet-src/` 生成，**只本地自用，不要 push 到远端**

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
| `clawd-*.svg` | 六档状态的大图（44px 卡片）+ 折叠卡用的小号 mini |
| `clawd-*.still.svg` | 同上，但停掉自带动画——`prefers-reduced-motion` 时换这一份 |
| `*.svg` 文件头 | 每份素材的来源与许可说明 |

状态映射（六档 → 文件）写在 `src/renderer/src/lib/pet-art.ts`。

## 重新生成

```bash
node scripts/build-pets.mjs   # 需要 .pet-src/ 里有 clawd 原始素材
```

脚本会重设 `viewBox`（原始 `-15 -25 45 45` 留白过大，44px 里螃蟹只有十几个像素），
并把静态版另外写一份。
