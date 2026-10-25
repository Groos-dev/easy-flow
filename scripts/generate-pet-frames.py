#!/usr/bin/env python3
"""
用生图给 cxb / cursor 两套位图 pet 补动画关键帧。

每档状态出一张 3 栏动作表：同一角色、同一比例、同一基线，只有姿势在变。
透明底切帧后由 scripts/build-cxb-pet.py / build-cursor-pet.py 合成循环 WebP。
本脚本只负责「调 cxb imagegen、把动作表落到 .pet-src/frames/」，不参与构建。
落盘时缩到 1536×512 的 WebP（单栏 512，正好够合成 256 成品），避免几十 MB 的 PNG 进仓库。

跑法（本机、已登录程小帮）：
  uv run --with pillow python scripts/generate-pet-frames.py                 # 缺什么补什么
  uv run --with pillow python scripts/generate-pet-frames.py --force         # 全部重出
  uv run --with pillow python scripts/generate-pet-frames.py --only cxb:done # 只重出某一档
  uv run --with pillow python scripts/generate-pet-frames.py --jobs 2        # 并发数（默认 2）
"""
from __future__ import annotations

import argparse
import re
import subprocess
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / '.pet-src'
OUT = SRC / 'frames'
MODEL = 'gpt-image-2.5-flare'

CXB = """Use Image 1 as the exact character reference. Draw a 3-frame animation sheet of the same chibi anime girl: dark brown bob hair, big brown eyes, blue hoodie with a white </> badge on the chest, dark jeans, white sneakers. 3-column grid, exactly three evenly spaced panels of equal width, each character centered in its own panel at identical scale and identical foot baseline. Transparent background, no grid lines, no panel borders, no separators, no text, no captions, no shadows. Keep the exact same character design, outfit, colors, face, line weight and proportions in all three panels; only the pose changes. Full body visible in every panel with generous margin; nothing touches the panel edges."""

CURSOR = """Use Image 1 as the exact character reference. Draw a 3-frame animation sheet of the same cute cube-shaped robot mascot: soft white rounded cube body with pale blue shading, thick dark navy outline, big glossy dark eyes, tiny white rounded hands and feet, and a bright blue cursor arrow attached to its right side. 3-column grid, exactly three evenly spaced panels of equal width, each robot centered in its own panel at identical scale and identical foot baseline. Transparent background, no grid lines, no panel borders, no separators, no text, no captions, no shadows. Keep the exact same design, colors, outline weight and proportions in all three panels; only the pose changes. Full body visible in every panel with generous margin; nothing touches the panel edges."""

