// Copies PDF.js's character maps and standard fonts into public/pdfjs/, so the app renders every PDF offline
// instead of loading them from a CDN. Runs before `npm run dev` and `npm run build`.
import { cpSync, rmSync } from "node:fs";

for (const dir of ["cmaps", "standard_fonts"]) {
  rmSync(`public/pdfjs/${dir}`, { recursive: true, force: true });
  cpSync(`node_modules/pdfjs-dist/${dir}`, `public/pdfjs/${dir}`, { recursive: true });
}
