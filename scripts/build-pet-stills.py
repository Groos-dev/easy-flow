from pathlib import Path
import re
from PIL import Image

root = Path(__file__).resolve().parent.parent
source = (root / 'src/renderer/src/lib/pet-art.ts').read_text()
pets = root / 'src/renderer/public/pets'
out = pets / 'still'
out.mkdir(exist_ok=True)
for name in sorted(set(re.findall(r"['\"]((?:clawd|cxb|cursor)-[\w-]+\.(?:svg|webp))['\"]", source))):
    path = pets / name
    if path.suffix == '.webp':
        with Image.open(path) as image:
            image.seek(0)
            image.convert('RGBA').resize((76, 76), Image.Resampling.LANCZOS).save(out / f'{path.stem}.png')
    else:
        text = re.sub(r'(<svg\b[^>]*>)', r'\1<style>*{animation:none!important;transition:none!important}</style>', path.read_text(), count=1)
        (out / name).write_text('\n'.join(line.rstrip() for line in text.splitlines()) + '\n')
