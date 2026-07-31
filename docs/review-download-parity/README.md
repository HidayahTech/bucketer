# Download capability across browsers

An investigation into what each browser can actually do when downloading large files, and
what it costs. The deliverable is a PDF built with doclab; there is no markdown copy, so
there is nothing that can drift out of agreement with it.

## Building the report

Run from the repository root — doclab mounts the current directory and writes only there.

```bash
doclab build docs/review-download-parity/doc/report.yaml
doclab preview output/Bucketer_Browser_Download_Capability.pdf   # then LOOK at the pages
doclab verify  output/Bucketer_Browser_Download_Capability.pdf
```

`output/` and `assets/` are generated and git-ignored. To re-render the flow diagram after
editing `doc/diagrams/01-tiers.mmd`:

```bash
doclab diagrams docs/review-download-parity/doc/diagrams
```

## Re-running the measurements

`probe/` holds the experiment behind every measured figure in the report. All three engines
run in one container so no engine is special-cased, and WebKit cannot launch on a stock
Fedora host regardless.

```bash
podman run --rm --ipc=host -v "$PWD":/work:Z \
  -w /work/docs/review-download-parity/probe \
  -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
  -e SIZES='[64,256,1024,2048]' -e MECHS='opfs-dl,blob-dl' \
  -e ENGINES=chromium,firefox -e REPS=3 -e OUT_JSON=./results-download.json \
  mcr.microsoft.com/playwright:v1.60.0-noble node run.mjs

node docs/review-download-parity/probe/analyze.mjs   # stats + regenerates the charts
```

| File | Purpose |
|---|---|
| `probe/probe.html` | Single-shot page: one mechanism, one size, one browser launch. |
| `probe/run.mjs` | Matrix runner. Fresh browser per measurement, repeated, with a control. |
| `probe/analyze.mjs` | Median and spread across repetitions; writes the charts. |
| `probe/chart.mjs` | Dependency-free SVG line and bar charts. See below. |
| `probe/mobile-probe.html` | Serve over HTTPS and open on a phone; reports what only a device can answer. |
| `probe/results-download.json` | The headline data: real download path, 3 reps, 4 sizes. |
| `probe/results-trials.json` | Supporting sweep. Source of the noise floor and capability presence. |

### Method, in one paragraph

One fresh browser per measurement, so nothing inherits memory from a previous operation.
Three repetitions per cell, reported as median with range. A control that allocates nothing,
establishing the noise floor (Chromium 1 MiB, Firefox 8 MiB) below which no result means
anything. Memory sampled from outside the browser across the whole process tree. Profiles on
real disk, never tmpfs — where they land by default, and where "disk" writes silently become
memory writes. The report's errata section records the faults found along the way; the most
important is that reading a file back through page code measures something quite different
from letting the browser download it.

## `chart.mjs` — worth lifting into doclab

Doclab renders diagrams through Mermaid, whose default node labels are `foreignObject`
elements that WeasyPrint does not render at all, and whose chart support is thin. `chart.mjs`
emits plain SVG with real `<text>` nodes, which sidesteps both problems and gives exact
control over type size.

The rule it encodes: effective printed type size equals font size times printed width divided
by SVG width. At doclab's 6.7in content width a 880px chart scales by about 0.76, so 14px
type prints near 10pt — above the 9pt floor the legibility gate enforces. Keep charts at or
under 880px wide with type at 14px or larger and the gate is satisfied by construction.

Exports `lineChart({ series, xTicks, xLabel, yLabel, xScale, title })` and
`barChart({ groups, series, yLabel, title })`. No dependencies.
