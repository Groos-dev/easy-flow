from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import base64
import json

root = Path(__file__).resolve().parents[1]
pack = root / 'antigravity-pet-animations'
html = (pack / 'index.html').read_text()
for name in ('pet.css', 'preview.css'):
    html = html.replace(f'<link rel="stylesheet" href="{name}">', '<style>\n' + (pack / name).read_text() + '\n</style>')
for name in ('pet.js', 'preview.js'):
    html = html.replace(f'<script src="{name}"></script>', '<script>\n' + (pack / name).read_text() + '\n</script>')
logo = 'data:image/svg+xml;base64,' + base64.b64encode((pack / 'assets/antigravity.svg').read_bytes()).decode()
html = html.replace('src="assets/antigravity.svg"', f'src="{logo}"')
(root / 'antigravity-pet-animations.html').write_text(html)
manifest = {
    'id': 'antigravity-pet-motion',
    'version': 1,
    'type': 'html-css-js-animation',
    'source_artwork': 'https://antigravity.google/press',
    'official_artwork_file': 'assets/antigravity.svg',
    'custom_additions': ['face expressions', 'animation', 'thought bubble', 'terminal prop', 'success check', 'confetti'],
    'states': {
        'idle': {'behavior': 'float, breathe, blink', 'loop': True},
        'thinking': {'behavior': 'head tilt, upward glance, bouncing thought dots', 'loop': True},
        'working': {'behavior': 'focused eyes, typing hands, animated terminal lines', 'loop': True},
        'complete': {'behavior': 'two jumps, smiling eyes, check mark, one-shot confetti; then gentle float', 'intro_ms': 1500, 'loop_after_intro': True}
    },
    'entry_html': 'index.html',
    'component_files': ['pet.css', 'pet.js', 'assets/antigravity.svg'],
    'public_api': ['new AntigravityPet(element, options)', 'setState(state, {restart})', 'setPaused(boolean)', 'setSpeed(0.25..3)', 'setSize(32..1024)', 'setFace(boolean)', 'restart()', 'destroy()'],
    'notes': ['Custom pet animation based on official logo; not an official Google pet.', 'Original logo SVG is unchanged.', 'Preview uses local simulated states and is not connected to an Antigravity agent.', 'No external runtime, font, or network request required for the portable HTML.']
}
(pack / 'animation-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
(pack / 'USAGE.txt').write_text('''Antigravity Pet 四状态动画\n\n预览：打开 index.html。便携单文件版本位于资源目录外的 antigravity-pet-animations.html。\n\n组件接入：加载 pet.css 与 pet.js，并传入容器和官方 SVG 路径。\n\nconst pet = new AntigravityPet(document.querySelector('#pet'), {\n  imageSrc: './assets/antigravity.svg', size: 240, state: 'idle'\n});\npet.setState('thinking');\npet.setState('working');\npet.setState('complete', {restart: true});\npet.setState('idle');\npet.setPaused(true);\npet.setSpeed(1);\npet.setFace(false);\n\nLogo 来源：https://antigravity.google/press\nSVG 原图未修改；表情、道具、动效为自定义衍生。\n本 HTML 演示状态切换，尚未连接实际 Antigravity 运行事件。\n完成的跳跃和彩屑只在进入或重播状态时播放，随后保持完成表情并轻浮。\n支持系统“减少动态效果”设置；后台标签页会暂停动画与流程。\n''')
with ZipFile(root / 'antigravity-pet-animations.zip', 'w', ZIP_DEFLATED) as archive:
    for path in sorted(pack.rglob('*')):
        if path.is_file():
            archive.write(path, path.relative_to(root))
    archive.write(root / 'antigravity-pet-animations.html', 'antigravity-pet-animations.html')
print('Created portable HTML and reusable four-state animation package.')
