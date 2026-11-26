from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import base64
import json

ROOT = Path(__file__).resolve().parents[1]
PACK = ROOT / 'antigravity-pet-assets'
manifest = json.loads((PACK / 'asset-manifest.json').read_text())

template = r'''<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>Antigravity · 静态素材预览</title>
<style>
:root{font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;color:#202124;background:#f7f8fa;font-synthesis:none}
*{box-sizing:border-box}body{margin:0}button,input,select{font:inherit}button,select{cursor:pointer}button:focus-visible,input:focus-visible,select:focus-visible,a:focus-visible{outline:3px solid #4285f4;outline-offset:4px}button{color:inherit}a{color:#2468d5;text-underline-offset:3px}.shell{max-width:1200px;padding:32px 40px 60px;margin:auto}
header{display:flex;align-items:center;justify-content:space-between;gap:20px;border-bottom:1px solid #e3e6ec;padding-bottom:22px}.brand{display:flex;gap:10px;align-items:center;font-size:17px;font-weight:600;letter-spacing:-.3px}.brand img{width:34px;height:34px}.tag{font-size:13px;color:#647086;letter-spacing:.06em}.intro{display:flex;justify-content:space-between;align-items:end;gap:24px;margin:34px 0 22px}h1{font-size:32px;font-weight:600;letter-spacing:-1px;margin:0 0 9px}.intro p{margin:0;color:#6c7380;font-size:15px;line-height:1.8}.check-status{padding:9px 13px;background:#e8f3ed;color:#277349;font-size:14px;border-radius:9px;white-space:nowrap}.check-status.failed{background:#fce9e8;color:#ba3434}.workspace{display:grid;grid-template-columns:minmax(0,1fr) 292px;gap:22px}.stage-wrap{min-width:0}.stage{position:relative;height:424px;border:1px solid #e1e4e9;border-radius:18px;overflow:hidden;transition:background-color .2s;touch-action:pan-y;background:#f0f2f6}.stage[data-bg="light"]{background:#f0f2f6}.stage[data-bg="dark"]{background:#181c26;border-color:#252c3c}.stage[data-bg="checker"]{background-color:#fff;background-image:conic-gradient(#e9ebef 25%,transparent 0 50%,#e9ebef 0 75%,transparent 0);background-size:24px 24px}.stage-note{position:absolute;top:22px;left:24px;font-size:12px;font-weight:600;letter-spacing:.1em;color:#929bac}.stage[data-bg="dark"] .stage-note{color:#778399}.orbit{width:250px;height:250px;position:absolute;border:1px dashed #d2d9e6;border-radius:50%;left:50%;top:50%;transform:translate(-50%,-50%);pointer-events:none}.stage[data-bg="dark"] .orbit{border-color:#303a50}.guide{position:absolute;left:24px;right:24px;bottom:22px;display:flex;justify-content:space-between;gap:12px;color:#8d96a7;font-size:13px}.stage[data-bg="dark"] .guide{color:#7b89a1}.pet{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);padding:0;border:0;background:transparent;cursor:grab;touch-action:none;line-height:0;user-select:none}.pet:active{cursor:grabbing}.pet img{display:block;width:160px;height:160px;object-fit:contain;pointer-events:none;user-select:none;animation:float 3.4s ease-in-out infinite}.pet[data-floating="false"] img,.pet.dragging img{animation:none}.caption{font-size:13px;line-height:1.8;color:#7c8493;margin:11px 2px 0}.panel{background:#fff;border:1px solid #e3e6ec;border-radius:18px;padding:23px}.panel h2{font-size:16px;margin:0 0 24px;font-weight:600}.field{margin-bottom:21px}.label{font-size:14px;font-weight:500;display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}.value{color:#6b7484;font-weight:400;font-variant-numeric:tabular-nums}.segmented{display:flex;gap:5px;background:#f4f5f7;border-radius:9px;padding:4px}.segmented button{flex:1;border:0;background:transparent;border-radius:6px;font-size:14px;padding:8px 0;color:#747d8c}.segmented button[aria-pressed="true"]{background:#fff;box-shadow:0 1px 4px #20212414;color:#2468d5;font-weight:500}select{width:100%;border:1px solid #dfe3e9;background:#fff;border-radius:8px;padding:9px 30px 9px 11px;font-size:14px;color:#374151;appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16'%3E%3Cpath d='m4 6 4 4 4-4' fill='none' stroke='%236b7280' stroke-width='1.5'/%3E%3C/svg%3E");background-position:right 10px center;background-repeat:no-repeat}input[type="range"]{width:100%;accent-color:#4285f4;margin:6px 0}.toggle-row{display:flex;align-items:center;gap:8px;font-size:14px}.toggle-row input{accent-color:#4285f4;width:17px;height:17px}.reset{width:100%;padding:10px;background:#f8f9fb;border:1px solid #e0e4eb;border-radius:8px;font-size:14px}.decode{font-size:12px;color:#7b8494;line-height:1.7;margin:16px 0 0;overflow-wrap:anywhere}.decode.error{color:#ba3434}.library-head{display:flex;align-items:center;justify-content:space-between;gap:20px;margin:34px 0 16px}.library-head h2{font-size:19px;font-weight:600;margin:0}.library-head p{font-size:13px;color:#7b8494;margin:6px 0 0}.library{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px}.asset-card{border:1px solid #e3e6ec;border-radius:12px;background:#fff;overflow:hidden;min-width:0}.asset-preview{display:flex;align-items:center;justify-content:center;height:112px;padding:18px;background-color:#f4f5f7}.asset-preview.dark{background:#20242e}.asset-preview img{display:block;max-width:100%;max-height:100%;object-fit:contain}.asset-text{padding:10px 11px 12px}.asset-text strong{display:block;font-size:13px;font-weight:500;color:#414b5b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.asset-text span{display:block;font-size:12px;margin-top:5px;color:#7b8494}.asset-text span[data-result="ok"]{color:#277349}.asset-text span[data-result="error"]{color:#ba3434}footer{display:flex;gap:16px;justify-content:space-between;margin-top:30px;color:#8991a0;font-size:12px;line-height:1.8}footer a{color:#7c8493}noscript{display:block;padding:14px;background:#fff1de;color:#8b531a}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}
@keyframes float{0%,100%{transform:translateY(7px)}50%{transform:translateY(-7px)}}
@media(prefers-reduced-motion:reduce){.pet img{animation:none}.stage{transition:none}}
@media(max-width:920px){.library{grid-template-columns:repeat(3,minmax(0,1fr))}.shell{padding:24px}.workspace{grid-template-columns:minmax(0,1fr) 265px}}
@media(max-width:640px){.shell{padding:20px 16px 36px}header{padding-bottom:17px}.tag{display:none}.intro{margin-top:26px;align-items:start;flex-direction:column;gap:14px}h1{font-size:26px}.workspace{grid-template-columns:1fr}.stage{height:340px}.panel{padding:20px}.panel h2{margin-bottom:20px}.library{grid-template-columns:repeat(2,minmax(0,1fr))}.library-head{align-items:start;flex-direction:column;gap:8px}footer{flex-direction:column;gap:5px}.guide{font-size:12px}.check-status{font-size:13px}}
</style>
</head>
<body>
<main class="shell">
<header><div class="brand"><img src="static/idle.svg" alt=""><span>Google Antigravity</span></div><span class="tag">STATIC ASSET PREVIEW</span></header>
<section class="intro"><div><h1>先看看，它在屏幕上的样子。</h1><p>复用官方标识，检查透明背景、显示尺寸与桌面悬浮效果。</p></div><output class="check-status" id="check-status" aria-live="polite">正在检查素材…</output></section>
<noscript>请启用 JavaScript 使用预览控件。下方图片仍可直接查看。</noscript>
<section class="workspace" aria-label="静态资源交互预览">
 <div class="stage-wrap"><div class="stage" id="stage" data-bg="light"><div class="stage-note">DESKTOP CANVAS</div><div class="orbit" aria-hidden="true"></div><button class="pet" id="pet" data-floating="true" aria-label="宠物预览，可拖拽或使用方向键移动"><img id="pet-image" src="static/idle-256.png" alt="Antigravity 彩色拱形标识" draggable="false"></button><div class="guide"><span>拖拽调整位置</span><span>PNG · SVG · ALPHA</span></div></div><p class="caption">悬浮来自 CSS 位移动效；当前图片是单帧静态素材。</p></div>
 <aside class="panel" aria-label="预览设置"><h2>预览设置</h2>
  <div class="field"><span class="label" id="background-label">背景</span><div class="segmented" role="group" aria-labelledby="background-label"><button type="button" data-background="light" aria-pressed="true">浅色</button><button type="button" data-background="dark" aria-pressed="false">深色</button><button type="button" data-background="checker" aria-pressed="false">透明格</button></div></div>
  <div class="field"><label class="label" for="format">素材格式</label><select id="format"><option value="static/idle-256.png">PNG · 256 × 256</option><option value="static/idle.svg">SVG · 矢量</option><option value="static/idle-64.png">PNG · 64 × 64</option><option value="static/idle-128.png">PNG · 128 × 128</option><option value="static/idle-512.png">PNG · 512 × 512</option><option value="static/idle.png">PNG · 原图 540 × 540</option></select></div>
  <div class="field"><label class="label" for="size">显示尺寸 <output class="value" id="size-value" for="size">160 px</output></label><input id="size" type="range" min="32" max="256" step="8" value="160" aria-label="显示尺寸"></div>
  <div class="field"><label class="toggle-row"><input type="checkbox" id="float" checked>启用悬浮动效</label></div>
  <button class="reset" id="reset" type="button">重置位置与尺寸</button><p class="decode" id="decode" aria-live="polite">正在解码预览图片…</p>
 </aside>
</section>
<section aria-labelledby="library-title"><div class="library-head"><div><h2 id="library-title">素材检查</h2><p>逐一加载原始 PNG / SVG 与各尺寸静态资源。</p></div><a href="https://antigravity.google/press" target="_blank" rel="noopener noreferrer">官方素材来源</a></div><div class="library" id="library"></div></section>
<footer><span>当前静态形象：Google Antigravity 官方 Logo。</span><span>本地 HTML 预览 · 无需安装依赖</span></footer>
</main>
<script>
const assetEntries = __ASSET_ENTRIES__;
const inlineAssets = __INLINE_ASSETS__;
const sourceFor = path => inlineAssets[path] || path;
const stage = document.getElementById('stage');
const pet = document.getElementById('pet');
const petImage = document.getElementById('pet-image');
const sizeInput = document.getElementById('size');
const formatInput = document.getElementById('format');
const floatInput = document.getElementById('float');
const sizeValue = document.getElementById('size-value');
const decode = document.getElementById('decode');
const status = document.getElementById('check-status');
const library = document.getElementById('library');
let position = {x:.5,y:.5};
let drag = null;
function place(x,y){
 const box=stage.getBoundingClientRect(), half=Number(sizeInput.value)/2+10;
 const nx=Math.max(half,Math.min(box.width-half,x));
 const ny=Math.max(half,Math.min(box.height-half,y));
 position={x:nx/box.width,y:ny/box.height};
 pet.style.left=`${position.x*100}%`;pet.style.top=`${position.y*100}%`;
}
function renderSize(){
 const n=Number(sizeInput.value);petImage.style.width=`${n}px`;petImage.style.height=`${n}px`;sizeValue.textContent=`${n} px`;
 const b=stage.getBoundingClientRect();place(position.x*b.width,position.y*b.height);
}
function updateDecode(){
 decode.classList.remove('error');
 decode.textContent=`图片已加载 · ${petImage.naturalWidth} × ${petImage.naturalHeight} · ${formatInput.selectedOptions[0].textContent.split(' · ')[0]}`;
 decode.dataset.result='ok';
}
petImage.addEventListener('load',updateDecode);
petImage.addEventListener('error',()=>{decode.textContent='图片加载失败，请检查资源路径。';decode.classList.add('error');decode.dataset.result='error';});
if(Object.keys(inlineAssets).length) petImage.src=sourceFor(formatInput.value);
if(petImage.complete && petImage.naturalWidth) updateDecode();
document.querySelectorAll('[data-background]').forEach(button=>button.addEventListener('click',()=>{
 stage.dataset.bg=button.dataset.background;
 document.querySelectorAll('[data-background]').forEach(item=>item.setAttribute('aria-pressed',String(item===button)));
}));
sizeInput.addEventListener('input',renderSize);
formatInput.addEventListener('change',()=>{decode.textContent='正在解码预览图片…';decode.dataset.result='pending';petImage.src=sourceFor(formatInput.value);});
floatInput.addEventListener('change',()=>{pet.dataset.floating=String(floatInput.checked);});
if(matchMedia('(prefers-reduced-motion: reduce)').matches){floatInput.checked=false;pet.dataset.floating='false';}
document.getElementById('reset').addEventListener('click',()=>{sizeInput.value='160';position={x:.5,y:.5};renderSize();});
pet.addEventListener('pointerdown',event=>{
 if(event.button!==0 || !event.isPrimary) return;
 const b=stage.getBoundingClientRect();drag={id:event.pointerId,dx:event.clientX-b.left-position.x*b.width,dy:event.clientY-b.top-position.y*b.height};
 pet.setPointerCapture(event.pointerId);pet.classList.add('dragging');
});
pet.addEventListener('pointermove',event=>{if(!drag||event.pointerId!==drag.id)return;const b=stage.getBoundingClientRect();place(event.clientX-b.left-drag.dx,event.clientY-b.top-drag.dy);});
const endDrag=()=>{drag=null;pet.classList.remove('dragging');};
pet.addEventListener('pointerup',endDrag);pet.addEventListener('pointercancel',endDrag);pet.addEventListener('lostpointercapture',endDrag);
pet.addEventListener('keydown',event=>{const delta={ArrowLeft:[-10,0],ArrowRight:[10,0],ArrowUp:[0,-10],ArrowDown:[0,10]}[event.key];if(!delta)return;event.preventDefault();const b=stage.getBoundingClientRect();place(position.x*b.width+delta[0],position.y*b.height+delta[1]);});
new ResizeObserver(renderSize).observe(stage);
const displayName=path=>{
 const name=path.split('/').pop(),ext=name.split('.').pop().toUpperCase();
 if(path.startsWith('static/')) return name==='idle.svg'?'SVG · 矢量':name==='idle.png'?'PNG · 官方原图':`PNG · ${name.match(/\d+/)[0]} px`;
 if(name.includes('one-color'))return `${ext} · 单色图标`;
 if(name.includes('__white'))return `${ext} · 白色图标`;
 if(name.includes('icon__'))return `${ext} · 彩色图标`;
 if(name.includes('wordmark'))return `${ext} · 白色文字`;
 if(name.includes('reverse'))return `${ext} · 反白组合`;
 return `${ext} · 品牌组合`;
};
let passed=0,failed=0;
function report(){
 const done=passed+failed;
 status.textContent=failed?`${passed}/${assetEntries.length} 正常 · ${failed} 项失败`:done===assetEntries.length?`${passed}/${assetEntries.length} 素材加载正常`:`正在检查 ${done}/${assetEntries.length}`;
 status.classList.toggle('failed',failed>0);status.dataset.passed=String(passed);status.dataset.failed=String(failed);status.dataset.total=String(assetEntries.length);status.dataset.complete=String(done===assetEntries.length);
}
assetEntries.forEach(({file})=>{
 const card=document.createElement('article');card.className='asset-card';card.dataset.file=file;
 const preview=document.createElement('div');preview.className='asset-preview'+(/white|reverse/.test(file)?' dark':'');
 const img=new Image();img.alt=displayName(file);img.decoding='async';
 const text=document.createElement('div');text.className='asset-text';
 const name=document.createElement('strong');name.textContent=displayName(file);name.title=file;
 const result=document.createElement('span');result.textContent='正在加载…';
 img.onload=()=>{passed++;result.textContent=`正常 · ${img.naturalWidth} × ${img.naturalHeight}`;result.dataset.result='ok';report();};
 img.onerror=()=>{failed++;result.textContent='加载失败';result.dataset.result='error';report();};
 preview.append(img);text.append(name,result);card.append(preview,text);library.append(card);img.src=sourceFor(file);
});
renderSize();report();
</script>
</body>
</html>
'''

