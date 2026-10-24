#!/usr/bin/env python3
"""
Cursor 专属 pet：`.pet-src/cursor/*.png` → `src/renderer/public/pets/cursor-*.webp`。

形象是用 gpt-image-2.5 以 Cursor 的方块 logo + 指针箭头为参考生成的透明底位图，
再用同一角色做参考逐档编辑。源图 1024，生成物 256；折叠卡从头部裁 128。

跑法：
  uv run --with pillow python scripts/build-cursor-pet.py
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / '.pet-src/cursor'
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
]

MINIS = {
    'mini-idle': 'idle',
    'mini-peek': 'thinking',
    'mini-typing': 'working',
    'mini-alert': 'blocked',
    'mini-happy': 'done',
    'mini-sleep': 'sleeping',
}

# 头部裁切：取角色 alpha 包围盒里的前脸，横向偏左、纵向偏上；正方形裁切保证 mini 不变形
HEAD_LEFT = 0.15
HEAD_TOP = 0.25
HEAD_SIDE = 0.52


def load(name: str) -> Image.Image:
    path = SRC / f'{name}.png'
    if not path.exists():
        raise SystemExit(f'缺源图：{path}')
    return Image.open(path).convert('RGBA')


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for state in STATES:
        image = load(state)
        image.resize((256, 256), Image.LANCZOS).save(
            OUT / f'cursor-{state}.webp', 'WEBP', quality=92, method=6
        )
        print('wrote', f'cursor-{state}.webp')

    for mini, state in MINIS.items():
        image = load(state)
        bbox = image.getbbox()
        if not bbox:
            raise SystemExit(f'{state}.png 没有可见内容')
        x0, y0, x1, y1 = bbox
        w, h = x1 - x0, y1 - y0
        side = max(1, int(min(w, h) * HEAD_SIDE))
        left = max(0, min(image.width - side, x0 + int(w * HEAD_LEFT)))
        top = max(0, min(image.height - side, y0 + int(h * HEAD_TOP)))
        crop = image.crop((left, top, left + side, top + side))
        crop.resize((128, 128), Image.LANCZOS).save(
            OUT / f'cursor-{mini}.webp', 'WEBP', quality=92, method=6
        )
        print('wrote', f'cursor-{mini}.webp')


if __name__ == '__main__':
    main()
