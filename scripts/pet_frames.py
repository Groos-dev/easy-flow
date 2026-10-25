"""
cxb / cursor 位图 pet 的关键帧处理：动作表 → 对齐帧 → 循环 WebP + 静态版。

动作表由 scripts/generate-pet-frames.py 用生图产出，存在 `.pet-src/frames/<theme>/<state>-sheet.webp`：
一张 1536×512 的透明底图，横向三等分，每栏是同一角色的一个姿势。这里只做确定性的活：
按 alpha 切栏、统一缩放与基线、按各档节奏合成动画。

对齐用参考图（`.pet-src/<theme>/<state>.png`）的包围盒定锚：角色高度与落脚线沿用原素材，
换帧时不会忽大忽小、也不会上下跳。alpha 低于阈值的像素当噪声丢掉——生图会在透明区留一点雾。
"""
from __future__ import annotations

from pathlib import Path
from statistics import median

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / '.pet-src'
OUT = ROOT / 'src/renderer/public/pets'

CANVAS = 512
FRAME = 256
STILL_SUFFIX = '-still'

# alpha 低于这个值算透明区的雾，不参与取景
ALPHA_FLOOR = 16
# 单帧最大可视高度 / 宽度：留出边距，缩到 38px 时角色仍有完整轮廓
MAX_SIDE = 480

# 每档的循环：帧序号与停留毫秒。夹一帧回程（0→1→2→1）让首尾接得上。
# 干活 / 完成快，睡着 / 瘫倒慢；眨眼只占一瞬。
STEPS: dict[str, dict[str, list[tuple[int, int]]]] = {
    'cxb': {
        'idle': [(0, 1200), (1, 700), (2, 160), (1, 700)],
        'thinking': [(0, 900), (1, 700), (2, 900), (1, 700)],
        'working': [(0, 150), (1, 120), (2, 150), (1, 120)],
        'sweeping': [(0, 260), (1, 180), (2, 260), (1, 180)],
        'blocked': [(0, 260), (1, 360), (2, 260), (1, 360)],
        'done': [(0, 180), (1, 140), (2, 180), (1, 140)],
        'failed': [(0, 700), (1, 600), (2, 900), (1, 600)],
        'idle-yawn': [(0, 500), (1, 700), (2, 500), (1, 700)],
        'idle-doze': [(0, 1100), (1, 900), (2, 1300), (1, 900)],
        'collapse-sleep': [(0, 1400), (1, 1200), (2, 1600), (1, 1200)],
        'sleeping': [(0, 1500), (1, 1300), (2, 1700), (1, 1300)],
        'wake': [(0, 400), (1, 500), (2, 400), (1, 300)],
    },
    'cursor': {
        'idle': [(0, 1300), (1, 800), (2, 180), (1, 800)],
        'thinking': [(0, 1000), (1, 760), (2, 1000), (1, 760)],
        'working': [(0, 160), (1, 130), (2, 160), (1, 130)],
        'sweeping': [(0, 280), (1, 200), (2, 280), (1, 200)],
        'blocked': [(0, 280), (1, 380), (2, 280), (1, 380)],
        'done': [(0, 190), (1, 150), (2, 190), (1, 150)],
        'failed': [(0, 760), (1, 640), (2, 960), (1, 640)],
        'idle-yawn': [(0, 520), (1, 720), (2, 520), (1, 720)],
        'idle-doze': [(0, 1200), (1, 950), (2, 1400), (1, 950)],
        'collapse-sleep': [(0, 1500), (1, 1300), (2, 1700), (1, 1300)],
        'sleeping': [(0, 1600), (1, 1400), (2, 1800), (1, 1400)],
    },
}


class MissingFrames(RuntimeError):
    pass


def visible_bbox(image: Image.Image) -> tuple[int, int, int, int]:
    """忽略透明区的雾，取真正看得见的内容框。"""
    alpha = image.getchannel('A').point(lambda value: 255 if value > ALPHA_FLOOR else 0)
    bbox = alpha.getbbox()
    if not bbox:
        raise MissingFrames('动作表里这一栏是空的')
    return bbox


