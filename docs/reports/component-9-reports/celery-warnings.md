# Celery warnings

On re-upload during Step 9 from `component-9-corpus-population-and-hardening.md` (see also `step-9-reingestion-runbook.md`), I get this in the console from one of the movements:

```console
[2026-06-16 12:16:36,615: INFO/MainProcess] Task ingest_analysis[51ceff75-8034-4fb5-bb9d-e18ea31f028e] received
[2026-06-16 12:16:37,107: INFO/MainProcess] Task ingest_analysis[51ceff75-8034-4fb5-bb9d-e18ea31f028e] succeeded in 0.48499999986961484s: None
[2026-06-16 12:16:37,109: INFO/MainProcess] Task generate_incipit[8169d212-e523-49f5-841a-d93e1b68a4c0] received
[Warning] MEI version found or not known, falling back to MEI 6.0-dev
[Warning] slur 'm1dux3ti' is not encoded in the measure of its start 'js0wptk'. This may cause improper rendering.
[Warning] tie 'n1f4yq1j' is not encoded in the measure of its start 'kyqq6oi'. This may cause improper rendering.
[Warning] tie 'q1935b6l' is not encoded in the measure of its start 'oeurj4k'. This may cause improper rendering.
[Warning] slur 'f1yq2lby' is not encoded in the measure of its start 'c1lnt885'. This may cause improper rendering.
[Warning] slur 'jhecc9y' is not encoded in the measure of its start 'g16anboc'. This may cause improper rendering.
[Warning] slur 'i1jdxg67' is not encoded in the measure of its start 'f1wa7127'. This may cause improper rendering.
[Warning] slur 'nr7dvkb' is not encoded in the measure of its start 'l730ku7'. This may cause improper rendering.
[Warning] slur 'g2smwet' is not encoded in the measure of its start 'e1lims27'. This may cause improper rendering.
[Warning] slur 'k1yoqoxy' is not encoded in the measure of its start 'h16nyepk'. This may cause improper rendering.
[Warning] slur 'm1umhmyc' is not encoded in the measure of its start 'jznq98s'. This may cause improper rendering.
[Warning] slur 'ixzayzj' is not encoded in the measure of its start 'flcnxuq'. This may cause improper rendering.
[Warning] slur 'gv6wnxf' is not encoded in the measure of its start 'e1a5qgyi'. This may cause improper rendering.
[Warning] slur 'f1wy1ltc' is not encoded in the measure of its start 'c1rwkxbz'. This may cause improper rendering.
[Warning] slur 'n8f1w2r' is not encoded in the measure of its start 'k1iz45x'. This may cause improper rendering.
[Warning] slur 'qn0c5x0' is not encoded in the measure of its start 'o1i6jgti'. This may cause improper rendering.
[Warning] slur 't1gus790' is not encoded in the measure of its start 'qbeus7j'. This may cause improper rendering.
[Warning] slur 'r5stuii' is not encoded in the measure of its start 'pzvvjiq'. This may cause improper rendering.
[Warning] slur 'yrssl8m' is not encoded in the measure of its start 'w1xcf74u'. This may cause improper rendering.
[Warning] slur 'flqegfh' is not encoded in the measure of its start 'd13h9ix3'. This may cause improper rendering.
[Warning] slur 'y88gcb0' is not encoded in the measure of its start 'vde3zgw'. This may cause improper rendering.
[Warning] slur 'gd5ig1v' is not encoded in the measure of its start 'ef07e22'. This may cause improper rendering.
[Warning] slur 'yzezptr' is not encoded in the measure of its start 'wa9x9up'. This may cause improper rendering.
[Warning] slur 'h4dipwn' is not encoded in the measure of its start 'f1nsqeip'. This may cause improper rendering.
[Warning] slur 'd1h3miqo' is not encoded in the measure of its start 'b148epr0'. This may cause improper rendering.
[Warning] slur 'qbjgpuz' is not encoded in the measure of its start 'oacdwno'. This may cause improper rendering.
[Warning] slur 'repsj1q' is not encoded in the measure of its start 'oacdwno'. This may cause improper rendering.
[Warning] slur 'x1jwiy1h' is not encoded in the measure of its start 'v9d8fky'. This may cause improper rendering.
[Warning] slur 'e1apgk5w' is not encoded in the measure of its start 'b1tke2j4'. This may cause improper rendering.
[Warning] slur 'f64qxkb' is not encoded in the measure of its start 'd3u960k'. This may cause improper rendering.
[Warning] slur 'cxlau25' is not encoded in the measure of its start 'z1exexwo'. This may cause improper rendering.
[Warning] slur 'adumsz2' is not encoded in the measure of its start 'y1ro3fpr'. This may cause improper rendering.
[Warning] slur 'w2e5zol' is not encoded in the measure of its start 'ujrwnhd'. This may cause improper rendering.
[Warning] slur 'q1d4w8dc' is not encoded in the measure of its start 'o43rymg'. This may cause improper rendering.
[Warning] slur 'mtzqb7o' is not encoded in the measure of its start 'kwecs9d'. This may cause improper rendering.
[Warning] slur 'z1hqm16e' is not encoded in the measure of its start 'wgeryzv'. This may cause improper rendering.
[Warning] slur 'u1k6xdlr' is not encoded in the measure of its start 'r1qrd21e'. This may cause improper rendering.
[Warning] tie 'a1qn333d' is not encoded in the measure of its start 'xpg6eyi'. This may cause improper rendering.
[Warning] tie 'd9pyyy7' is not encoded in the measure of its start 'bik2bj1'. This may cause improper rendering.
[Warning] slur 'zdfqymk' is not encoded in the measure of its start 'x8jfg8x'. This may cause improper rendering.
[Warning] slur 'y186hzox' is not encoded in the measure of its start 'v152lftr'. This may cause improper rendering.
[Warning] slur 'z14auy99' is not encoded in the measure of its start 'x6imuzx'. This may cause improper rendering.
[Warning] slur 'l1vr4l0s' is not encoded in the measure of its start 'j18n9gkq'. This may cause improper rendering.
[Warning] slur 'rcbvgfj' is not encoded in the measure of its start 'p14v54ih'. This may cause improper rendering.
[Warning] slur 'b65tcqs' is not encoded in the measure of its start 'zlq3on5'. This may cause improper rendering.
[Warning] slur 'r1tovqf7' is not encoded in the measure of its start 'p1tem0g7'. This may cause improper rendering.
[Warning] slur 'x1r45wl3' is not encoded in the measure of its start 'v1401lcb'. This may cause improper rendering.
[Warning] slur 'jxdi4wk' is not encoded in the measure of its start 'hglcetb'. This may cause improper rendering.
[Warning] slur 'm1ypknsb' is not encoded in the measure of its start 'k1k88vyz'. This may cause improper rendering.
[Warning] slur 'b1sxuo4f' is not encoded in the measure of its start 'z7f24f4'. This may cause improper rendering.
[Warning] slur 'n1e510c9' is not encoded in the measure of its start 'l16tinkx'. This may cause improper rendering.
[Warning] slur 'rf2fnft' is not encoded in the measure of its start 'p1tg70ve'. This may cause improper rendering.
[Warning] slur 'iy14vca' is not encoded in the measure of its start 'g1a10egh'. This may cause improper rendering.
[Warning] slur 's1js1zpk' is not encoded in the measure of its start 'q4se4h1'. This may cause improper rendering.
[Warning] slur 'c3rjkzu' is not encoded in the measure of its start 'a7v040b'. This may cause improper rendering.
[Warning] slur 'p1u67082' is not encoded in the measure of its start 'nxeghvt'. This may cause improper rendering.
[Warning] slur 'df5y2nw' is not encoded in the measure of its start 'a1mwld3e'. This may cause improper rendering.
[Warning] slur 'y1br4m8n' is not encoded in the measure of its start 'vigwpt6'. This may cause improper rendering.
[Warning] tie 'e17l6rel' is not encoded in the measure of its start 'b1kukl2s'. This may cause improper rendering.
[Warning] tie 'hpw027f' is not encoded in the measure of its start 'f1ttdkd0'. This may cause improper rendering.
[Warning] slur 'w18j821b' is not encoded in the measure of its start 'u61ierg'. This may cause improper rendering.
[Warning] slur 'qabh3k3' is not encoded in the measure of its start 'n1w7yszt'. This may cause improper rendering.
[Warning] slur 'z1gbw6ql' is not encoded in the measure of its start 'w1tm4mt5'. This may cause improper rendering.
[Warning] slur 'a1y1ttol' is not encoded in the measure of its start 'y14srmx3'. This may cause improper rendering.
[Warning] slur 'x9ktvl' is not encoded in the measure of its start 'u1gh24jm'. This may cause improper rendering.
[Warning] slur 'vxtfeiv' is not encoded in the measure of its start 't1vsuks4'. This may cause improper rendering.
[Warning] slur 'u8ahk2g' is not encoded in the measure of its start 'r6jr6k1'. This may cause improper rendering.
[Warning] slur 'roeq0br' is not encoded in the measure of its start 'o1ekt22w'. This may cause improper rendering.
[Warning] slur 'n1lme5ix' is not encoded in the measure of its start 'k1bzpt6v'. This may cause improper rendering.
[Warning] slur 'wfhqmj3' is not encoded in the measure of its start 't1fsbl8j'. This may cause improper rendering.
[Warning] slur 'z11bz1dz' is not encoded in the measure of its start 'x1tmqda6'. This may cause improper rendering.
[Warning] slur 'w1qz3bec' is not encoded in the measure of its start 'tzaccpo'. This may cause improper rendering.
[Warning] slur 'u9gnabu' is not encoded in the measure of its start 's1jh9rpg'. This may cause improper rendering.
[Warning] slur 'bj7a4n0' is not encoded in the measure of its start 'z13btia'. This may cause improper rendering.
[Warning] slur 'g32z7rp' is not encoded in the measure of its start 'e1sl79qg'. This may cause improper rendering.
[Warning] slur 'z145w1d2' is not encoded in the measure of its start 'wj4tjw2'. This may cause improper rendering.
[Warning] slur 'hq3gyn6' is not encoded in the measure of its start 'f1kiark1'. This may cause improper rendering.
[Warning] slur 'z1onhv1s' is not encoded in the measure of its start 'x503nom'. This may cause improper rendering.
[Warning] slur 'i1drmkbc' is not encoded in the measure of its start 'g1pfijha'. This may cause improper rendering.
[Warning] slur 'd177vhr5' is not encoded in the measure of its start 'bwfxqc7'. This may cause improper rendering.
[Warning] slur 'r1wzm9xv' is not encoded in the measure of its start 'p1lzv4ct'. This may cause improper rendering.
[Warning] slur 's1vv6a0s' is not encoded in the measure of its start 'p1lzv4ct'. This may cause improper rendering.
[Warning] slur 'm1jwrk0b' is not encoded in the measure of its start 'k1nk77ow'. This may cause improper rendering.
[Warning] slur 'bacs7he' is not encoded in the measure of its start 'z47gbwg'. This may cause improper rendering.
[Warning] slur 'i1wsnnav' is not encoded in the measure of its start 'f10mz268'. This may cause improper rendering.
[Warning] slur 'oisn1e4' is not encoded in the measure of its start 'm1yuwugp'. This may cause improper rendering.
[2026-06-16 12:16:37,931: INFO/MainProcess] generate_incipit: stored mozart/piano-sonatas/k331/movement-2/incipit.svg for movement 82ad5390-9d7d-4b48-b339-2bf1fd9ac583
[2026-06-16 12:16:37,940: INFO/MainProcess] Task generate_incipit[8169d212-e523-49f5-841a-d93e1b68a4c0] succeeded in 0.8279999999795109s: None
```
