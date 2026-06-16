#!/usr/bin/env python3
"""
批处理 assets/photos/raw/ 中的照片：
- 最长边压缩到 1200px
- JPEG 质量 78~85
- 去除 EXIF
- 保持方向正确 (auto-orient)
- 输出到 assets/photos/display/photo-001.jpg ~

处理完成后生成 assets/photos/photos.json
"""

import json
import os
import sys
from pathlib import Path
from PIL import Image

RAW_DIR = Path("assets/photos/raw")
DISPLAY_DIR = Path("assets/photos/display")
OUTPUT_JSON = Path("assets/photos/photos.json")

MAX_DIM = 1200
JPEG_QUALITY = 82  # 78~85 之间

SUFFIXES = {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".tiff", ".webp"}


def process_image(src_path: Path, dst_path: Path, index: int) -> tuple[int, int]:
    """
    处理单张图片，返回 (原始大小字节, 处理后大小字节)
    """
    orig_size = src_path.stat().st_size

    img = Image.open(src_path)

    # 自动纠正 EXIF 方向（拍摄时手机竖拍/横拍信息）
    from PIL import ImageOps
    transposed = ImageOps.exif_transpose(img)
    if transposed is not None:
        img = transposed

    # 按最长边等比缩放
    w, h = img.size
    if max(w, h) > MAX_DIM:
        ratio = MAX_DIM / max(w, h)
        new_w = int(w * ratio)
        new_h = int(h * ratio)
        # 使用 LANZCOS 保证缩放质量
        img = img.resize((new_w, new_h), Image.LANCZOS)

    # 转换为 RGB（去除 alpha 通道，避免 PNG 无法存为 JPEG）
    if img.mode in ("RGBA", "LA", "P"):
        img = img.convert("RGB")

    # 保存，去除 EXIF
    img.save(dst_path, "JPEG", quality=JPEG_QUALITY, optimize=True)

    new_size = dst_path.stat().st_size
    return orig_size, new_size


def main():
    # 收集所有图片文件，按文件名排序保证输出顺序稳定
    image_files = sorted(
        [f for f in RAW_DIR.iterdir() if f.suffix.lower() in SUFFIXES],
        key=lambda p: p.name,
    )

    if not image_files:
        print(f"❌ 在 {RAW_DIR} 中未找到任何图片文件")
        sys.exit(1)

    print(f"📷 找到 {len(image_files)} 张图片\n")

    # 确保输出目录存在
    DISPLAY_DIR.mkdir(parents=True, exist_ok=True)

    total_orig = 0
    total_new = 0
    results = []

    for idx, src_path in enumerate(image_files, start=1):
        dst_name = f"photo-{idx:03d}.jpg"
        dst_path = DISPLAY_DIR / dst_name

        print(f"  [{idx:02d}/{len(image_files):02d}] {src_path.name} → {dst_name}")

        orig_size, new_size = process_image(src_path, dst_path, idx)

        total_orig += orig_size
        total_new += new_size

        pct = (1 - new_size / orig_size) * 100 if orig_size > 0 else 0
        print(f"         {orig_size / 1024:.1f}KB → {new_size / 1024:.1f}KB ({pct:+.1f}%)\n")

        results.append(str(dst_path.as_posix()))

    # 生成 photos.json
    json_data = {"photos": results}
    with open(OUTPUT_JSON, "w", encoding="utf-8") as f:
        json.dump(json_data, f, ensure_ascii=False, indent=2)
    print(f"✅ {OUTPUT_JSON} 已生成，共 {len(results)} 个展示图路径\n")

    # 汇总
    print("=" * 50)
    print(f"  原始总大小: {total_orig / 1024:.1f} KB ({total_orig / 1024 / 1024:.2f} MB)")
    print(f"  处理后总大小: {total_new / 1024:.1f} KB ({total_new / 1024 / 1024:.2f} MB)")
    print(f"  压缩率: {(1 - total_new / total_orig) * 100:.1f}%")
    print("=" * 50)


if __name__ == "__main__":
    main()