def _split_sheet(sheet: Image.Image) -> list[tuple[Image.Image, tuple[int, int, int, int]]]:
    """切成三栏，按可见内容裁紧；连同栏内包围盒一起返回，纵向相对位置还要用。"""
    width, height = sheet.size
    if width % 3:
        raise MissingFrames(f'动作表宽度 {width} 不能三等分')
    panel = width // 3
    frames = []
    for index in range(3):
        cell = sheet.crop((index * panel, 0, (index + 1) * panel, height))
        bbox = visible_bbox(cell)
        frames.append((cell.crop(bbox), bbox))
    return frames


def _compose(panels: list[tuple[Image.Image, tuple[int, int, int, int]]], base: Image.Image) -> list[Image.Image]:
    base_bbox = visible_bbox(base)
    base_center_x = (base_bbox[0] + base_bbox[2]) / 2
    base_bottom = base_bbox[3]
    target_h = min(base_bbox[3] - base_bbox[1], MAX_SIDE)
    widest = max(frame.width for frame, _ in panels)
    tallest = max(frame.height for frame, _ in panels)
    scale = min(target_h / tallest, MAX_SIDE / widest)
    # 横向逐帧居中，消掉生图每栏的左右漂移；纵向用三帧底边的中位数定基线，
    # 保留「跳起来 / 头再低一点」这类真实的相对高低，只消掉整体偏移。
    anchor = median(bbox[3] for _, bbox in panels)

    composed = []
    for frame, (_, _, _, bottom) in panels:
        width = max(1, round(frame.width * scale))
        height = max(1, round(frame.height * scale))
        resized = frame.resize((width, height), Image.LANCZOS)
        canvas = Image.new('RGBA', (CANVAS, CANVAS), (0, 0, 0, 0))
        left = round(base_center_x - width / 2)
        top = round(base_bottom + (bottom - anchor) * scale - height)
        canvas.alpha_composite(resized, (max(0, left), max(0, top)))
        composed.append(canvas)
    return composed


def load_frames(theme: str, state: str) -> list[Image.Image]:
    sheet_path = SRC / 'frames' / theme / f'{state}-sheet.webp'
    base_path = SRC / theme / f'{state}.png'
    if not sheet_path.exists():
        raise MissingFrames(f'缺动作表 {sheet_path.relative_to(ROOT)}，先跑 scripts/generate-pet-frames.py')
    if not base_path.exists():
        raise MissingFrames(f'缺参考图 {base_path.relative_to(ROOT)}')
    with Image.open(sheet_path) as sheet, Image.open(base_path) as base:
        return _compose(_split_sheet(sheet.convert('RGBA')), base.convert('RGBA'))


def steps_for(theme: str, state: str) -> list[tuple[int, int]]:
    return STEPS.get(theme, {}).get(state, [(0, 800), (1, 800), (2, 800), (1, 800)])


def write_state(theme: str, state: str, out: Path = OUT) -> Image.Image:
    """写出 `<theme>-<state>.webp`（循环动画）与 `<theme>-<state>-still.webp`（首帧）。"""
    frames = load_frames(theme, state)
    steps = steps_for(theme, state)
    out.mkdir(parents=True, exist_ok=True)
    sequence = [
        frames[index].resize((FRAME, FRAME), Image.LANCZOS)
        for index, _ in steps
    ]
    sequence[0].save(
        out / f'{theme}-{state}.webp',
        'WEBP',
        save_all=True,
        append_images=sequence[1:],
        duration=[duration for _, duration in steps],
        loop=0,
        quality=85,
        method=6,
    )
    frames[0].resize((FRAME, FRAME), Image.LANCZOS).save(
        out / f'{theme}-{state}{STILL_SUFFIX}.webp',
        'WEBP',
        quality=90,
        method=6,
    )
    return frames[0]
