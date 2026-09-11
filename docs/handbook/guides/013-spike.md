# Spikes: Timeboxed Experiments to Reduce Uncertainty

## What it is

A **spike** is a short, throwaway investigation you do when you're not sure how to build something — the goal is to learn enough to make a confident decision, not to ship production code.

## What it does

Sometimes a task has too many unknowns to estimate or design properly: "Can this library handle our use case?" or "Which of these two approaches is faster?". Rather than guessing and committing to the wrong path, you carve out a fixed block of time (the timebox) to prototype, read docs, or run experiments. At the end of the spike you have an answer — and usually throw the code away.

Spikes prevent the trap of over-engineering a solution before you understand the problem, and they prevent under-estimating a task because the difficult parts were never explored.

## How it works

Think of it like a chef tasting a new ingredient before designing a whole dish around it. You're not cooking the final meal — you're just figuring out what you're working with. The spike is the tasting; the real implementation comes after.

A spike is usually given a clear question ("Can Verovio re-render a single measure without re-rendering the full page?"), a timebox ("spend two hours on this, no more"), and an expected output ("a short write-up or a tiny proof-of-concept script").

## Example

Before building the Verovio tagging interface in this project, a spike might ask: "Can we overlay HTML elements on top of Verovio's SVG output and keep them aligned when the window resizes?" Two hours of hacking gives you a yes/no — then the real feature branch begins.
