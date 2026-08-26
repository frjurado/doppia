# MEI & Verovio: Musical Scores as Structured Data

## What it is

**MEI** (Music Encoding Initiative) is an XML-based file format for representing musical scores — think of it as HTML, but for sheet music. **Verovio** is an open-source library that reads MEI files and converts them into SVG images (scalable vector graphics) of printed notation.

## What it does

Traditional music files (like PDFs or scanned images) are just pictures — you can't ask "which note is this?" or "where does this phrase start?". MEI solves that by encoding every note, rest, barline, and dynamic marking as a structured tag with a unique ID, so the score is also a queryable database.

Verovio bridges that structured data and what users actually see: it takes an MEI document and renders it as a pixel-perfect music engraving in the browser. Because each SVG element traces back to an MEI element ID, you can click on a note in the image and know exactly which note in the data you're talking about.

## How it works

Think of MEI as the source of truth (like a `.tsx` source file) and Verovio as the compiler that turns it into something visual (like a browser rendering HTML). The SVG output is treated as read-only — just like you wouldn't edit a compiled JavaScript bundle, you never touch Verovio's SVG output directly. Any visual overlays (selection highlights, playback cursors) are separate HTML elements layered on top.

## Example

A fragment in this project might cover measures 5–8 of a Mozart sonata. The MEI file encodes every note in those measures with IDs like `note-m5-b1-n1`. Verovio renders them as an engraving; the app then uses those same IDs to draw a selection bracket above the SVG — without modifying the SVG itself.
