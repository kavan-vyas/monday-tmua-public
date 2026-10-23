#!/bin/zsh
# Render a narrated video end to end: every scene at 1080p30, then one mp4 with even loudness.
#
#   app/video/render.sh <video_dir> <narration_out_dir> <final.mp4> Scene1 Scene2 ...
#
# <narration_out_dir> holds audio/ + durations.json from narrate_qwen.py.
set -euo pipefail
video=${1:A}; out=${2:A}; final=$3; shift 3
export VIDEO_OUT=$out TOP10_OUT=$out
mkdir -p $out/hq $out/logs
cd $video
for S in "$@"; do
  (manim -r 1920,1080 --fps 30 --media_dir $out/hq/$S --disable_caching scenes.py $S \
     > $out/logs/hq_$S.log 2>&1 || echo "FAILED $S" >> $out/logs/failed.txt) &
  while (( $(jobs -r | wc -l) >= 3 )); do sleep 1; done
done
wait
[[ -f $out/logs/failed.txt ]] && { cat $out/logs/failed.txt; exit 1; }
: > $out/concat.txt
for S in "$@"; do
  echo "file '$(ls $out/hq/$S/videos/scenes/*/$S.mp4)'" >> $out/concat.txt
done
ffmpeg -v error -y -f concat -safe 0 -i $out/concat.txt -c:v copy \
  -af "loudnorm=I=-16:TP=-1.5:LRA=11" -c:a aac -b:a 192k -ar 48000 -movflags +faststart "$final"
ffprobe -v error -show_entries format=duration -of csv=p=0 "$final"
