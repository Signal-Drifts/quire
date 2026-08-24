# Quire

Every conversion, on your laptop. No uploads, no page limits, no watermark.

## Why this exists

People paste tax returns, signed contracts, medical letters, and passports into free PDF websites every day, because they need a Word file turned into a PDF and that is where the search results point. The file is uploaded, converted on a server, and held there for some number of hours according to a privacy policy nobody reads.

None of that is necessary. Every one of these conversions runs perfectly well on the machine already in front of you. The tools that do the work — Pandoc, LibreOffice, Ghostscript — are free, and older and better tested than any of the websites wrapping them.

Quire is a plain interface over those tools, running locally, with nothing to sign up for.

## What it does

- Word, ODT, RTF, Markdown, HTML, and plain text — converted between each other
- Any of those to PDF, and PDF back out to text or Markdown
- Merge, split, rotate, and compress PDFs
- Batch mode — a folder of documents in one pass
- Scanned PDFs get an OCR pass so the text is selectable and searchable

## What it avoids

| The free PDF sites | Quire |
|---|---|
| Your contract is uploaded to a stranger's server | Nothing leaves the disk |
| 2 free tasks per hour, then wait or pay | No caps, no clock |
| 15 MB file limit | Whatever your disk holds |
| Watermark on the free tier | No watermark |
| Requires an account and an email address | No account |
| Needs an internet connection | Works on a plane |

## How to use

> Pre-release. There is no installer to download yet. This is the intended flow.

1. Drag documents onto the window.
2. Pick what you want out — a format, or an operation like merge or compress.
3. Choose where the results go.
4. Press Convert.

Originals are never modified or deleted.

## Tech stack

**Shell**
- [Tauri v2](https://tauri.app) — desktop shell, IPC bridge, installer bundler.
- Frontend is Vite + TypeScript, no framework.

**Backend**
- [Rust](https://www.rust-lang.org) — orchestrates the conversion tools, manages the queue, and owns every path the user's files travel along.
- [Pandoc](https://pandoc.org) — the document format graph. Handles docx, odt, rtf, markdown, html, latex, and plain text in every direction, through a single internal document model rather than a web of one-off converters.
- [LibreOffice](https://www.libreoffice.org) in headless mode — used for the Office formats Pandoc renders imperfectly, and for anything to PDF where layout fidelity matters more than structure.
- [Ghostscript](https://www.ghostscript.com) — PDF compression, merging, splitting, rotation, and page-range extraction. The same engine sitting behind most of the paid PDF sites.
- [`pdfium`](https://pdfium.googlesource.com/pdfium/) — text extraction and page rendering for previews.
- [`qpdf`](https://qpdf.sourceforge.io) — linearization, encryption removal on files you own, and structural repair of malformed PDFs.
- [Tesseract](https://github.com/tesseract-ocr/tesseract) — OCR for scanned pages that carry no text layer.
- [`tokio`](https://tokio.rs) — the task runtime. Unlike image conversion, this work is mostly waiting on external processes, so an async runtime fits better than a thread pool.
- `serde` — typed messages across the Rust/TypeScript boundary.

**How a conversion actually runs**

Rust picks a route through the tools based on the input and requested output — a `.docx` to `.pdf` goes through LibreOffice, a `.docx` to `.md` goes through Pandoc, a compress goes straight to Ghostscript. Each step runs as a child process in a scratch directory that is wiped when the job ends. Nothing is passed over a network socket and no temporary file is written outside that directory. Per-file progress and errors come back to the webview as Tauri events, so one failed document does not take the batch with it.

**Distribution**
- `tauri build` produces a signed `.dmg`, `.msi`, and `.AppImage`, with the required binaries bundled so there is no separate install step.
- macOS builds are notarized.
- Homebrew tap for `brew install --cask quire`.

## License

MIT.
