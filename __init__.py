"""ComfyUI 提示词预设

在任意「多行文本」输入框（含 CLIP 文本编码）的左下角挂一个小按钮，
点开是「本节点历史提示词 + 按工作流分类的预设库」，点一下应用到文本框。

本插件不注册任何节点，只提供一个前端扩展和几个数据接口。
"""

from .py.util import log

# ComfyUI 会把 WEB_DIRECTORY 下的所有 .js 当作前端扩展模块自动 import，
# 所以这里只放前端脚本；脚本里的 import 路径相对这个目录算（js/x.js -> ../../scripts/app.js）。
WEB_DIRECTORY = "./js"

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

try:
    from .py import api as _api

    _api.register()
except Exception as exc:  # pragma: no cover
    log("HTTP 接口注册失败（预设无法保存）：", repr(exc))

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
