<p align="center"><img src="public/logo.png" width="112" alt="ZenPDF"></p>

# ZenPDF for Windows

A calm, distraction-free PDF reader and annotator for Windows. Open a folder, then read, mark up and cite your documents. The annotations are saved into the PDF itself, so other PDF viewers show them too.

There's also [ZenPDF for Mac](https://github.com/duck28/zenpdf-for-mac).

## Features

- **Calm reading:** zoom from 25 to 500 percent, fit the page or its width, and jump between page thumbnails. Hide the sidebar (`Ctrl+B`) and only the page is left.
- **Highlighter:** highlights blend into the page like ink, so the text underneath stays sharp. Hold still at the end of a stroke and it straightens out.
- **Pens:** ballpoint, fountain, marker, pencil or dashed, in any color and thickness.
- **Text, shapes and a ruler:** notes anywhere on the page, rectangles, ellipses, lines and arrows, and measurements in centimeters, millimeters or inches.
- **Citations with footnotes:** mark a passage and ZenPDF numbers it, captures its text and adds your note as a footnote. Copy the reference in APA, MLA, Chicago or BibTeX.
- **Annotations stay editable:** marks are saved as real PDF annotations. Open the file in ZenPDF again and you can move, change or erase every one. Undo and redo included.
- **Share a clean copy:** export a flattened PDF with the annotations merged into the pages, or save the current page as a PNG.
- **Your folder, at hand:** browse a folder's documents in the sidebar, with subfolders, file sizes and a filter. ZenPDF reopens the file and folder you last worked on.
- **Text and Markdown:** open `.txt` and `.md` files next to your PDFs and edit them in place, with an edit, split and preview view for Markdown.

ZenPDF works offline, has no account and doesn't upload your files anywhere.

## Download and install

Requires Windows 10 or 11 (64-bit) with the WebView2 runtime, which Windows 11 already has (the installer adds it on Windows 10 if needed).

Download one of these from the [latest release](https://github.com/duck28/zenpdf-for-windows/releases/latest):

- `ZenPDF_<version>_x64-setup.exe`: installer for your user account, no administrator rights needed (recommended).
- `ZenPDF_<version>_x64_en-US.msi`: Windows Installer package, for installing with administrator rights or deploying to several PCs.

### The installers are not code-signed

The installers aren't signed with a code-signing certificate, so Windows doesn't know who published them:

- Your browser may say the file *isn't commonly downloaded*. In Edge, choose **⋯ › Keep**, then **Show more › Keep anyway**.
- When you run it, Microsoft Defender SmartScreen shows **Windows protected your PC**. Click **More info**, then **Run anyway**.

### Verify a download

Every release file is attested by the GitHub Actions run that built it ([build provenance](https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations)). With the [GitHub CLI](https://cli.github.com):

```powershell
gh attestation verify ZenPDF_1.0.0_x64-setup.exe --repo duck28/zenpdf-for-windows
```

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+O` | Open a file |
| `Ctrl+S` / `Ctrl+Shift+S` | Save / Save as |
| `Ctrl+Z` / `Ctrl+Y` (or `Ctrl+Shift+Z`) | Undo / Redo |
| `Ctrl++` / `Ctrl+-` / `Ctrl+0` | Zoom in / out / 100% |
| `Ctrl+B` | Show or hide the sidebar |
| `V` or `1` | Select |
| `H` or `2` | Highlighter |
| `P` or `3` | Pen |
| `T` or `4` | Text |
| `R` or `5`, `O`, `L`, `A` | Rectangle, ellipse, line, arrow |
| `M` | Ruler |
| `C` | Cite |
| `E` or `6` | Eraser |

## Build from source

Built with [Tauri 2](https://tauri.app): a Rust backend (`src-tauri/`) and a React 19 + TypeScript + Vite interface (`src/`), with [PDF.js](https://mozilla.github.io/pdf.js/) for rendering and [pdf-lib](https://pdf-lib.js.org) for writing.

Requires Node.js 22+, Rust (`winget install Rustlang.Rustup`) and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) (Microsoft C++ Build Tools, WebView2).

```powershell
npm install
npx tauri build
```

The installers are written to `src-tauri/target/release/bundle/` (`nsis/*-setup.exe` and `msi/*.msi`).

- `npx tauri dev` runs the app with live reload.
- `npm run dev` and `npm run build` first copy PDF.js's character maps and standard fonts into `public/pdfjs/` (`scripts/copy-pdfjs-assets.mjs`), so every PDF renders without an internet connection.
- `samples/Sample_Document.pdf` is a small PDF to try things on.
- The [build workflow](.github/workflows/build.yml) builds every push to `main` and every pull request.

## Releasing

1. Set the same new version (for example `1.0.1`) in `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`, and build once so `Cargo.lock` and `package-lock.json` follow.
2. Commit, then push a tag that matches the version with a `v` in front:
   ```powershell
   git tag v1.0.1; git push origin v1.0.1
   ```
3. The [release workflow](.github/workflows/release.yml) checks that the tag matches all three versions, builds both installers on a Windows runner, attests them, and creates a **draft** release. Review it on GitHub and publish it.

## Code

| Part | File |
| --- | --- |
| File dialogs, reading and writing files, folder listing | `src-tauri/src/lib.rs` |
| App state, shortcuts and saving | `src/App.tsx` |
| Page rendering and drawing | `src/components/PDFViewer.tsx` |
| Sidebar, tool dock, citations, text editor | `src/components/` |
| Annotations stored in the PDF | `src/utils/pdfAnnotations.ts` |
| Flattened export and PNG export | `src/utils/pdfExport.ts` |
| Citation formatting (APA, MLA, Chicago, BibTeX) | `src/utils/citations.ts` |
| Design tokens (paper and ink, one vermilion accent) | `src/App.css` |

## License

[MIT](LICENSE)
