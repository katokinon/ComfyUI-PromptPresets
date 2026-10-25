"""预设库 + 历史记录的持久化。

数据文件：<ComfyUI user 目录>/prompt_presets/data.json

结构：
{
  "version": 1,
  "workflows": {
    "workflows/人像.json": {          # 工作流键 = 前端给的 path；未保存的新工作流是 "__unsaved__"
      "name": "人像",
      "updated": 1761000000.0,
      "presets": [ {"id","name","text","created","updated"} ],
      "history": { "CLIPTextEncode#12": [ {"text","ts"} ] }
    }
  }
}

- 以工作流为基准：预设和历史都挂在工作流键下，但读取时前端可以跨工作流取。
- 写入一律原子替换，另外留一份 .bak，写坏了还能捞回来。
"""

from __future__ import annotations

import shutil
import threading
import time
import uuid
from pathlib import Path
from typing import Dict, List, Optional

from .util import atomic_write_json, data_dir, file_lock, log, read_json

SCHEMA_VERSION = 1
DATA_FILE = "data.json"
HISTORY_LIMIT = 10
UNSAVED_KEY = "__unsaved__"

# 名字没填时从正文里截一段当名字
NAME_PREVIEW = 12


def _now() -> float:
    return time.time()


def new_id() -> str:
    return f"p{uuid.uuid4().hex[:8]}"


def guess_name(text: str) -> str:
    """拿首行前 NAME_PREVIEW 个字当默认名字。"""
    head = (text or "").strip().splitlines()
    line = head[0].strip() if head else ""
    line = " ".join(line.split())
    if not line:
        return "未命名预设"
    return line[:NAME_PREVIEW] + ("…" if len(line) > NAME_PREVIEW else "")


def norm_key(key: str) -> str:
    k = (key or "").replace("\\", "/").strip()
    return k or UNSAVED_KEY


def name_from_key(key: str) -> str:
    if key == UNSAVED_KEY:
        return "未保存的工作流"
    base = key.split("/")[-1]
    return base[:-5] if base.lower().endswith(".json") else base