entries = manifest['assets']
html = template.replace('__ASSET_ENTRIES__', json.dumps(entries, ensure_ascii=False)).replace('__INLINE_ASSETS__', '{}')
(PACK / 'preview.html').write_text(html)

inline_assets = {}
for asset in entries:
    path = asset['file']
    mime = 'image/svg+xml' if path.endswith('.svg') else 'image/png'
    inline_assets[path] = 'data:' + mime + ';base64,' + base64.b64encode((PACK / path).read_bytes()).decode()
portable = template.replace('__ASSET_ENTRIES__', json.dumps(entries, ensure_ascii=False)).replace('__INLINE_ASSETS__', json.dumps(inline_assets))
# Inline the two images present before the script, for a portable single-file preview.
for path in ('static/idle.svg', 'static/idle-256.png'):
    portable = portable.replace('src="' + path + '"', 'src="' + inline_assets[path] + '"')
(ROOT / 'antigravity-preview.html').write_text(portable)

with ZipFile(ROOT / 'antigravity-pet-assets.zip', 'w', ZIP_DEFLATED) as archive:
    for path in sorted(PACK.rglob('*')):
        if path.is_file():
            archive.write(path, path.relative_to(ROOT))
print('Created relative-path preview and portable single-file HTML; included 18 image assets.')
