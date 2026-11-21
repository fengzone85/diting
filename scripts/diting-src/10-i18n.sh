# ── 国际化（i18n）──────────────────────────────────────────────────────────────
# 自动选语言，默认中文。
# 取值优先级需处理 sudo 的干扰：sudo 默认注入 LC_ALL=C.UTF-8 并把 LANG 重置为
# C.UTF-8（除非 sudoers 配 env_keep）。而 LC_ALL 优先级高于 LANG，若直接采用
# LC_ALL，用户显式写的 LANG=zh_CN.UTF-8 会被忽略 → 界面变英文。
# 故：LC_ALL 仅在它是「明确语言」时采用；C/POSIX 系视为未指定，回退看 LANG。
_pick_lang() {
    local l="$1"
    case "$l" in
        C|POSIX|C.UTF-8|POSIX.UTF-8) return 1 ;;   # 「未指定」语义
        "") return 1 ;;
        en*|EN*) echo "en"; return 0 ;;
        zh*|ZH*) echo "zh"; return 0 ;;
        *) echo "zh"; return 0 ;;
    esac
}
# ── 语言持久化（/etc/diting/ui.lang）───────────────────────────────────────────
# 优先级：用户显式选择（持久化文件）> LC_ALL/LANG 环境判定 > 默认中文。
# 首次交互运行会询问一次并写入；菜单内可随时切换。写失败（如非 root）静默降级
# 为环境判定，仅本次会话生效。
UI_LANG_FILE="${DITING_UI_LANG_FILE:-/etc/diting/ui.lang}"
_valid_lang() {
    case "$1" in
        zh|en) echo "$1" ;;
        *) return 1 ;;
    esac
}
load_saved_lang() {
    [[ -r "$UI_LANG_FILE" ]] || return 1
    _valid_lang "$(head -c 8 "$UI_LANG_FILE" 2>/dev/null | tr -d '[:space:]')"
}
save_lang() {
    mkdir -p "$(dirname "$UI_LANG_FILE")" 2>/dev/null || true
    printf '%s\n' "$1" > "$UI_LANG_FILE" 2>/dev/null || true
}
I18N_LANG="zh"
_saved_lang="$(load_saved_lang 2>/dev/null || true)"
if [[ -n "$_saved_lang" ]]; then
    I18N_LANG="$_saved_lang"
elif _pick_lang "${LC_ALL:-}" >/dev/null 2>&1; then
    I18N_LANG="$( _pick_lang "${LC_ALL:-}" )"
elif _pick_lang "${LANG:-}" >/dev/null 2>&1; then
    I18N_LANG="$( _pick_lang "${LANG:-}" )"
fi
unset _saved_lang
# 消息函数：msg "key" → 输出对应语言的文本
msg() {
    local key="$1"
    if [[ "$I18N_LANG" == "en" ]]; then
        echo "${I18N_EN[$key]:-$key}"
    else
        echo "${I18N_ZH[$key]:-$key}"
    fi
}

