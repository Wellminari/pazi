"""Gera build/icon.ico a partir de uma PNG (logo do app).

Uso: python build/make-icon.py build/icon.png build/icon.ico
Se já existir um build/icon.ico enviado manualmente, o workflow não roda este script.
"""
import sys
from PIL import Image

src, dst = sys.argv[1], sys.argv[2]
img = Image.open(src).convert("RGBA")
# Deixa quadrada sem distorcer
side = max(img.size)
square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
square.paste(img, ((side - img.width) // 2, (side - img.height) // 2))
square.save(dst, format="ICO", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print(f"Ícone gerado: {dst}")
