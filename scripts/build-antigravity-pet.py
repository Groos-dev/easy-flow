"""Build self-contained animated SVG pets and paused stills from the official mark."""
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / '.pet-src/antigravity/antigravity-pet-assets'
OUT = ROOT / 'src/renderer/public/pets'
STILL = OUT / 'still'
AGENTS = ROOT / 'src/renderer/public/agents'
for directory in (OUT, STILL, AGENTS):
    directory.mkdir(parents=True, exist_ok=True)

official = (SOURCE / 'official/svg/antigravity-icon__full-color.svg').read_text()
art = official.split('>', 1)[1].rsplit('</svg>', 1)[0]
CSS = '''
.body{transform-box:fill-box;transform-origin:50% 80%;animation:agy-float 3.6s ease-in-out infinite}
.eye{transform-box:fill-box;transform-origin:center;animation:agy-blink 5.8s linear infinite}
.pupil{transform:translate(0,0)}.shadow{animation:agy-shadow 3.6s ease-in-out infinite;transform-origin:90px 163px}
.thinking .body{animation:agy-think 2.8s ease-in-out infinite}.thinking .pupil{transform:translate(2px,-2px)}
.dot{animation:agy-dot 1.3s ease-in-out infinite}.dot.two{animation-delay:.18s}.dot.three{animation-delay:.36s}
.working .body,.sweeping .body{animation:agy-work .72s ease-in-out infinite}
.working .eye{animation-duration:4.8s}.hand{animation:agy-tap .36s ease-in-out infinite alternate}.hand.right{animation-delay:-.36s}
.code{animation:agy-code 1.8s ease-in-out infinite;transform-origin:54px 133px}.code.two{animation-delay:-.6s}.code.three{animation-delay:-1.2s}
.sweep{animation:agy-sweep 2.5s linear infinite;transform-origin:136px 105px}
.done .body{animation:agy-celebrate 1.5s ease-out both}.success{animation:agy-badge .6s .25s cubic-bezier(.2,1.6,.5,1) both;transform-box:fill-box;transform-origin:center}
.check{stroke-dasharray:34;stroke-dashoffset:0;animation:agy-check .4s .65s ease-out both}
.confetti{opacity:0;animation:agy-confetti 1.25s .28s ease-out both}
.blocked .body{animation:agy-think 3.6s ease-in-out infinite}.blocked .badge{animation:agy-notice 2s ease-in-out infinite}
.failed .body{animation:agy-shake .65s ease-out both}.failed .pupil{transform:translate(0,2px)}
.yawning .mouth{animation:agy-yawn 3s ease-in-out infinite;transform-box:fill-box;transform-origin:center}
.dozing .eye{animation:none;transform:scaleY(.25)}.dozing .body{animation:agy-float 5s ease-in-out infinite}
.collapsing .body{animation:agy-collapse 5s ease-in-out both}.sleeping .body{transform:translate(4px,26px) scale(1,.8);animation:agy-sleep 5s ease-in-out infinite}
@keyframes agy-float{0%,100%{transform:translateY(1px) rotate(-1.2deg)}50%{transform:translateY(-3px) rotate(1.2deg)}}
@keyframes agy-shadow{0%,100%{opacity:.6;transform:scaleX(1)}50%{opacity:.3;transform:scaleX(.82)}}
@keyframes agy-blink{0%,41%,45%,100%{transform:scaleY(1)}43%{transform:scaleY(.08)}}
@keyframes agy-think{0%,100%{transform:translateY(-1px) rotate(-6deg)}50%{transform:translateY(-4px) rotate(-10deg)}}
@keyframes agy-dot{0%,55%,100%{opacity:.4;transform:translateY(0)}28%{opacity:1;transform:translateY(-3px)}}
@keyframes agy-work{0%,100%{transform:translateY(1px) rotate(-1deg)}50%{transform:translateY(-1px) rotate(1deg)}}
@keyframes agy-tap{from{transform:translateY(-2px)}to{transform:translateY(2px)}}
@keyframes agy-code{0%,100%{opacity:.55;transform:scaleX(.75)}50%{opacity:1;transform:scaleX(1)}}
@keyframes agy-sweep{to{transform:rotate(360deg)}}
@keyframes agy-celebrate{0%{transform:scale(1)}12%{transform:translateY(4px) scale(1.1,.9)}33%{transform:translateY(-23px) rotate(-6deg)}52%{transform:scale(1.08,.92)}70%{transform:translateY(-9px) rotate(3deg)}100%{transform:scale(1)}}
@keyframes agy-badge{from{opacity:0;transform:scale(.25) rotate(-20deg)}to{opacity:1;transform:scale(1)}}
@keyframes agy-check{from{stroke-dashoffset:34}to{stroke-dashoffset:0}}
@keyframes agy-confetti{0%{opacity:0;transform:translate(0,0)}15%,70%{opacity:1}100%{opacity:0;transform:translate(var(--dx),var(--dy)) rotate(var(--turn))}}
@keyframes agy-notice{0%,100%{opacity:.65}50%{opacity:1}}
@keyframes agy-shake{0%,100%{transform:translateX(0)}20%,60%{transform:translateX(-3px)}40%,80%{transform:translateX(3px)}}
@keyframes agy-yawn{0%,25%,100%{transform:scaleY(.5)}50%,75%{transform:scaleY(1.2)}}
@keyframes agy-collapse{to{transform:translate(4px,26px) scale(1,.8)}}
@keyframes agy-sleep{0%,100%{transform:translate(4px,26px) scale(1,.8)}50%{transform:translate(4px,24px) scale(1.02,.82)}}
@media(prefers-reduced-motion:reduce){*{animation:none!important}}
'''


