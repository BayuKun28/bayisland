# BayIsland Terminal Task Live Tracker & Done hook for Bash & Zsh.
# Usage in ~/.bashrc or ~/.zshrc:
#   source /path/to/bayisland/scripts/bayisland-shell-hook.sh
#
# Optional env vars:
#   BAYISLAND_TASK_MIN_SEC=8   Minimum command duration (seconds) before notifying

: "${BAYISLAND_TASK_MIN_SEC:=8}"

__bayisland_should_skip() {
    local cmd_first="${1%% *}"
    case "${cmd_first}" in
        ""|vim|nvim|nano|vi|emacs|less|more|man|top|htop|btop|nvtop|ssh|mosh|tmux|screen|fg|bg|watch)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

__bayisland_emit_task_started() {
    local task_id="$1"
    local cmd="${2:0:64}"
    local start_sec="$3"
    local pid="$$"
    command -v gdbus >/dev/null 2>&1 || return 0
    (
        gdbus call --session \
            -d org.bayisland.Shell \
            -o /org/bayisland/Shell \
            -m org.bayisland.Shell.TaskStarted \
            "${task_id}" "${cmd}" "${start_sec}" "${pid}" \
            >/dev/null 2>&1
    ) >/dev/null 2>&1 &
}

__bayisland_emit_task_finished() {
    local task_id="$1"
    local ok="$2"
    local exit_code="$3"
    local dur="$4"
    command -v gdbus >/dev/null 2>&1 || return 0
    (
        gdbus call --session \
            -d org.bayisland.Shell \
            -o /org/bayisland/Shell \
            -m org.bayisland.Shell.TaskFinished \
            "${task_id}" "${ok}" "${exit_code}" "${dur}" \
            >/dev/null 2>&1
    ) >/dev/null 2>&1 &
}

__bayisland_emit_task() {
    local title="$1"
    local body="$2"
    local ok="$3"
    local dur="$4"
    command -v gdbus >/dev/null 2>&1 || return 0
    (
        gdbus call --session \
            -d org.bayisland.Shell \
            -o /org/bayisland/Shell \
            -m org.bayisland.Shell.NotifyTask \
            "${title}" "${body}" "${ok}" "${dur}" \
            >/dev/null 2>&1
    ) >/dev/null 2>&1 &
}

if [[ -n "${BASH_VERSION:-}" ]]; then
    __bayisland_bash_cmd=""
    __bayisland_bash_start=0
    __bayisland_bash_task_id=""
    __bayisland_bash_in_prompt=1

    __bayisland_bash_preexec() {
        [[ "${__bayisland_bash_in_prompt}" -eq 1 ]] && return 0
        [[ "${BASH_COMMAND}" == __bayisland_* ]] && return 0
        [[ -n "${__bayisland_bash_cmd}" ]] && return 0
        __bayisland_bash_cmd="${BASH_COMMAND}"
        __bayisland_bash_start="${SECONDS}"
        if ! __bayisland_should_skip "${__bayisland_bash_cmd}"; then
            __bayisland_bash_task_id="task_${$}_${SECONDS}"
            __bayisland_emit_task_started "${__bayisland_bash_task_id}" "${__bayisland_bash_cmd}" "${SECONDS}"
        fi
    }

    __bayisland_bash_precmd() {
        local exit_code=$?
        __bayisland_bash_in_prompt=1
        if [[ -n "${__bayisland_bash_cmd}" ]]; then
            local dur=$(( SECONDS - __bayisland_bash_start ))
            local cmd="${__bayisland_bash_cmd}"
            local task_id="${__bayisland_bash_task_id}"
            __bayisland_bash_cmd=""
            __bayisland_bash_task_id=""
            if [[ -n "${task_id}" ]]; then
                local ok="true"
                [[ "${exit_code}" -ne 0 ]] && ok="false"
                __bayisland_emit_task_finished "${task_id}" "${ok}" "${exit_code}" "${dur}"
            fi
        fi
        __bayisland_bash_in_prompt=0
    }

    trap '__bayisland_bash_preexec' DEBUG
    if [[ "${PROMPT_COMMAND:-}" != *"__bayisland_bash_precmd"* ]]; then
        PROMPT_COMMAND="__bayisland_bash_precmd${PROMPT_COMMAND:+; ${PROMPT_COMMAND}}"
    fi
elif [[ -n "${ZSH_VERSION:-}" ]]; then
    autoload -Uz add-zsh-hook
    typeset -g __bayisland_zsh_cmd=""
    typeset -g __bayisland_zsh_start=0
    typeset -g __bayisland_zsh_task_id=""

    __bayisland_zsh_preexec() {
        __bayisland_zsh_cmd="$1"
        __bayisland_zsh_start="${SECONDS}"
        if ! __bayisland_should_skip "${__bayisland_zsh_cmd}"; then
            __bayisland_zsh_task_id="task_${$}_${SECONDS}"
            __bayisland_emit_task_started "${__bayisland_zsh_task_id}" "${__bayisland_zsh_cmd}" "${SECONDS}"
        fi
    }

    __bayisland_zsh_precmd() {
        local exit_code=$?
        if [[ -n "${__bayisland_zsh_cmd}" ]]; then
            local dur=$(( SECONDS - __bayisland_zsh_start ))
            local cmd="${__bayisland_zsh_cmd}"
            local task_id="${__bayisland_zsh_task_id}"
            __bayisland_zsh_cmd=""
            __bayisland_zsh_task_id=""
            if [[ -n "${task_id}" ]]; then
                local ok="true"
                (( exit_code != 0 )) && ok="false"
                __bayisland_emit_task_finished "${task_id}" "${ok}" "${exit_code}" "${dur}"
            fi
        fi
    }

    add-zsh-hook preexec __bayisland_zsh_preexec
    add-zsh-hook precmd __bayisland_zsh_precmd
fi
