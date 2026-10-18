"""Export reproducible natural-GC stability figures from completed soak reports."""
import argparse
import hashlib
import json
import math
from pathlib import Path
from statistics import median

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt


def load_report(path, kind):
    raw = path.read_bytes()
    report = json.loads(raw)
    assert report["success"] is True, "A completed successful report is required"
    assert report["activeMs"] >= report["requestedMinutes"] * 60000
    assert report["source"]["before"]["hash"] == report["source"]["afterHash"]
    if kind == "export":
        assert report["harness"]["before"]["hash"] == report["harness"]["afterHash"]
        assert report["semantics"]["first"] == report["semantics"]["last"]
        assert report["semantics"]["rows"] == report["snapshot"]["rows"]
    else:
        assert report["counts"]["requests"] == report["cycles"] * 8 + 1
    state = "settled" if kind == "export" else "running"
    samples = [row for row in report["raw"] if row["state"] == state]
    assert samples and all(math.isfinite(row["activeMs"]) for row in samples)
    assert all(a["activeMs"] <= b["activeMs"] for a, b in zip(samples, samples[1:]))
    burn_in = 5 if kind == "export" else 10
    bins = {}
    for row in samples:
        active_minute = row["activeMs"] / 60000
        if active_minute >= burn_in:
            index = int((active_minute - burn_in) // 5)
            bins.setdefault(index, []).append(row)
    windows = []
    for index, rows in sorted(bins.items()):
        start = burn_in + index * 5
        if (start + 5) * 60000 > report["activeMs"] or len(rows) < 3:
            continue
        windows.append({
            "startMinute": start, "endMinute": start + 5, "samples": len(rows),
            "heapLowerMiB": min(row["memory"]["heapUsed"] for row in rows) / 2**20,
            "rssLowerMiB": min(row["memory"]["rss"] for row in rows) / 2**20,
            "externalLowerMiB": min(row["memory"]["external"] for row in rows) / 2**20,
        })
    slopes = [(b["heapLowerMiB"] - a["heapLowerMiB"]) / (b["startMinute"] - a["startMinute"])
              for i, a in enumerate(windows) for b in windows[i + 1:]]
    endpoint_n = min(3, len(windows) // 2)
    early = median(w["heapLowerMiB"] for w in windows[:endpoint_n]) if endpoint_n else None
    late = median(w["heapLowerMiB"] for w in windows[-endpoint_n:]) if endpoint_n else None
    summary = {
        "input": path.as_posix(), "inputSha256": hashlib.sha256(raw).hexdigest(),
        "sampleState": state, "samples": len(samples), "burnInMinutes": burn_in,
        "activeMinutes": report["activeMs"] / 60000,
        "pausedMinutes": report["pausedMs"] / 60000,
        "wallMinutes": report["wallMs"] / 60000,
        "cycles": report["cycles"], "windows": windows,
        "heapLowerTheilSenMiBPerMinute": median(slopes) if slopes else None,
        "earlyLowerHeapMedianMiB": early, "lateLowerHeapMedianMiB": late,
        "endpointWindows": endpoint_n,
        "endpointDeltaMiB": late - early if endpoint_n else None,
        "sourceHash": report["source"]["before"]["hash"],
        "snapshot": report["snapshot"],
    }
    return report, samples, summary


parser = argparse.ArgumentParser()
parser.add_argument("--cache", type=Path, required=True)
parser.add_argument("--export", dest="export_path", type=Path, required=True)
parser.add_argument("--out", type=Path, required=True, help="Output prefix without extension")
args = parser.parse_args()
outputs = [args.out.with_suffix(suffix) for suffix in (".json", ".png", ".svg")]
assert not any(path.exists() for path in outputs), "Refusing to replace prior evidence"
cache = load_report(args.cache, "cache")
exports = load_report(args.export_path, "export")

plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 10,
                     "axes.spines.top": False, "axes.spines.right": False,
                     "axes.labelcolor": "#334155", "text.color": "#172033"})
fig, axes = plt.subplots(2, 2, figsize=(12, 7), sharex="col")
for column, (title, dataset, color) in enumerate([
    ("Published API / response cache", cache, "#147d92"),
    ("Repeated workbook export / 22,596 rows", exports, "#7255ad"),
]):
    report, samples, summary = dataset
    x = [row["activeMs"] / 60000 for row in samples]
    for row_index, (key, label, lower_key) in enumerate([
        ("rss", "Resident memory (MiB)", "rssLowerMiB"),
        ("heapUsed", "JavaScript heap used (MiB)", "heapLowerMiB"),
    ]):
        axis = axes[row_index, column]
        axis.plot(x, [row["memory"][key] / 2**20 for row in samples],
                  color=color, linewidth=1.1, alpha=.85, label="Observed sample")
        windows = summary["windows"]
        axis.plot([(w["startMinute"] + w["endMinute"]) / 2 for w in windows],
                  [w[lower_key] for w in windows], color="#b85b13", marker="o",
                  linewidth=1.7, markersize=4, label="5-min observed minimum")
        axis.set_ylabel(label)
        axis.set_ylim(bottom=0)
        axis.grid(axis="y", alpha=.18)
        axis.axvspan(0, summary["burnInMinutes"], color="#94a3b8", alpha=.10)
        if row_index == 0:
            axis.set_title(title, fontweight="bold", loc="left", pad=14)
            axis.legend(loc="upper left", frameon=False, fontsize=8)
        else:
            axis.set_xlabel("Active workload minutes (paused time excluded)")
    subtitle = (f'{summary["activeMinutes"]:.1f} active min | {summary["cycles"]:,} cycles'
                f' | {summary["pausedMinutes"]:.1f} min paused')
    axes[0, column].text(0, 1.015, subtitle, transform=axes[0, column].transAxes,
                         fontsize=8, color="#64748b")
fig.suptitle("Stability observations under natural garbage collection", fontsize=17,
             fontweight="bold", x=.06, ha="left", y=.995)
fig.text(.06, .015,
         "One candidate per workload; these are sampled observations, not peak or retained heap. "
         "Final parsing/integrity checks excluded.\n"
         "Lower envelopes do not establish leak freedom or improvement over baseline. "
         "Export series includes the first and latest output buffers.",
         fontsize=9, color="#475569")
fig.tight_layout(rect=(.015, .07, 1, .96), h_pad=2.1, w_pad=2.5)
args.out.parent.mkdir(parents=True, exist_ok=True)
fig.savefig(outputs[1], dpi=180, facecolor="white")
fig.savefig(outputs[2], facecolor="white")
report = {"scope": "Sampled natural-GC observations; no baseline improvement, leak-free, peak-memory or latency acceptance claim.",
          "cache": cache[2], "export": exports[2]}
outputs[0].write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"outputs": [path.as_posix() for path in outputs],
                  "cacheHeapDeltaMiB": cache[2]["endpointDeltaMiB"],
                  "exportHeapDeltaMiB": exports[2]["endpointDeltaMiB"]}))