def face(state):
    if state == 'done':
        eyes = '<path d="M72 62q6-9 12 0m12 0q6-9 12 0" fill="none" stroke="#203659" stroke-width="3" stroke-linecap="round"/>'
        mouth = '<path d="M83 76q7 4 14 0q-1 12-7 12t-7-12" fill="#203659"/>'
    elif state in ('sleeping', 'collapsing'):
        eyes = '<path d="M72 63q6 5 12 0m12 0q6 5 12 0" fill="none" stroke="#203659" stroke-width="2.5" stroke-linecap="round"/>'
        mouth = '<ellipse cx="90" cy="80" rx="3" ry="2" fill="#203659"/>'
    else:
        eyes = ''.join(f'<g class="eye"><ellipse cx="{x}" cy="61" rx="6.5" ry="8.5" fill="white"/><g class="pupil"><ellipse cx="{x+.5}" cy="62" rx="3.1" ry="4.4" fill="#203659"/><circle cx="{x+1.4}" cy="60.4" r="1" fill="white"/></g></g>' for x in (78, 102))
        mouth = '<ellipse class="mouth" cx="90" cy="80" rx="5" ry="7" fill="#203659"/>' if state == 'yawning' else '<path d="M84 78q6 6 12 0" fill="none" stroke="#203659" stroke-width="2.3" stroke-linecap="round"/>'
        if state == 'failed':
            mouth = '<path d="M84 82q6-6 12 0" fill="none" stroke="#203659" stroke-width="2.3" stroke-linecap="round"/>'
    brows = '<path d="m72 48 11 3m14 0 11-3" fill="none" stroke="#203659" stroke-width="2" stroke-linecap="round"/>' if state == 'working' else ''
    return eyes + brows + mouth