FRAMES: dict[str, dict[str, list[str]]] = {
    'cxb': {
        'idle': [
            'standing relaxed, both arms hanging at her sides, eyes open, looking straight ahead, calm smile.',
            'identical stance, chest lifted in a deep breath, shoulders raised a little, hair swaying slightly to her left, eyes still open.',
            'identical stance, eyes closed in a calm blink, head tilted very slightly down and to her right.',
        ],
        'thinking': [
            'right index finger on her chin, left arm folded across her waist, eyes looking up-left, one small thought bubble above her right side.',
            'same pose, head tilted further left, eyes looking up, two thought bubbles above her right side.',
            'same pose, head tilted to her right, eyebrows raised, three larger thought bubbles above her right side.',
        ],
        'working': [
            'typing on a silver laptop held in front of her, both hands resting on the keyboard, head level, eyes on the screen.',
            'same pose and laptop, both hands lifted clearly above the keyboard mid-keystroke, shoulders and head raised, eyes on the screen.',
            'same pose and laptop, leaning forward with her head lowered close to the screen, both hands pressed down on the keys, screen glowing brighter.',
        ],
        'sweeping': [
            'holding a straw broom with both hands, broom head on the floor at her left, body leaning left, small dust puff on the left.',
            'holding the same broom upright in front of her, body centered, small dust puff near her feet.',
            'sweeping the broom head to her right, body leaning right, a bigger dust puff on the right.',
        ],
        'blocked': [
            'both fists clenched at her chest, elbows bent, mouth open in a small gasp, one small orange exclamation mark above her right shoulder.',
            'both arms raised higher with fists near her shoulders, body leaning forward, a big orange exclamation mark above her right shoulder.',
            'both arms waving outward, body leaning back slightly, a medium orange exclamation mark above her right shoulder.',
        ],
        'done': [
            'both arms raised high in a cheer, big smile, three yellow sparkles around her head.',
            'arms lowered to shoulder height, body bouncing up, sparkles larger and rotated, big smile.',
            'both arms raised high again, head tilted to one side, sparkles in different positions, joyful face.',
        ],
        'failed': [
            'sad face, shoulders slumped, a blue sweat drop at her temple, arms hanging limp.',
            'shoulders slumped deeper, head lowered, the sweat drop sliding down her cheek, arms hanging limp.',
            'head lowered further, small tear at the corner of her eye, body sagging, arms hanging limp.',
        ],
        'idle-yawn': [
            'right hand covering an open mouth in a small yawn, eyes half closed, other arm at her side.',
            'mouth wide open in a big yawn, hand lowered to her chin, eyes squeezed shut, head tilted back a little.',
            'mouth closing, hand dropping to her side, eyes still closed, head returning upright.',
        ],
        'idle-doze': [
            'standing with droopy half-closed eyes, head slightly down, body relaxed, one small grey Z above her left shoulder.',
            'head nodded further down, body sagging, eyes nearly closed, a bigger grey Z higher above her left shoulder.',
            'head drooped deeply, eyes closed, body sagging more, two grey Zs above her left shoulder.',
        ],
        'collapse-sleep': [
            'sitting cross-legged on the floor, eyes closed, head upright, hands resting on her knees, one grey Z above her right shoulder.',
            'same sitting pose, upper body slumped forward, head tilted down, hands loose on her knees, a bigger grey Z above her right shoulder.',
            'same sitting pose, upper body slumped further with chin near her chest, two grey Zs above her right shoulder.',
        ],
        'sleeping': [
            'curled up asleep on her side, eyes closed, hands tucked under her cheek, one small grey Z above her.',
            'same sleeping pose, chest rising in a slow breath, a bigger grey Z higher above her.',
            'same sleeping pose, body relaxed lower, two grey Zs at different heights above her.',
        ],
        'wake': [
            'standing with both arms stretched upward, eyes still closed, mouth in a small yawn, hair slightly messy.',
            'arms stretched wider, one eye open in a wink, cheerful smile, hair bouncing up.',
            'arms coming down to shoulder height, both eyes open, cheerful smile, one small yellow sparkle beside her head.',
        ],
    },
    'cursor': {
        'idle': [
            'floating upright, both arms hanging at its sides, eyes open, small neutral smile.',
            'same floating pose, body tilted slightly to its left, eyes closed in a blink, feet tucked a little.',
            'same floating pose, body tilted slightly to its right, eyes open wide, arms raised a little.',
        ],
        'thinking': [
            'both hands on its cheeks, eyes looking up-left, one small blue thought bubble above its right side.',
            'head tilted left, eyes looking up, two blue thought bubbles above its right side.',
            'head tilted right, eyes squinting thoughtfully, three larger blue thought bubbles above its right side.',
        ],
        'working': [
            'typing on a tiny silver laptop held in front of it, both hands resting on the keyboard, eyes on the screen.',
            'same pose and laptop, both hands lifted clearly above the keyboard mid-keystroke, body bobbing up, eyes on the screen.',
            'same pose and laptop, leaning toward the screen, both hands pressed down on the keys, screen glowing brighter.',
        ],
        'sweeping': [
            'holding a small straw broom with both hands, broom head on the floor at its left, body leaning left, small dust puff on the left.',
            'holding the broom upright in front of it, body centered, small dust puff near its feet.',
            'sweeping the broom head to its right, body leaning right, a bigger dust puff on the right.',
        ],
        'blocked': [
            'arms at its sides, mouth open, one small yellow exclamation bubble above its right side.',
            'both arms raised high, body leaning forward, a big yellow exclamation bubble above its right side.',
            'arms waving outward, body leaning back, a medium yellow exclamation bubble above its right side.',
        ],
        'done': [
            'eyes closed in a happy smile, both arms raised high, three yellow sparkles around its head.',
            'arms lowered to shoulder height, body bouncing up, sparkles rotated, happy face.',
            'both arms raised high again, head tilted to one side, sparkles in different positions, joyful face.',
        ],
        'failed': [
            'X-shaped eyes, frowning mouth, body sagging, small grey smoke puffs above its head.',
            'X-shaped eyes, body sagging lower, bigger grey smoke puffs above its head.',
            'X-shaped eyes, body tilted to one side, smoke drifting higher and sideways.',
        ],
        'idle-yawn': [
            'mouth small open in a yawn, eyes half closed, one hand near its mouth.',
            'mouth wide open in a big yawn, eyes squeezed shut, body tilted back a little.',
            'mouth closing, eyes still closed, hand dropping back to its side.',
        ],
        'idle-doze': [
            'half-lidded sleepy eyes, body tilted slightly, one small blue Z above its right side.',
            'eyes nearly closed, body slumped, a bigger blue Z higher above its right side.',
            'eyes closed, body slumped more, two blue Zs above its right side.',
        ],
        'collapse-sleep': [
            'lying tilted on its side, eyes closed, hands resting on the floor, one small blue Z above it.',
            'same lying pose, body squashed slightly in a breath, a bigger blue Z higher above it.',
            'same lying pose, body completely relaxed, two blue Zs at different heights above it.',
        ],
        'sleeping': [
            'curled up asleep on its side, eyes closed, hands tucked under its body, one small blue Z above it.',
            'same sleeping pose, body rising slightly in a slow breath, a bigger blue Z higher above it.',
            'same sleeping pose, body settled lower, two blue Zs at different heights above it.',
        ],
    },
}


