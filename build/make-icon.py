"""Gera um .ico do Windows a partir de uma PNG, com os cantos arredondados e transparentes.

Uso: python build/make-icon.py ORIGEM.png DESTINO.ico [raio]
  raio = proporção do canto arredondado em relação ao lado (padrão 0.22, igual aos ícones de app)
         use 0 para não arredondar.
"""
import sys
from PIL import Image, ImageDraw

src, dst = sys.argv[1], sys.argv[2]
radius_ratio = float(sys.argv[3]) if len(sys.argv) > 3 else 0.22

img = Image.open(src).convert("RGBA")

# Deixa quadrada sem distorcer
side = max(img.size)
square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
square.paste(img, ((side - img.width) // 2, (side - img.height) // 2))

if radius_ratio > 0:
    # Máscara com cantos arredondados desenhada em alta resolução (bordas suaves)
    scale = 4
    big = side * scale
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, big - 1, big - 1), radius=int(big * radius_ratio), fill=255)
    mask = mask.resize((side, side), Image.LANCZOS)
    alpha = Image.composite(square.getchannel("A"), Image.new("L", (side, side), 0), mask)
    square.putalpha(alpha)

square.save(dst, format="ICO", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print(f"Ícone gerado: {dst}")