def props(state, mini):
    if state == 'thinking':
        x, y, scale = (93, 27, .65) if mini else (127, 18, 1)
        return f'<g transform="translate({x} {y}) scale({scale})"><rect x="0" y="0" width="48" height="27" rx="13.5" fill="white" stroke="#dce4f2"/><circle cx="5" cy="32" r="3.7" fill="white" stroke="#dce4f2"/><circle cx="0" cy="39" r="2" fill="white"/>' + ''.join(f'<circle class="dot {name}" cx="{x}" cy="14" r="2.5" fill="{color}"/>' for x, name, color in ((15,'one','#4285f4'),(24,'two','#fbbc04'),(33,'three','#34a853'))) + '</g>'
    if state == 'working':
        transform = 'translate(58 94) scale(.68)' if mini else 'translate(43 112)'
        return f'<g transform="{transform}"><rect width="94" height="47" rx="6" fill="#20395f" stroke="#7496cb"/><circle cx="10" cy="9" r="1.8" fill="#fc7d76"/><circle cx="16" cy="9" r="1.8" fill="#f9d166"/><circle cx="22" cy="9" r="1.8" fill="#75d59a"/><g class="code"><rect x="10" y="20" width="29" height="3" rx="1.5" fill="#8eb5ff"/><rect x="44" y="20" width="15" height="3" rx="1.5" fill="#f8d77a"/></g><g class="code two"><rect x="20" y="29" width="32" height="3" rx="1.5" fill="#82dbc0"/></g><g class="code three"><rect x="10" y="38" width="24" height="3" rx="1.5" fill="#8eb5ff"/><rect x="40" y="38" width="16" height="3" rx="1.5" fill="#d5a7ee"/></g><ellipse class="hand" cx="0" cy="33" rx="5" ry="6" fill="#73a8ff"/><ellipse class="hand right" cx="94" cy="33" rx="5" ry="6" fill="#73a8ff"/></g>'
    if state in ('done', 'blocked', 'failed'):
        x, y, r = (116, 37, 11) if mini else (141, 48, 14)
        color, bg = ('#249956','#eaf8ef') if state == 'done' else ('#bb820e','#fff7de') if state == 'blocked' else ('#d54c4c','#fff0ee')
        mark = '<path class="check" d="m-7 0 5 5 10-11"/>' if state == 'done' else '<path d="M-4-5q0-5 5-4 6 1 2 6l-3 3v3m0 4v1"/>' if state == 'blocked' else '<path d="m-5-5 10 10m0-10L-5 5"/>'
        badge = f'<g transform="translate({x} {y})"><g class="{"success" if state=="done" else "badge"}"><circle r="{r}" fill="{bg}" stroke="{color}" stroke-opacity=".25"/><g fill="none" stroke="{color}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">{mark}</g></g></g>'
        if state == 'done' and not mini:
            import math
            for i in range(10):
                angle = i * math.pi / 5
                badge += f'<rect class="confetti" x="88" y="74" width="4" height="6" rx="1" fill="{("#4285f4","#fbbc04","#34a853","#ea4335")[i%4]}" style="--dx:{math.cos(angle)*65:.1f}px;--dy:{math.sin(angle)*55-10:.1f}px;--turn:{i*47}deg"/>'
        return badge
    if state == 'sweeping':
        return '<g class="sweep" fill="none" stroke="#75b5eb" stroke-width="2" stroke-linecap="round"><path d="M125 105a11 11 0 0 1 20-6m0 12a11 11 0 0 1-20 0m20-17v5h-5m-15 17v-5h5"/></g>'
    return ''


def build(state, mini=False, paused=False):
    viewbox = '48 22 84 104' if mini else '4 0 174 178'
    style = CSS + ('\n*{animation:none!important;transition:none!important}' if paused else '')
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{viewbox}" class="{state}" width="180" height="180"><title>Antigravity {state}</title><style>{style}</style><ellipse class="shadow" cx="90" cy="163" rx="30" ry="3" fill="#426797" opacity=".2"/><g class="body">{art}{face(state)}</g>{props(state, mini)}</svg>\n'


states = {
    'idle': 'idle', 'thinking': 'thinking', 'working': 'working', 'sweeping': 'sweeping',
    'blocked': 'blocked', 'done': 'done', 'failed': 'failed', 'idle-yawn': 'yawning',
    'idle-doze': 'dozing', 'collapse-sleep': 'collapsing', 'sleeping': 'sleeping',
    'mini-idle': 'idle', 'mini-peek': 'thinking', 'mini-typing': 'working',
    'mini-alert': 'blocked', 'mini-happy': 'done', 'mini-sleep': 'sleeping',
}
for name, state in states.items():
    file = f'antigravity-{name}.svg'
    (OUT / file).write_text(build(state, name.startswith('mini-')))
    (STILL / file).write_text(build(state, name.startswith('mini-'), paused=True))
shutil.copyfile(SOURCE / 'official/svg/antigravity-icon__full-color.svg', AGENTS / 'antigravity.svg')
shutil.copyfile(SOURCE / 'static/idle-128.png', AGENTS / 'antigravity.png')
print(f'Built {len(states)} animated SVGs, {len(states)} stills and 2 official agent icons.')
