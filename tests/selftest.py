"""离线自检：不启动 ComfyUI，桩掉 folder_paths 直接测存储逻辑。

    python tests/selftest.py
"""

import json
import os
import sys
import tempfile
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

TMP = tempfile.mkdtemp(prefix="pp_test_")
# 桩 folder_paths：让 util.data_dir() 落到临时目录
fake = types.ModuleType("folder_paths")
fake.base_path = TMP
fake.get_user_directory = lambda: TMP
sys.modules["folder_paths"] = fake

from py import store as S  # noqa: E402

ok = 0
bad = 0


def check(name, cond, extra=""):
    global ok, bad
    if cond:
        ok += 1
        print(f"  [ ok ] {name}")
    else:
        bad += 1
        print(f"  [FAIL] {name} {extra}")


def fresh():
    p = os.path.join(TMP, f"data_{len(os.listdir(TMP))}.json")
    return S.PresetStore(p), p


print("== 1. 默认名 ==")
check("首行截断加省略号", S.guess_name("少女，逆光，站在窗边看着远方") == "少女，逆光，站在窗边看着…", S.guess_name("少女，逆光，站在窗边看着远方"))
check("多空格压平", S.guess_name("  樱花  树下  \n第二行") == "樱花 树下", S.guess_name("  樱花  树下  \n第二行"))
check("空文本兜底", S.guess_name("   ") == "未命名预设", S.guess_name("   "))

print("== 2. 预设增删改 ==")
st, path = fresh()
a = st.add_preset("workflows/人像.json", "第一段提示词", "胶片")
b = st.add_preset("workflows/人像.json", "第二段提示词")
check("第一条带名字", a["name"] == "胶片", a["name"])
check("第二条自动起名", b["name"] == "第二段提示词", b["name"])
v = st.view()
check("工作流数为 1", v["counts"]["workflows"] == 1, v["counts"])
check("预设数为 2", v["counts"]["presets"] == 2, v["counts"])
check("工作流名取自路径", v["workflows"]["workflows/人像.json"]["name"] == "人像", v["workflows"])

st.add_preset("workflows/人像.json", "第三段", "同名也不覆盖")
check("同名预设是追加不是覆盖", len(st.view()["workflows"]["workflows/人像.json"]["presets"]) == 3)

upd = st.add_preset("workflows/人像.json", "改过的正文", "改过的名字", preset_id=a["id"])
check("按 id 更新", upd["id"] == a["id"] and upd["text"] == "改过的正文", upd)
check("更新不新增", len(st.view()["workflows"]["workflows/人像.json"]["presets"]) == 3)

try:
    st.add_preset("workflows/人像.json", "   ")
    check("空内容拒绝", False)
except ValueError:
    check("空内容拒绝", True)

check("删除成功", st.delete_preset("workflows/人像.json", b["id"]) is True)
check("删除不存在的返回 False", st.delete_preset("workflows/人像.json", "nope") is False)
check("删完剩 2 条", len(st.view()["workflows"]["workflows/人像.json"]["presets"]) == 2)

print("== 3. 跨工作流移动 ==")
c = st.add_preset("__unsaved__", "未保存时的预设", "临时")
check("未保存工作流可存", st.view()["counts"]["workflows"] == 2, st.view()["counts"])
check("移动到目标", st.move_preset("__unsaved__", c["id"], "workflows/风景.json") is True)
v = st.view()
check("源已空", len(v["workflows"]["__unsaved__"]["presets"]) == 0)
check("目标有 1 条", len(v["workflows"]["workflows/风景.json"]["presets"]) == 1)

print("== 4. 历史 ==")
st2, path2 = fresh()
K = "CLIPTextEncode#12"
for i in range(12):
    items = st2.record_history("workflows/人像.json", K, [f"文本{i}"])
check("上限 10 条", len(items) == 10, len(items))
check("最新的在最前", items[0]["text"] == "文本11", items[0])
check("最旧的被挤掉", all(h["text"] != "文本0" for h in items))

before = len(st2.record_history("workflows/人像.json", K, ["文本5"]))
items = st2.view()["workflows"]["workflows/人像.json"]["history"][K]
check("重复文本不新增", len(items) == 10, len(items))
check("重复文本提到最前", items[0]["text"] == "文本5", items[0])
check("总数没变", before == 10, before)

st2.record_history("workflows/人像.json", "CLIPTextEncode#99", ["另一个节点"])
v = st2.view()["workflows"]["workflows/人像.json"]
check("不同节点分开存", set(v["history"].keys()) == {K, "CLIPTextEncode#99"}, v["history"].keys())

check("清空单节点", st2.clear_history("workflows/人像.json", K) is True)
check("另一个节点还在", "CLIPTextEncode#99" in st2.view()["workflows"]["workflows/人像.json"]["history"])
st2.clear_history("workflows/人像.json")
check("全清", st2.view()["workflows"]["workflows/人像.json"]["history"] == {})

print("== 5. 落盘 / 重新加载 ==")
check("数据文件存在", os.path.isfile(path2), path2)
with open(path2, "r", encoding="utf-8") as f:
    raw = json.load(f)
check("JSON 可解析且结构对", isinstance(raw.get("workflows"), dict) and raw["version"] == 1)
st3 = S.PresetStore(path2)
check("重新加载后数据还在", st3.view()["counts"]["presets"] == 0 and len(st3.view()["workflows"]) == 1)

st.add_preset("workflows/人像.json", "再存一条触发备份")
check("写入后留下 .bak", os.path.isfile(path + ".bak"), path + ".bak")
check("没有残留 .tmp", not any(x.endswith(".tmp") for x in os.listdir(os.path.dirname(path))))

print("== 6. 键处理 ==")
check("反斜杠归一", S.norm_key("workflows\\a.json") == "workflows/a.json", S.norm_key("workflows\\a.json"))
check("空键落到未保存", S.norm_key("  ") == "__unsaved__", S.norm_key("  "))
check("未保存的显示名", S.name_from_key("__unsaved__") == "未保存的工作流")
check("子目录只取文件名", S.name_from_key("workflows/sub/x.json") == "x", S.name_from_key("workflows/sub/x.json"))

print()
print(f"通过 {ok} 项，失败 {bad} 项")
sys.exit(1 if bad else 0)
