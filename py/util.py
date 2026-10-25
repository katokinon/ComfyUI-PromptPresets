"""通用工具：路径解析、原子 JSON 读写、日志。"""

from __future__ import annotations

import json
import os
import tempfile
import threading
from pathlib import Path
from typing import Any, Dict

PREFIX = "[提示词预设]"


def log(*args: Any) -> None:
    print(PREFIX, *args, flush=True)


def comfy_user_dir() -> Path:
    """ComfyUI 的 user 目录；数据放这里，插件升级/重装不会丢。"""
    try:
        import folder_paths

        try:
            return Path(folder_paths.get_user_directory())
        except Exception:
            return Path(folder_paths.base_path) / "user" / "default"
    except Exception:
        return Path(__file__).resolve().parents[2] / "user_data"


def data_dir() -> Path:
    d = comfy_user_dir() / "prompt_presets"
    d.mkdir(parents=True, exist_ok=True)
    return d


_locks: Dict[str, threading.RLock] = {}
_locks_guard = threading.Lock()


def file_lock(path) -> threading.RLock:
    key = str(path)
    with _locks_guard:
        lock = _locks.get(key)
        if lock is None:
            lock = threading.RLock()
            _locks[key] = lock
        return lock


def read_json(path, default=None):
    p = Path(path)
    if not p.exists():
        return default
    try:
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as exc:
        log(f"读取 {p.name} 失败：{exc!r}")
        return default


def atomic_write_json(path, data) -> None:
    """先写临时文件再 os.replace，避免写到一半被读到。"""
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(p.parent), prefix=p.name, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, p)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
