#!/bin/bash
set -Eeuo pipefail
umask 077

export DISPLAY=:1
export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/openclaw-desktop/bus
export XAUTHORITY=/run/openclaw-desktop/Xauthority
node /app/deploy/prepare-runtime.mjs
unset DESKTOP_VNC_PASSWORD

bus_pid=
vnc_pid=
xfce_pid=
gateway_pid=

stop_process() {
    local pid="$1" budget="$2" name="$3"
    [[ -n "$pid" ]] || return 0
    if kill -0 "$pid" 2>/dev/null; then
        kill -TERM "$pid" 2>/dev/null || true
        local deadline=$((SECONDS + budget))
        while kill -0 "$pid" 2>/dev/null; do
            if ((SECONDS >= deadline)); then
                printf '%s did not stop in time; terminating it\n' "$name" >&2
                kill -KILL "$pid" 2>/dev/null || true
                break
            fi
            sleep 0.1
        done
    fi
    wait "$pid" 2>/dev/null || true
}

shutdown() {
    local status="$1"
    trap - EXIT TERM INT HUP
    stop_process "$gateway_pid" 330 gateway
    stop_process "$xfce_pid" 10 XFCE
    stop_process "$vnc_pid" 5 TigerVNC
    stop_process "$bus_pid" 5 D-Bus
    exit "$status"
}
trap 'shutdown 0' TERM INT HUP
trap 'shutdown $?' EXIT

dbus-daemon --session --nofork --nopidfile --address="$DBUS_SESSION_BUS_ADDRESS" &
bus_pid=$!
localhost=yes
case "${DESKTOP_VNC_BIND_ADDRESS:-127.0.0.1}" in
    127.*) ;;
    *) localhost=no ;;
esac
Xtigervnc :1 -geometry 1920x1080 -depth 24 -localhost "$localhost" -rfbport 5900 \
    -SecurityTypes VncAuth -PasswordFile /run/openclaw-desktop/vnc-password.hash \
    -AlwaysShared -AcceptSetDesktopSize -nolisten tcp -auth "$XAUTHORITY" &
vnc_pid=$!

deadline=$((SECONDS + 20))
until xdpyinfo -display "$DISPLAY" >/dev/null 2>&1 \
    && dbus-send --session --print-reply --dest=org.freedesktop.DBus / org.freedesktop.DBus.ListNames >/dev/null 2>&1; do
    if ! kill -0 "$bus_pid" 2>/dev/null || ! kill -0 "$vnc_pid" 2>/dev/null || ((SECONDS >= deadline)); then
        printf 'Desktop display or private D-Bus did not become ready\n' >&2
        exit 1
    fi
    sleep 0.1
done

/app/deploy/run-xfce.sh &
xfce_pid=$!
node /app/docker-entrypoint.mjs "$@" &
gateway_pid=$!

status=0
wait -n "$bus_pid" "$vnc_pid" "$xfce_pid" "$gateway_pid" || status=$?
printf 'A desktop-stack process exited unexpectedly (status %s)\n' "$status" >&2
((status != 0)) || status=1
exit "$status"
