#!/usr/bin/env python3
"""
程小帮专属 pet 素材：`.pet-src/cxb/*.png` + `.pet-src/frames/cxb/*.webp` → `src/renderer/public/pets/cxb-*.webp`。

形象是用 gpt-image-2.5 以程小帮应用图标为参考生成的（深棕短发、蓝卫衣、`</>` 徽章），
再用同一个角色做参考逐档编辑出姿势。原始 1024 图在需求目录
`agent-live-status/cxb-pet/docs/cxb-pet/refs/`，这里保存的是统一缩到 512 的源图；
`frames/cxb/` 里是每档三帧的动作表（scripts/generate-pet-frames.py 生图）。

生成物：
- `cxb-<档>.webp`：256×256 循环动画，卡片上的 44px 与详情页共用
- `cxb-mini-<档>.webp`：128×128，每帧同一处头部裁切的循环动画，折叠卡的 24px 用

跑法（只在本机做素材时需要）：
  uv run --with pillow python scripts/build-cxb-pet.py
"""
from pathlib import Path

from PIL import Image

from pet_frames import save_animation, steps_for, write_state

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'src/renderer/public/pets'

STATES = [
    'idle',
    'thinking',
    'working',
    'sweeping',
    'blocked',
    'done',
    'failed',
    'idle-yawn',
    'idle-doze',
    'collapse-sleep',
    'sleeping',
    'wake',
]

# 折叠卡只认这六张：静止 / 探出 / 敲键盘 / 提醒 / 开心 / 睡觉
MINIS = {
    'mini-idle': 'idle',
    'mini-peek': 'thinking',
    'mini-typing': 'working',
    'mini-alert': 'blocked',
    'mini-happy': 'done',
    'mini-sleep': 'sleeping',
}

# 头部裁切：对齐后的 512 帧里头部大致在 x 82–430、y 5–353；正方形裁切保证 mini 不变形
HEAD_BOX = (0.16, 0.01, 0.84, 0.69)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    frames: dict[str, list[Image.Image]] = {}
    for state in STATES:
        frames[state] = write_state('cxb', state, OUT)
        print('wrote', f'cxb-{state}.webp')

    for mini, state in MINIS.items():
        sheet = frames[state]
        w, h = sheet[0].size
        box = (
            int(w * HEAD_BOX[0]),
            int(h * HEAD_BOX[1]),
            int(w * HEAD_BOX[2]),
            int(h * HEAD_BOX[3]),
        )
        side = min(box[2] - box[0], box[3] - box[1])
        # 每帧用同一个裁切框，头不会跟着逐帧漂移
        head = (box[0], box[1], box[0] + side, box[1] + side)
        save_animation(
            [frame.crop(head) for frame in sheet],
            steps_for('cxb', state),
            OUT / f'cxb-{mini}.webp',
            128,
            92,
        )
        print('wrote', f'cxb-{mini}.webp')


if __name__ == '__main__':
    main()
