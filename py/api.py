"""HTTP 接口：预设 / 历史的读写。

接口都在 /prompt_presets/api/* 下，返回 JSON。
没有管理页面 —— 所有交互都在画布的文本框里完成。
"""

from __future__ import annotations

from typing import List

from .store import get_store
from .util import log

BASE = "/prompt_presets"
API = BASE + "/api"

_registered = False


def register() -> None:
    global _registered
    if _registered:
        return

    from aiohttp import web
    from server import PromptServer

    routes = PromptServer.instance.routes

    @routes.get(API + "/state")
    async def _state(_request):
        return web.json_response({"ok": True, "state": get_store().view()})

    # ------------------------------------------------------------------ #
    # 预设
    # ------------------------------------------------------------------ #

    @routes.post(API + "/preset")
    async def _preset_save(request):
        body = await _body(request)
        key = str(body.get("workflow") or "")
        text = body.get("text")
        if not isinstance(text, str) or not text.strip():
            return web.json_response({"ok": False, "error": "内容不能为空"}, status=400)
        try:
            entry = get_store().add_preset(
                key,
                text,
                name=str(body.get("name") or ""),
                preset_id=str(body.get("id") or ""),
            )
        except ValueError as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=400)
        return web.json_response({"ok": True, "preset": entry, "state": get_store().view()})

    @routes.post(API + "/preset/delete")
    async def _preset_delete(request):
        body = await _body(request)
        ok = get_store().delete_preset(str(body.get("workflow") or ""), str(body.get("id") or ""))
        return web.json_response(
            {"ok": ok, "state": get_store().view()},
            status=200 if ok else 404,
        )

    @routes.post(API + "/preset/move")
    async def _preset_move(request):
        body = await _body(request)
        ok = get_store().move_preset(
            str(body.get("workflow") or ""),
            str(body.get("id") or ""),
            str(body.get("target") or ""),
        )
        return web.json_response({"ok": ok, "state": get_store().view()})

    # ------------------------------------------------------------------ #
    # 历史
    # ------------------------------------------------------------------ #

    @routes.post(API + "/history")
    async def _history_record(request):
        body = await _body(request)
        texts = body.get("texts")
        if not isinstance(texts, list):
            return web.json_response({"ok": False, "error": "texts 必须是数组"}, status=400)
        items = get_store().record_history(
            str(body.get("workflow") or ""),
            str(body.get("node") or ""),
            [t for t in texts if isinstance(t, str)],
        )
        return web.json_response({"ok": True, "items": items})

    @routes.post(API + "/history/clear")
    async def _history_clear(request):
        body = await _body(request)
        ok = get_store().clear_history(
            str(body.get("workflow") or ""), str(body.get("node") or "")
        )
        return web.json_response({"ok": ok, "state": get_store().view()})

    _registered = True
    log(f"接口已挂载：{API}")


async def _body(request) -> dict:
    try:
        data = await request.json()
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}