class PresetStore:
    def __init__(self, path: Optional[Path] = None):
        self.path = Path(path) if path else (data_dir() / DATA_FILE)
        self._lock = file_lock(self.path)
        self._data: dict = {"version": SCHEMA_VERSION, "workflows": {}}
        self.load()

    # ------------------------------------------------------------------ #
    # 读写
    # ------------------------------------------------------------------ #

    def load(self) -> None:
        with self._lock:
            raw = read_json(self.path, None)
            if not isinstance(raw, dict) or not isinstance(raw.get("workflows"), dict):
                self._data = {"version": SCHEMA_VERSION, "workflows": {}}
                return
            raw.setdefault("version", SCHEMA_VERSION)
            self._data = raw

    def save(self) -> None:
        with self._lock:
            try:
                if self.path.exists():
                    shutil.copy2(self.path, self.path.with_name(self.path.name + ".bak"))
            except OSError:
                pass
            atomic_write_json(self.path, self._data)

    def _wf(self, key: str, create: bool = False) -> Optional[dict]:
        k = norm_key(key)
        entries = self._data["workflows"]
        wf = entries.get(k)
        if wf is None:
            if not create:
                return None
            wf = {"name": name_from_key(k), "updated": _now(), "presets": [], "history": {}}
            entries[k] = wf
        wf.setdefault("presets", [])
        wf.setdefault("history", {})
        wf.setdefault("name", name_from_key(k))
        return wf

    # ------------------------------------------------------------------ #
    # 预设
    # ------------------------------------------------------------------ #

    def add_preset(
        self,
        key: str,
        text: str,
        name: str = "",
        preset_id: str = "",
        order: Optional[int] = None,
    ) -> dict:
        """新增或更新一条预设。preset_id 存在就是更新。"""
        with self._lock:
            wf = self._wf(key, create=True)
            text = text or ""
            if not text.strip():
                raise ValueError("预设内容不能为空")
            name = (name or "").strip() or guess_name(text)
            items = wf["presets"]

            if preset_id:
                for it in items:
                    if it.get("id") == preset_id:
                        it["name"] = name
                        it["text"] = text
                        it["updated"] = _now()
                        wf["updated"] = _now()
                        self.save()
                        return dict(it)

            entry = {
                "id": preset_id or new_id(),
                "name": name,
                "text": text,
                "created": _now(),
                "updated": _now(),
            }
            if isinstance(order, int) and 0 <= order <= len(items):
                items.insert(order, entry)
            else:
                items.append(entry)
            wf["updated"] = _now()
            self.save()
            return dict(entry)

    def delete_preset(self, key: str, preset_id: str) -> bool:
        with self._lock:
            wf = self._wf(key)
            if not wf:
                return False
            before = len(wf["presets"])
            wf["presets"] = [p for p in wf["presets"] if p.get("id") != preset_id]
            if len(wf["presets"]) == before:
                return False
            wf["updated"] = _now()
            self.save()
            return True

    def move_preset(self, key: str, preset_id: str, target_key: str) -> bool:
        """把预设挪到另一个工作流下（比如从「未保存」挪到刚存下的工作流）。"""
        with self._lock:
            src = self._wf(key)
            if not src:
                return False
            entry = next((p for p in src["presets"] if p.get("id") == preset_id), None)
            if not entry:
                return False
            src["presets"] = [p for p in src["presets"] if p.get("id") != preset_id]
            dst = self._wf(target_key, create=True)
            dst["presets"].append(entry)
            dst["updated"] = _now()
            self.save()
            return True

    # ------------------------------------------------------------------ #
    # 历史
    # ------------------------------------------------------------------ #

    def record_history(self, key: str, node_key: str, texts: List[str]) -> List[dict]:
        """把一次提交里的文本并进历史：去重、最新的在前、最多 HISTORY_LIMIT 条。"""
        cleaned = []
        for t in texts or []:
            if isinstance(t, str) and t.strip():
                cleaned.append(t)
        if not cleaned:
            return []

        with self._lock:
            wf = self._wf(key, create=True)
            bucket = wf["history"].setdefault(node_key, [])
            # 先摘掉同文本的旧记录，再统一插到最前面
            for t in cleaned:
                bucket[:] = [h for h in bucket if h.get("text") != t]
            now = _now()
            for t in cleaned:
                bucket.insert(0, {"text": t, "ts": now})
            del bucket[HISTORY_LIMIT:]
            wf["updated"] = now
            self.save()
            return [dict(h) for h in bucket]

    def clear_history(self, key: str, node_key: str = "") -> bool:
        with self._lock:
            wf = self._wf(key)
            if not wf:
                return False
            if node_key:
                wf["history"].pop(node_key, None)
            else:
                wf["history"] = {}
            wf["updated"] = _now()
            self.save()
            return True

    # ------------------------------------------------------------------ #
    # 视图
    # ------------------------------------------------------------------ #

    def view(self) -> dict:
        with self._lock:
            wfs = {}
            for key, wf in self._data["workflows"].items():
                wfs[key] = {
                    "key": key,
                    "name": wf.get("name") or name_from_key(key),
                    "updated": wf.get("updated", 0),
                    "presets": [dict(p) for p in wf.get("presets", [])],
                    "history": {k: [dict(h) for h in v] for k, v in (wf.get("history") or {}).items()},
                }
            ordered = dict(
                sorted(wfs.items(), key=lambda kv: kv[1]["updated"], reverse=True)
            )
            return {
                "version": SCHEMA_VERSION,
                "history_limit": HISTORY_LIMIT,
                "workflows": ordered,
                "counts": {
                    "presets": sum(len(w["presets"]) for w in wfs.values()),
                    "workflows": len(wfs),
                },
            }


_store: Optional[PresetStore] = None
_store_guard = threading.Lock()


def get_store() -> PresetStore:
    global _store
    with _store_guard:
        if _store is None:
            _store = PresetStore()
            log(f"数据文件：{_store.path}")
        return _store
