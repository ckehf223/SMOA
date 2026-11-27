#!/bin/bash -p
set -euo pipefail

# SSH CI input is a single header line followed by the exact JAR bytes.
# This program is installed and owned by root. The CI account can only invoke it.
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
export LC_ALL=C
umask 077

app_dir=/opt/smoa
releases="$app_dir/releases"
current="$app_dir/current.jar"
backend=http://127.0.0.1:8080
max_size=134217728

fail() {
  printf 'smoa-deploy: %s\n' "$1" >&2
  exit 1
}

trusted_path() {
  local owner mode
  read -r owner mode < <(stat -c '%u %a' -- "$1")
  [[ "$owner" == 0 && "$mode" =~ ^[0-7]{3,4}$ ]] && (( (8#$mode & 0022) == 0 ))
}

active_release() {
  local release
  [[ -L "$current" && $(stat -c '%u' -- "$current") == 0 ]] || return 1
  release=$(readlink -- "$current") || return 1
  [[ "$release" == "$releases/"* && "${release#"$releases/"}" =~ ^[0-9a-f]{64}\.jar$ ]] || return 1
  [[ -f "$release" && ! -L "$release" ]] && trusted_path "$release" || return 1
  printf '%s\n' "$release"
}

request() {
  curl -q --noproxy '*' --silent --max-time 2 "$@"
}

otp_policy() {
  request --fail "$backend/api/auth/otp-policy"
}

healthy() {
  local expected_policy=$1
  [[ $(otp_policy) == "$expected_policy" ]] &&
    [[ $(request -o /dev/null -w '%{http_code}' "$backend/login.html") == 200 ]] &&
    [[ $(request -H 'Accept: text/html' -o /dev/null -w '%{http_code} %{redirect_url}' "$backend/index.html") == "302 $backend/login.html" ]] &&
    [[ $(request -o /dev/null -w '%{http_code}' "$backend/api/programs/people/page") == 401 ]]
}

wait_until_healthy() {
  local attempt
  for ((attempt = 0; attempt < 30; attempt++)); do
    healthy "$1" && return 0
    sleep 1
  done
  return 1
}

[[ "$EUID" == 0 && "$#" == 0 ]] || fail 'must run as root without arguments'
[[ -z "${SSH_ORIGINAL_COMMAND:-}" ]] || fail 'SSH remote commands are disabled'

IFS= read -r -t 10 -n 128 header || fail 'missing or timed-out request'
if [[ "$header" != probe && ! "$header" =~ ^deploy\ ([0-9a-f]{40})\ ([0-9a-f]{64})\ ([1-9][0-9]{0,8})$ ]]; then
  fail 'invalid request header'
fi

if [[ "$header" != probe ]]; then
  commit=${BASH_REMATCH[1]}
  checksum=${BASH_REMATCH[2]}
  content_size=${BASH_REMATCH[3]}
  ((content_size <= max_size)) || fail 'release exceeds size limit'
fi

for dir in "$app_dir" "$releases"; do
  [[ -d "$dir" && ! -L "$dir" ]] && trusted_path "$dir" || fail 'unexpected release directory'
done

if [[ "$header" == probe ]]; then
  active_release >/dev/null || fail 'unexpected current release'
  policy=$(otp_policy) || fail 'cannot read current OTP policy'
  [[ "$policy" =~ ^\{\"required\":(true|false)\}$ ]] && healthy "$policy" || fail 'current release did not pass health checks'
  printf 'smoa-deploy: ready\n'
  exit 0
fi

exec 9>>"$app_dir/.deployment.lock"
flock -w 10 9 || fail 'another deployment is in progress'
previous=$(active_release) || fail 'unexpected current release'
policy=$(otp_policy) || fail 'cannot read current OTP policy'
[[ "$policy" =~ ^\{\"required\":(true|false)\}$ ]] || fail 'invalid current OTP policy'

destination="$releases/$checksum.jar"
staged=
link_dir=
rollback_pending=false

switch_release() {
  link_dir=$(mktemp -d "$app_dir/.activate.XXXXXXXX") || return 1
  ln -s -- "$1" "$link_dir/current.jar" &&
    mv -Tf -- "$link_dir/current.jar" "$current" &&
    rmdir -- "$link_dir" || return 1
  link_dir=
}

restart_app() {
  timeout --kill-after=5s 35s systemctl restart smoa.service
}

cleanup() {
  local result=$?
  trap - EXIT
  if [[ -n "$link_dir" ]]; then
    rm -f -- "$link_dir/current.jar"
    rmdir -- "$link_dir" || true
  fi
  if "$rollback_pending" && [[ $(readlink -- "$current") == "$destination" ]]; then
    if switch_release "$previous" && restart_app && wait_until_healthy "$policy"; then
      printf 'smoa-deploy: restored previous release\n' >&2
    else
      printf 'smoa-deploy: rollback failed, check smoa.service\n' >&2
      result=1
    fi
  fi
  if [[ -n "$staged" ]]; then
    rm -f -- "$staged"
  fi
  exit "$result"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

staged=$(mktemp "$releases/.incoming.XXXXXXXX") || fail 'cannot stage release'
timeout --kill-after=5s 120s head -c "$((content_size + 1))" >"$staged" || fail 'release upload timed out or failed'
[[ $(stat -c '%s' -- "$staged") == "$content_size" ]] || fail 'release length does not match'
printf '%s  %s\n' "$checksum" "$staged" | sha256sum --check --status || fail 'release checksum does not match'

if [[ -e "$destination" || -L "$destination" ]]; then
  [[ -f "$destination" && ! -L "$destination" ]] && trusted_path "$destination" || fail 'unexpected release file'
  printf '%s  %s\n' "$checksum" "$destination" | sha256sum --check --status || fail 'existing release checksum does not match'
else
  chown root:root -- "$staged"
  chmod 0644 -- "$staged"
  mv -T -- "$staged" "$destination"
  staged=
fi

if [[ "$previous" == "$destination" ]]; then
  healthy "$policy" || fail 'current release did not pass health checks'
  printf 'smoa-deploy: already current %s\n' "$commit"
  exit 0
fi

rollback_pending=true
switch_release "$destination" && restart_app && wait_until_healthy "$policy" || fail 'new release did not pass health checks'
rollback_pending=false
printf 'smoa-deploy: deployed %s\n' "$commit"
