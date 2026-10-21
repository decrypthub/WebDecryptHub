#!/usr/bin/env python3
"""Render NSIS header (150x57), sidebar (164x314), and installer icon from the repo logo.

Brand colors match https://ios.decrypthub.com/ (ink #050506, coral #FF8B7B, paper white).
No gradients.
"""
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
LOGO_SVG = ROOT / "brand" / "logo.svg"
OUT = ROOT / "src-tauri" / "windows"
PREVIEW = ROOT / "docs" / "installer"
INK = (5, 5, 6)
CORAL = (255, 139, 123)
WHITE = (255, 255, 255)
PAPER = (247, 248, 251)
MUTED = (151, 157, 168)
LINE = (225, 227, 232)
TITLE = (10, 11, 14)

INTER = "/usr/share/fonts/truetype/macos/Inter-SemiBold.ttf"
INTER_MED = "/usr/share/fonts/truetype/macos/Inter-Medium.ttf"
CJK = "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc"


def font(path, size):
    return ImageFont.truetype(path, size)


def render_logo(size):
    png = Path("/tmp/wdh-logo.png")
    subprocess.check_call([
        "rsvg-convert", "-w", str(size), "-h", str(size), "-o", str(png), str(LOGO_SVG),
    ])
    im = Image.open(png).convert("RGBA")
    bbox = im.getbbox()
    if bbox:
        im = im.crop(bbox)
    # Square tile, logo centered.
    side = max(im.size)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(im, ((side - im.width) // 2, (side - im.height) // 2), im)
    return canvas.resize((size, size), Image.Resampling.LANCZOS)


def wordmark(draw, xy, size, fill_rest=INK):
    f = font(INTER, size)
    x, y = xy
    a = "WebDecrypt"
    b = "Hub"
    draw.text((x, y), a, font=f, fill=fill_rest)
    w = draw.textlength(a, font=f)
    draw.text((x + w, y), b, font=f, fill=CORAL)
    return w + draw.textlength(b, font=f)


def wordmark_width(size):
    f = font(INTER, size)
    scratch = ImageDraw.Draw(Image.new("RGB", (8, 8)))
    return scratch.textlength("WebDecrypt", font=f) + scratch.textlength("Hub", font=f)


def header():
    im = Image.new("RGB", (150, 57), WHITE)
    draw = ImageDraw.Draw(im)
    logo = render_logo(36).convert("RGBA")
    im.paste(logo, (8, 10), logo)
    wordmark(draw, (50, 18), 13)
    draw.rectangle((0, 55, 149, 56), fill=CORAL)
    return im


def sidebar():
    im = Image.new("RGB", (164, 314), INK)
    draw = ImageDraw.Draw(im)
    logo = render_logo(78).convert("RGBA")
    im.paste(logo, ((164 - 78) // 2, 48), logo)
    total = wordmark_width(13)
    wordmark(draw, ((164 - total) / 2, 148), 13, WHITE)
    cjk = font(CJK, 13)
    sub = "JS 逆向工作台"
    sw = draw.textlength(sub, font=cjk)
    draw.text(((164 - sw) / 2, 176), sub, font=cjk, fill=MUTED)
    foot = font(INTER_MED, 10)
    site = "decrypthub.com"
    fw = draw.textlength(site, font=foot)
    draw.text(((164 - fw) / 2, 276), site, font=foot, fill=(91, 100, 114))
    draw.rectangle((0, 310, 163, 313), fill=CORAL)
    return im


def icon_images():
    base = render_logo(256)
    sizes = [16, 24, 32, 48, 64, 128, 256]
    return [base.resize((s, s), Image.Resampling.LANCZOS) for s in sizes]


def save_bmp(im, path):
    im.convert("RGB").save(path, format="BMP")


def window(title, w=498, h=392):
    im = Image.new("RGB", (w, h), PAPER)
    d = ImageDraw.Draw(im)
    d.rectangle((0, 0, w - 1, h - 1), outline=LINE)
    d.rectangle((0, 0, w - 1, 32), fill=WHITE)
    d.line((0, 32, w, 32), fill=LINE)
    d.text((14, 8), title, font=font(CJK, 13), fill=TITLE)
    return im, d


def page_welcome(side):
    im, d = window("WebDecryptHub 安装")
    im.paste(side, (0, 33))
    d.text((188, 64), "安装 WebDecryptHub", font=font(CJK, 20), fill=TITLE)
    body = "安装到当前用户目录，不需要管理员权限。\n\n已有的设置、密钥和项目数据会保留。"
    d.multiline_text((188, 108), body, font=font(CJK, 13), fill=(65, 74, 89), spacing=4)
    # Next button
    d.rounded_rectangle((300, 344, 384, 372), 4, fill=CORAL)
    d.text((326, 350), "下一步", font=font(CJK, 13), fill=INK)
    d.rounded_rectangle((394, 344, 470, 372), 4, outline=LINE, fill=WHITE)
    d.text((418, 350), "取消", font=font(CJK, 13), fill=TITLE)
    return im


def page_progress(head):
    im, d = window("WebDecryptHub 安装")
    d.rectangle((0, 33, 497, 96), fill=WHITE)
    d.line((0, 96, 497, 96), fill=LINE)
    d.text((18, 44), "正在安装", font=font(CJK, 16), fill=TITLE)
    d.text((18, 70), "先结束安装目录内的进程，再写入文件", font=font(CJK, 12), fill=MUTED)
    im.paste(head, (498 - 150 - 8, 36))
    lines = [
        "步骤：结束安装目录内的 WebDecryptHub、sidecar 与捆绑 Node",
        "正在结束安装目录内的进程",
        "步骤：写入程序文件",
        "文件仍被占用，正在重试 (1/16)：jsra-sidecar.exe",
    ]
    y = 116
    for i, line in enumerate(lines):
        color = CORAL if i == len(lines) - 1 else (65, 74, 89)
        d.text((18, y), line, font=font(CJK, 12), fill=color)
        y += 22
    d.rounded_rectangle((18, 320, 470, 332), 3, fill=(228, 230, 235))
    d.rounded_rectangle((18, 320, 280, 332), 3, fill=CORAL)
    d.text((18, 344), "正在安装", font=font(CJK, 12), fill=MUTED)
    return im


def page_finish(side):
    im, d = window("WebDecryptHub 安装")
    im.paste(side, (0, 33))
    d.text((188, 64), "安装完成", font=font(CJK, 20), fill=TITLE)
    d.multiline_text((188, 108), "WebDecryptHub 已经安装好。\n\n可以立即启动，也可以稍后从开始菜单打开。", font=font(CJK, 13), fill=(65, 74, 89), spacing=4)
    # checkbox
    d.rounded_rectangle((188, 250, 204, 266), 3, outline=CORAL, width=2, fill=WHITE)
    d.line((191, 258, 195, 263), fill=CORAL, width=2)
    d.line((195, 263, 201, 253), fill=CORAL, width=2)
    d.text((212, 250), "立即启动 WebDecryptHub", font=font(CJK, 13), fill=TITLE)
    d.rounded_rectangle((394, 344, 470, 372), 4, fill=CORAL)
    d.text((418, 350), "完成", font=font(CJK, 13), fill=INK)
    return im


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    PREVIEW.mkdir(parents=True, exist_ok=True)
    head = header()
    side = sidebar()
    save_bmp(head, OUT / "header.bmp")
    save_bmp(side, OUT / "sidebar.bmp")
    head.save(PREVIEW / "header.png")
    side.save(PREVIEW / "sidebar.png")
    icons = icon_images()
    icons[-1].save(OUT / "installer.ico", format="ICO", sizes=[(im.width, im.height) for im in icons], append_images=icons[:-1])
    icons[-1].save(PREVIEW / "installer-icon.png")
    page_welcome(side).save(PREVIEW / "page-welcome.png")
    page_progress(head).save(PREVIEW / "page-progress.png")
    page_finish(side).save(PREVIEW / "page-finish.png")
    # Exact sizes the NSIS template asks for.
    assert Image.open(OUT / "header.bmp").size == (150, 57)
    assert Image.open(OUT / "sidebar.bmp").size == (164, 314)
    print("wrote", OUT)


if __name__ == "__main__":
    main()
