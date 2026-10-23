#!/bin/sh
# Render the full page behind every DJS question that carries a figure, for crop-figures.mjs.
# Sets A-C print one question per page after a contents page (question n on page n+1);
# the original Set A and Custom α pack several to a page, so their pages are listed by hand.
cd "$(dirname "$0")/../.." || exit 1
FIG=tutor_data/exams/figures
for f in tutor_data/exams/questions/djs_*.json; do
  python3 -I -c "
import json,sys
d=json.load(open(sys.argv[1]))
for q in d['questions']:
    if q.get('figure'): print(q['figure']['file'], q['qnum'], d['pdf'])
" "$f"
done | while read -r file qnum pdf_rest; do
  pdf=$(python3 -I -c "import json,sys;print(json.load(open(sys.argv[1]))['pdf'])" "tutor_data/exams/questions/$(echo "$file" | sed 's/_q[0-9]*\.png$//').json")
  page=$(python3 -I -c "import json,sys;d=json.load(open(sys.argv[1]));print(next(q['pdf_page'] for q in d['questions'] if q['qnum']==int(sys.argv[2])) or int(sys.argv[2])+1)" "tutor_data/exams/questions/$(echo "$file" | sed 's/_q[0-9]*\.png$//').json" "$qnum")
  [ -f "$FIG/$file" ] && continue
  pdftoppm -f "$page" -l "$page" -r 200 -png -singlefile "$pdf" "$FIG/${file%.png}"
  echo "rendered $file (page $page)"
done
