#!/usr/bin/env python3
"""Generate test/sample.pdf (a short primer on memory and spaced repetition, written for this file) via PostScript +
Ghostscript (gs). Run it in this folder: python3 make_sample_pdf.py"""
import subprocess, textwrap, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
PS = os.path.join(HERE, "sample.ps")
PDF = os.path.join(HERE, "sample.pdf")

# The text below was written for this file. It copies no book, so the sample PDF can be given to anyone.
SECTIONS = [
 ("1  How Memory Fades", [
  "Most of what a person reads is gone within a few weeks. The loss is fastest at the start: a large part of a new fact fades in the first days, and the rest fades more slowly after that. Hermann Ebbinghaus measured this in the 1880s. He learned lists of made-up syllables and tested himself after set delays. The curve that he drew from his results is now called the forgetting curve.",
  "Forgetting is not a fault of the reader. Memory keeps what it meets again and lets go of what it meets once. A book is read once, from front to back, so most of its details get exactly one chance. Reading the whole book a second time would give them another chance, but it costs as much time as the first reading, and most of that time goes to pages the reader still knows.",
  "A better plan is to pick the few ideas that matter and to meet only those again, each one shortly before it would be lost. The rest of this primer explains how to do that: what to practise, when to practise it, and how to write the questions.",
 ]),
 ("1.1  Recalling Beats Rereading", [
  "There are two ways to meet an idea again. One is to read it again. The other is to try to say it from memory and then to check. The second way feels harder, and it works better. In experiments, students who tested themselves remembered more a week later than students who spent the same time reading the text again. This result is known as the testing effect.",
  "The effort is the point. Pulling an answer out of memory changes the memory itself and makes the next recall easier. Reading the answer again gives a feeling of knowing, because the words look familiar. That feeling says little about what the reader can produce without the page.",
  "This is why a memory system asks questions and does not just show notes. A question hides the answer, the reader tries to recall it, and only then does the answer appear. A wrong answer is useful too: it shows which idea needs another look while the book is still within reach.",
 ]),
 ("1.2  Spacing the Practice", [
  "When to practise matters as much as how. Ten recalls in one evening do less for long-term memory than the same ten recalls spread over several months. Practice that is spread out in time is called spaced practice. Its advantage over crammed practice is one of the findings that the study of learning has repeated most often.",
  "The useful moment for a recall is when the idea has started to fade but can still be found. Too early, and the recall is easy and adds little. Too late, and the idea is gone and must be learned again. After each good recall the idea lasts longer, so the next gap can be longer than the last one.",
  "A simple schedule follows from this. Ask a new question soon after you write it. When the answer is right, wait a few days before you ask again, and then about twice as long each time: two weeks, a month, two months, and so on. When an answer is wrong, come back to it soon and let the gap grow again from there. A few seconds per question, a few times a year, are then enough to keep it.",
 ]),
 ("2  Spaced Repetition and Prompts", [
  "A spaced repetition memory system schedules each prompt at growing intervals. If you remember a prompt, the interval roughly doubles; if you forget it, the interval shrinks and the prompt returns sooner. Over time the schedule concentrates effort on the prompts you find hardest, and the knowledge becomes durable at a cost of a few seconds per prompt, a few times a year.",
  "Andy Matuschak, in his guide How to write good prompts, names five properties of a good prompt: it is focused, precise, consistent, tractable and effortful. A focused prompt asks about one detail. A precise prompt leaves no doubt about what answer is wanted. A consistent prompt produces the same answer each time. A tractable prompt can usually be answered correctly. An effortful prompt cannot be answered without actually retrieving the information from memory.",
  "Writing prompts in the margin while reading keeps the context switch light. The reader finishes a passage, notices something worth remembering, and writes the question next to the passage. Later, during review, the prompt can take the reader straight back to the paragraph it came from.",
 ]),
 ("2.1  Cloze Deletions", [
  "A cloze deletion hides part of a sentence and asks the reader to supply it. For example: water boils at a lower temperature on a high mountain than at sea level. Hiding the words 'a lower temperature' turns the sentence into a prompt. Several deletions in one sentence produce several prompts, one per hidden span.",
  "Cloze prompts are quick to write but easy to write badly. Hide a phrase that carries the idea, not a filler word. Keep enough of the surrounding sentence visible that the prompt has a single sensible answer. If a sentence needs two deletions to make sense, consider writing a question and answer instead.",
  "This sample document exists so that the Marginalia reader can be tested without any real textbook. Every page contains ordinary selectable text, section headings, and a page number in the footer, which is enough to exercise highlighting, margin cards, review, and export.",
 ]),
]

def esc(s):
    return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")

lines = []  # (kind, text) kind in {"h","p","blank"}
for title, paras in SECTIONS:
    lines.append(("h", title))
    for p in paras:
        for ln in textwrap.wrap(p, 86):
            lines.append(("p", ln))
        lines.append(("blank", ""))
    lines.append(("blank", ""))

PAGE_W, PAGE_H = 612, 792
LEFT, TOP, BOTTOM = 72, 720, 80
LEAD = 15
pages = []
cur, y = [], TOP
for kind, text in lines:
    need = 28 if kind == "h" else LEAD
    if y - need < BOTTOM:
        pages.append(cur); cur, y = [], TOP
    if kind == "h":
        y -= 10
        cur.append(("h", text, y)); y -= 20
    elif kind == "p":
        cur.append(("p", text, y)); y -= LEAD
    else:
        y -= 8
pages.append(cur)
# pad to at least 8 pages by repeating content
n0 = len(pages)
while len(pages) < 8:
    pages.append(pages[len(pages) % n0])

out = ["%!PS-Adobe-3.0", "%%Pages: %d" % len(pages), "%%EndComments"]
for i, page in enumerate(pages, 1):
    out.append("%%%%Page: %d %d" % (i, i))
    out.append("/Times-Roman findfont 11 scalefont setfont")
    for kind, text, yy in page:
        if kind == "h":
            out.append("/Times-Bold findfont 14 scalefont setfont")
            out.append("%d %d moveto (%s) show" % (LEFT, yy, esc(text)))
            out.append("/Times-Roman findfont 11 scalefont setfont")
        else:
            out.append("%d %d moveto (%s) show" % (LEFT, yy, esc(text)))
    out.append("/Helvetica findfont 9 scalefont setfont")
    out.append("%d 50 moveto (Marginalia sample document  -  page %d of %d) show" % (LEFT, i, len(pages)))
    out.append("showpage")
out.append("%%EOF")
open(PS, "w").write("\n".join(out))
subprocess.run(["gs", "-q", "-dBATCH", "-dNOPAUSE", "-sDEVICE=pdfwrite", "-dPDFSETTINGS=/prepress",
                "-sOutputFile=" + PDF, PS], check=True)
os.remove(PS)
print("wrote", PDF, os.path.getsize(PDF), "bytes,", len(pages), "pages")
