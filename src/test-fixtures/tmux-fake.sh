#!/bin/sh
# Fake tmux for tests. State lives at $WORK_TMUX_STATE_DIR.
# Implements just enough of tmux for processes.ts.

set -e

DIR="${WORK_TMUX_STATE_DIR:?WORK_TMUX_STATE_DIR not set}"
mkdir -p "$DIR/sessions"

# Append the call to a log for assertions.
printf '%s\n' "$*" >> "$DIR/calls.log"

CMD="$1"
shift

case "$CMD" in
  has-session)
    [ "$1" = "-t" ] || exit 2
    [ -d "$DIR/sessions/$2" ]
    ;;

  new-session)
    SNAME=""
    WNAME=""
    while [ $# -gt 0 ]; do
      case "$1" in
        -s) SNAME="$2"; shift 2 ;;
        -n) WNAME="$2"; shift 2 ;;
        -c|-t) shift 2 ;;
        -d) shift ;;
        *)  shift ;;
      esac
    done
    [ -n "$SNAME" ] && [ -n "$WNAME" ] || exit 2
    mkdir -p "$DIR/sessions/$SNAME/windows"
    : > "$DIR/sessions/$SNAME/windows/$WNAME"
    ;;

  new-window)
    SNAME=""
    WNAME=""
    while [ $# -gt 0 ]; do
      case "$1" in
        -t) SNAME="${2%:}"; shift 2 ;;
        -n) WNAME="$2"; shift 2 ;;
        -c) shift 2 ;;
        -d) shift ;;
        *)  shift ;;
      esac
    done
    [ -d "$DIR/sessions/$SNAME/windows" ] || exit 1
    [ -n "$WNAME" ] || exit 2
    : > "$DIR/sessions/$SNAME/windows/$WNAME"
    ;;

  kill-window)
    [ "$1" = "-t" ] || exit 2
    TARGET="$2"
    SNAME="${TARGET%%:*}"
    WNAME="${TARGET##*:}"
    rm -f "$DIR/sessions/$SNAME/windows/$WNAME"
    if [ -d "$DIR/sessions/$SNAME/windows" ] && [ -z "$(ls -A "$DIR/sessions/$SNAME/windows")" ]; then
      rm -rf "$DIR/sessions/$SNAME"
    fi
    ;;

  list-windows)
    SNAME=""
    while [ $# -gt 0 ]; do
      case "$1" in
        -t) SNAME="$2"; shift 2 ;;
        -F) shift 2 ;;
        *)  shift ;;
      esac
    done
    [ -d "$DIR/sessions/$SNAME/windows" ] || exit 1
    # Each filename becomes a "#W" output line.
    ls "$DIR/sessions/$SNAME/windows"
    ;;

  pipe-pane|select-window)
    # Recorded in calls.log; nothing else to do.
    ;;

  *)
    exit 2
    ;;
esac
