#!/bin/sh
# Start the colima VM that runs the prodex browser container, from a macOS
# login LaunchAgent (docs/container-browser.md, "Keep the Docker engine running").
#
# A macOS restart can leave a colima VM "Broken" ("vz driver is running but host
# agent is not"), and `colima start` then fails until `colima stop --force` has
# run, as the Colima FAQ prescribes. This checks the profile's state first:
#   Running  nothing to do;
#   Broken   force-stop it, then start it;
#   other    start it.
# A profile `colima list` does not show is left alone, since `colima start` would
# create a new, empty VM under that name. A failed start exits non-zero, so a
# KeepAlive agent (SuccessfulExit false) tries again after its ThrottleInterval.
#
# Usage: colima-start.sh PROFILE
set -u

say() { printf '%s colima-start: %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"; }

profile=${1:-}
case $profile in
  '' | -* | *[!A-Za-z0-9_.-]*) say "usage: colima-start.sh PROFILE (letters, digits, dot, underscore, hyphen)" >&2; exit 64 ;;
esac

# launchd starts agents with a short PATH; colima also needs limactl from Homebrew.
PATH=$PATH:/opt/homebrew/bin:/usr/local/bin
export PATH
if ! command -v colima >/dev/null 2>&1; then
  say "colima is not installed or not on PATH" >&2
  exit 127
fi

if ! listing=$(colima list 2>&1); then
  say "colima list failed: $listing" >&2
  exit 1
fi
state=$(printf '%s\n' "$listing" | awk -v profile="$profile" 'NR > 1 && $1 == profile { print $2; exit }')

case $state in
  '')
    say "no colima profile named $profile; nothing started" >&2
    exit 0
    ;;
  Running)
    say "$profile is already running"
    exit 0
    ;;
  Broken)
    say "$profile is Broken; running colima stop --force first"
    colima stop --force --profile "$profile" || say "colima stop --force exited $?; starting anyway" >&2
    ;;
esac

say "starting $profile (was $state)"
exec colima start --profile "$profile"
