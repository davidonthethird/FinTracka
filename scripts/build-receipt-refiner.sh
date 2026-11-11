#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
data_dir=${1:-"$HOME/Library/Application Support/FinTracka"}
cd "$repo_dir/native/receipt-refiner"
swift test
swift build -c release
.build/release/fintracka-receipt-refiner --self-test
scratch=$(mktemp -d)
trap 'find "$scratch" -depth -delete' EXIT HUP INT TERM
id=00000000-0000-4000-8000-000000000001
package="$scratch/$id"
mkdir -p "$package"
sips -s format heic "$repo_dir/frontend/public/receipt-fixtures/one-page.png" \
  --out "$package/page-001.heic" >/dev/null
: > "$package/ocr.txt"
: > "$package/on-device.txt"
: > "$package/private-cloud-compute.txt"
printf '%s\n' 'contract=receipt_queue_capture/v1' "handoff_id=$id" 'page_count=1' \
  'created_at=2026-11-11T12:00:00Z' 'on_device_status=unavailable' \
  'on_device_duration_ms=0' 'private_cloud_compute_status=unavailable' \
  'private_cloud_compute_duration_ms=0' > "$package/manifest.txt"
.build/release/fintracka-receipt-refiner --ocr-only "$package" | grep -q 'SYNTHETIC MARKET'
install -d -m 700 "$data_dir/tools"
install -m 700 ".build/release/fintracka-receipt-refiner" "$data_dir/tools/fintracka-receipt-refiner"