def prompt_for(theme: str, state: str) -> str:
    common = CXB if theme == 'cxb' else CURSOR
    frames = FRAMES[theme][state]
    lines = [common, '']
    for i, frame in enumerate(frames, start=1):
        lines.append(f'Frame {i}: {frame}')
    return '\n'.join(lines)


def generate(theme: str, state: str, force: bool) -> tuple[str, str]:
    dest = OUT / theme / f'{state}-sheet.webp'
    raw = OUT / theme / f'{state}-sheet.png'
    if dest.exists() and not force:
        return f'{theme}:{state}', f'skip {dest.relative_to(ROOT)}'
    ref = SRC / theme / f'{state}.png'
    if not ref.exists():
        return f'{theme}:{state}', f'missing reference {ref.relative_to(ROOT)}'
    prompt = prompt_for(theme, state)
    with tempfile.NamedTemporaryFile('w', suffix='.txt', delete=False, encoding='utf-8') as fh:
        fh.write(prompt)
        prompt_path = Path(fh.name)
    try:
        proc = None
        for attempt in range(5):
            proc = subprocess.run(
                [
                    'cxb', 'image', 'generate',
                    '--model', MODEL,
                    '--prompt-file', str(prompt_path),
                    '--ref-image', str(ref),
                    '--param', 'size=3072x1024',
                    '--param', 'background=transparent',
                    '--param', 'output_format=png',
                    '--intermediate',
                ],
                cwd=ROOT,
                capture_output=True,
                text=True,
                timeout=300,
            )
            if proc.returncode == 0 or '429' not in (proc.stdout + proc.stderr):
                break
            wait = 20 * (attempt + 1)
            print(f'[{theme}:{state}] 429，{wait}s 后重试（{attempt + 1}/5）', flush=True)
            time.sleep(wait)
    finally:
        prompt_path.unlink(missing_ok=True)
    if proc is None or proc.returncode != 0:
        return f'{theme}:{state}', f'FAILED ({proc.returncode})\n{proc.stdout}\n{proc.stderr}'
    match = re.search(r'^FINAL (.+)$', proc.stdout, re.M)
    if not match:
        return f'{theme}:{state}', f'no FINAL in output\n{proc.stdout}\n{proc.stderr}'
    dest.parent.mkdir(parents=True, exist_ok=True)
    Path(match.group(1)).replace(raw)
    with Image.open(raw) as image:
        image.convert('RGBA').resize((1536, 512), Image.LANCZOS).save(
            dest, 'WEBP', quality=90, method=6
        )
    raw.unlink()
    return f'{theme}:{state}', f'wrote {dest.relative_to(ROOT)}'


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--force', action='store_true', help='重出已有动作表')
    parser.add_argument('--only', default='', help='只跑 theme:state，例如 cxb:done')
    parser.add_argument('--jobs', type=int, default=2, help='并发数（默认 2，网关限流时用 1）')
    parser.add_argument('--delay', type=float, default=0, help='每次提交前的等待秒数')
    args = parser.parse_args()

    tasks = []
    for theme, states in FRAMES.items():
        for state in states:
            key = f'{theme}:{state}'
            if args.only and args.only != key:
                continue
            tasks.append((theme, state))
    if not tasks:
        raise SystemExit(f'没有匹配的任务：{args.only or "全部"}')

    failures = 0
    with ThreadPoolExecutor(max_workers=max(1, args.jobs)) as pool:
        futures = []
        for theme, state in tasks:
            futures.append(pool.submit(generate, theme, state, args.force))
            if args.delay:
                time.sleep(args.delay)
        for future in as_completed(futures):
            key, message = future.result()
            print(f'[{key}] {message}', flush=True)
            if message.startswith(('FAILED', 'no FINAL', 'missing')):
                failures += 1
    if failures:
        raise SystemExit(f'{failures} 档失败，修好后再跑一次（已成功的会跳过）')


if __name__ == '__main__':
    main()
