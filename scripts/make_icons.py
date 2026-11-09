from PIL import Image, ImageDraw
import os

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
out_dir = os.path.join(root, "apps", "desktop", "src-tauri", "icons")
os.makedirs(out_dir, exist_ok=True)
S = 512
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
r = 118
d.rounded_rectangle([16, 16, S - 16, S - 16], radius=r, fill=(15, 20, 33, 255), outline=(58, 76, 104, 255), width=10)
for i in range(60):
    alpha = int(14 * (1 - i / 60))
    d.arc([40, 40, S - 40, S - 40], 200, 340, fill=(120, 170, 255, alpha), width=3)
box = [96, 96, S - 96, S - 96]
d.arc(box, start=135, end=405, fill=(76, 154, 255, 255), width=34)
d.arc(box, start=40, end=130, fill=(67, 201, 139, 255), width=34)
d.ellipse([214, 214, 298, 298], fill=(230, 238, 252, 255))
d.ellipse([238, 238, 274, 274], fill=(15, 20, 33, 255))
d.ellipse([356, 92, 420, 156], fill=(242, 184, 75, 255), outline=(15, 20, 33, 255), width=8)

for size in (32, 64, 128, 256, 512):
    resized = img.resize((size, size), Image.LANCZOS)
    name = "icon.png" if size == 512 else f"{size}x{size}.png"
    resized.save(os.path.join(out_dir, name))
img.resize((256, 256), Image.LANCZOS).save(
    os.path.join(out_dir, "icon.ico"),
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)
print("icons written")
