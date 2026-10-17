#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
安装包成分检测 —— 上传公网前的例行检查
==================================================================
为什么需要它：
    一个安装包里可能夹带着业务数据 —— 数据库文件、商品/客户图片、
    导出的报表等等。这些一旦原样传到公网，等于把内部数据公开了，
    而包本身看上去只是个"程序"。
    这个脚本在上传前把每个包拆开看一眼，确认是"纯程序"还是"带数据"。

用法：
    python check-package.py <文件或目录> [更多...]
    python check-package.py "D:/pkg"                 # 检查整个目录
    python check-package.py a.zip b.rar              # 只查指定文件

判定：
    CLEAN       纯程序包，可以传
    SUSPICIOUS  有可疑内容（大 .dat 或大量图片），人工看一眼再定
    DIRTY       含已知的业务数据文件，绝对不能原样传

退出码：0 = 全部干净；1 = 存在 SUSPICIOUS 或 DIRTY

按需调整：
    下面 KNOWN_DATA_FILES 里是**示例**文件名，请换成本项目里
    确实不该外传的那些（数据库、导出文件、密钥文件等）。
==================================================================
"""
import os
import re
import sys
import subprocess
import zipfile
from pathlib import Path

# WinRAR 自带的解包工具，只用来列目录、不解压
UNRAR_CANDIDATES = [
    r"C:\Program Files\WinRAR\UnRAR.exe",
    r"C:\Program Files (x86)\WinRAR\UnRAR.exe",
    "unrar",
]

# 已知的业务数据文件名（小写匹配）。**按自己的项目改这一份。**
KNOWN_DATA_FILES = {
    "app.db",       # 主业务库
    "app.db-wal",   # 业务库日志
    "config.dat",   # 程序配置
    "export.csv",   # 导出数据
}

# 这些扩展名 + 体积超过阈值 -> 视作业务数据
DATA_EXTS = {".dat", ".mdb", ".accdb", ".dbf", ".sqlite", ".db", ".fdb", ".gdb"}
DATA_SIZE_THRESHOLD = 100 * 1024          # 100 KB

IMG_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".gif", ".webp"}
IMG_COUNT_THRESHOLD = 20                   # 图片超过这个数就要留意

ARCHIVE_EXTS = {".zip", ".rar", ".7z", ".tar", ".gz"}

RED, YEL, GRN, DIM, RST = "\033[31m", "\033[33m", "\033[32m", "\033[2m", "\033[0m"
if os.name == "nt" and not os.environ.get("WT_SESSION"):
    RED = YEL = GRN = DIM = RST = ""      # 老终端不支持颜色就关掉


def find_unrar():
    for c in UNRAR_CANDIDATES:
        if c == "unrar":
            try:
                subprocess.run([c], capture_output=True, timeout=5)
                return c
            except (FileNotFoundError, subprocess.TimeoutExpired):
                continue
        elif os.path.exists(c):
            return c
    return None


UNRAR = find_unrar()


def list_zip(p):
    """列出 zip 内容 (名称, 原始大小)"""
    with zipfile.ZipFile(p) as z:
        return [(i.filename, i.file_size) for i in z.infolist()]


def list_rar(p):
    """通过 unrar l 列出 rar 内容。

    输出格式固定宽度，形如：
        Attributes      Size     Date    Time   Name
        ----------- ---------  ---------- -----  ----
            ..A....   1234567  2024-01-01 12:00  path/file.ext
    """
    if not UNRAR:
        return None
    try:
        r = subprocess.run([UNRAR, "l", "-p-", p],
                           capture_output=True, timeout=120)
    except subprocess.TimeoutExpired:
        return None
    if r.returncode not in (0, 1):
        return None
    text = r.stdout.decode("gbk", "ignore")
    entries = []
    for line in text.splitlines():
        m = re.match(
            r"^.{10}\s+(\d+)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+(.+?)\s*$",
            line)
        if m:
            try:
                entries.append((m.group(2), int(m.group(1))))
            except ValueError:
                pass
    return entries


def list_7z(p):
    """没装 7z 时返回 None，调用方会降级处理"""
    for exe in ("7z", r"C:\Program Files\7-Zip\7z.exe"):
        try:
            r = subprocess.run([exe, "l", "-slt", p],
                               capture_output=True, timeout=120)
            if r.returncode != 0:
                continue
            text = r.stdout.decode("utf-8", "ignore")
            entries, cur = [], {}
            for line in text.splitlines():
                if line.startswith("Path = "):
                    cur["n"] = line[7:]
                elif line.startswith("Size = "):
                    cur["s"] = int(line[7:])
                elif not line.strip() and cur.get("n"):
                    entries.append((cur["n"], cur.get("s", 0)))
                    cur = {}
            return entries[1:] if entries else entries   # 去掉归档自身
        except (FileNotFoundError, subprocess.TimeoutExpired, ValueError):
            continue
    return None


def list_archive(p):
    ext = Path(p).suffix.lower()
    if ext == ".zip":
        try:
            return list_zip(p), "zip"
        except zipfile.BadZipFile:
            return None, "损坏的 zip"
    if ext == ".rar":
        e = list_rar(p)
        return (e, "unar") if e is not None else (None, "无法读取（缺 unrar）")
    if ext in (".7z", ".tar", ".gz"):
        e = list_7z(p)
        return (e, "7z") if e is not None else (None, "无法读取（缺 7z）")
    return None, "非压缩包"


def analyze(entries):
    """返回 (判定, 发现列表)"""
    findings = []
    dirty = False
    suspicious = False

    total_size = sum(s for _, s in entries)

    # 1. 已知业务数据文件
    for name, size in entries:
        base = Path(name).name.lower()
        if base in KNOWN_DATA_FILES:
            dirty = True
            findings.append(
                f"{RED}业务数据文件{RST} {name}  ({size/1048576:.1f} MB)")

    # 2. 大体积数据类文件
    for name, size in entries:
        base = Path(name).name.lower()
        if base in KNOWN_DATA_FILES:
            continue
        if Path(name).suffix.lower() in DATA_EXTS and size > DATA_SIZE_THRESHOLD:
            suspicious = True
            findings.append(
                f"{YEL}大体积数据文件{RST} {name}  ({size/1048576:.1f} MB)")

    # 3. 图片堆积（商品图 / 客户照片的典型特征）
    imgs = [(n, s) for n, s in entries
            if Path(n).suffix.lower() in IMG_EXTS]
    if len(imgs) >= IMG_COUNT_THRESHOLD:
        dirs = {}
        for n, _ in imgs:
            d = str(Path(n).parent)
            dirs[d] = dirs.get(d, 0) + 1
        top = max(dirs.items(), key=lambda x: x[1]) if dirs else ("", 0)
        suspicious = True
        findings.append(
            f"{YEL}图片堆集{RST} 共 {len(imgs)} 张，最多在 {top[0]}/ （{top[1]} 张）")

    verdict = "DIRTY" if dirty else ("SUSPICIOUS" if suspicious else "CLEAN")
    return verdict, findings, total_size


def human(n):
    if n < 1048576:
        return f"{n/1024:.1f} KB"
    if n < 1073741824:
        return f"{n/1048576:.1f} MB"
    return f"{n/1073741824:.2f} GB"


COLOR = {"CLEAN": GRN, "SUSPICIOUS": YEL, "DIRTY": RED}
LABEL = {"CLEAN": "[ OK ]", "SUSPICIOUS": "[ !! ]", "DIRTY": "[ XX ]"}


def check_one(p):
    name = os.path.basename(p)
    size = os.path.getsize(p)
    entries, how = list_archive(p)

    if entries is None:
        print(f"{DIM}{LABEL['SUSPICIOUS']}{RST} {name}")
        print(f"        {human(size)}  {DIM}跳过：{how}{RST}")
        return "SUSPICIOUS", 0

    verdict, findings, unpacked = analyze(entries)
    c, lb = COLOR[verdict], LABEL[verdict]

    print(f"{c}{lb}{RST} {name}")
    print(f"        包 {human(size)} / 解压后 {human(unpacked)} / {len(entries)} 个文件")
    for f in findings:
        print(f"        {f}")
    if verdict == "CLEAN":
        print(f"        {DIM}纯程序包，无客户数据特征{RST}")
    print()
    return verdict, 1


def collect(targets):
    files = []
    for t in targets:
        if os.path.isdir(t):
            for root, _, names in os.walk(t):
                for n in names:
                    if Path(n).suffix.lower() in ARCHIVE_EXTS:
                        files.append(os.path.join(root, n))
        elif os.path.isfile(t):
            files.append(t)
        else:
            print(f"找不到: {t}")
    return files


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1

    files = collect(sys.argv[1:])
    if not files:
        print("没有找到可检测的压缩包")
        return 1

    print(f"检测 {len(files)} 个包")
    print("=" * 62)

    tally = {"CLEAN": 0, "SUSPICIOUS": 0, "DIRTY": 0}
    for p in sorted(files):
        verdict, _ = check_one(p)
        tally[verdict] += 1

    print("=" * 62)
    print(f"结果：{GRN}干净 {tally['CLEAN']}{RST}   "
          f"{YEL}需确认 {tally['SUSPICIOUS']}{RST}   "
          f"{RED}含业务数据 {tally['DIRTY']}{RST}")

    if tally["DIRTY"]:
        print(f"\n{RED}有包含业务数据，绝不能原样上传。{RST}")
        print("处理：先剔除数据文件，只传纯程序版。")
    if tally["SUSPICIOUS"]:
        print(f"\n{YEL}有包需要人工确认后再决定是否上传。{RST}")

    return 0 if tally["DIRTY"] == 0 and tally["SUSPICIOUS"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
