#!/bin/bash
set -u
session_pid=

stop_session() {
    trap - TERM INT HUP
    if [[ -n "$session_pid" ]] && kill -0 "$session_pid" 2>/dev/null; then
        kill -TERM "$session_pid" 2>/dev/null || true
        wait "$session_pid" 2>/dev/null || true
    fi
    exit 0
}
trap stop_session TERM INT HUP

backoff=1
while true; do
    started=$SECONDS
    startxfce4 &
    session_pid=$!
    status=0
    wait "$session_pid" || status=$?
    session_pid=
    printf 'XFCE session ended (status %s); restarting on the same display\n' "$status" >&2
    if ((SECONDS - started >= 60)); then
        backoff=1
    fi
    sleep "$backoff" &
    session_pid=$!
    wait "$session_pid" || true
    session_pid=
    if ((backoff < 30)); then
        backoff=$((backoff * 2))
        ((backoff <= 30)) || backoff=30
    fi
done
