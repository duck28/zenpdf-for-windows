use base64::prelude::*;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::process::Command;
use std::time::UNIX_EPOCH;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: u64,
    pub children: Option<Vec<FileEntry>>,
}

#[tauri::command]
fn pick_folder() -> Result<Option<String>, String> {
    let dialog = rfd::FileDialog::new().set_title("Select Folder / PDF Workspace");
    let folder = dialog.pick_folder();
    Ok(folder.map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command]
fn pick_file() -> Result<Option<String>, String> {
    let dialog = rfd::FileDialog::new()
        .set_title("Open Document")
        .add_filter("Supported (*.pdf, *.txt, *.md)", &["pdf", "txt", "md", "markdown"])
        .add_filter("PDF Documents (*.pdf)", &["pdf"])
        .add_filter("Text & Markdown (*.txt, *.md)", &["txt", "md", "markdown"]);
    let file = dialog.pick_file();
    Ok(file.map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command]
fn pick_save_path(default_name: Option<String>) -> Result<Option<String>, String> {
    // Offer the filter that matches the suggested file's extension.
    let ext = default_name
        .as_deref()
        .and_then(|n| Path::new(n).extension())
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_else(|| "pdf".into());
    let mut dialog = rfd::FileDialog::new().set_title("Save Document");
    dialog = match ext.as_str() {
        "md" | "markdown" => dialog.add_filter("Markdown (*.md)", &["md", "markdown"]),
        "txt" => dialog.add_filter("Text (*.txt)", &["txt"]),
        _ => dialog.add_filter("PDF Documents (*.pdf)", &["pdf"]),
    };
    dialog = dialog.add_filter("All files", &["*"]);
    if let Some(name) = default_name {
        dialog = dialog.set_file_name(&name);
    }
    let file = dialog.save_file();
    Ok(file.map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command]
fn read_pdf_file(path: String) -> Result<String, String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err("File does not exist".into());
    }
    let data = fs::read(p).map_err(|e| format!("Failed to read file: {}", e))?;
    Ok(BASE64_STANDARD.encode(&data))
}

#[tauri::command]
fn write_pdf_file(path: String, base64_data: String) -> Result<(), String> {
    let bytes = BASE64_STANDARD
        .decode(&base64_data)
        .map_err(|e| format!("Failed to decode base64: {}", e))?;
    fs::write(&path, bytes).map_err(|e| format!("Failed to write file: {}", e))?;
    Ok(())
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    let data = fs::read(&path).map_err(|e| format!("Failed to read file: {}", e))?;
    // Tolerate a UTF-8 BOM and stray invalid bytes rather than refusing the file.
    let data = data.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&data);
    Ok(String::from_utf8_lossy(data).into_owned())
}

#[tauri::command]
fn write_text_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content).map_err(|e| format!("Failed to write file: {}", e))
}

#[tauri::command]
fn file_exists(path: String) -> bool {
    Path::new(&path).is_file()
}

const SUPPORTED_EXTENSIONS: [&str; 4] = ["pdf", "txt", "md", "markdown"];

fn scan_dir_recursive(dir: &Path, depth: usize) -> Vec<FileEntry> {
    let mut entries = Vec::new();
    let read_res = fs::read_dir(dir);
    if let Ok(read_dir) = read_res {
        let mut sorted_entries: Vec<_> = read_dir.filter_map(|e| e.ok()).collect();
        sorted_entries.sort_by_key(|e| {
            let is_d = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            (!is_d, e.file_name().to_string_lossy().to_lowercase())
        });

        for entry in sorted_entries {
            let p = entry.path();
            let is_dir = p.is_dir();
            let name = entry.file_name().to_string_lossy().to_string();

            // Skip hidden or system folders/files
            if name.starts_with('.') || name.starts_with('$') || name == "node_modules" || name == "target" {
                continue;
            }

            if is_dir {
                let children = if depth < 6 {
                    let sub = scan_dir_recursive(&p, depth + 1);
                    Some(sub)
                } else {
                    Some(Vec::new())
                };

                entries.push(FileEntry {
                    name,
                    path: p.to_string_lossy().to_string(),
                    is_dir: true,
                    size: 0,
                    modified: entry
                        .metadata()
                        .ok()
                        .and_then(|m| m.modified().ok())
                        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                        .map(|d| d.as_secs())
                        .unwrap_or(0),
                    children,
                });
            } else if p
                .extension()
                .map(|e| SUPPORTED_EXTENSIONS.contains(&e.to_string_lossy().to_lowercase().as_str()))
                .unwrap_or(false)
            {
                let meta = entry.metadata().ok();
                entries.push(FileEntry {
                    name,
                    path: p.to_string_lossy().to_string(),
                    is_dir: false,
                    size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
                    modified: meta
                        .and_then(|m| m.modified().ok())
                        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                        .map(|d| d.as_secs())
                        .unwrap_or(0),
                    children: None,
                });
            }
        }
    }
    entries
}

#[tauri::command]
fn list_directory(path: String) -> Result<Vec<FileEntry>, String> {
    let p = Path::new(&path);
    if !p.is_dir() {
        return Err("Path is not a directory".into());
    }
    Ok(scan_dir_recursive(p, 0))
}

#[tauri::command]
fn reveal_in_explorer(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let p = Path::new(&path);
        // explorer.exe needs the quotes verbatim; `.arg()` would escape them.
        let arg = if p.is_file() {
            format!("/select,\"{}\"", path)
        } else {
            format!("\"{}\"", path)
        };
        Command::new("explorer")
            .raw_arg(arg)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            pick_folder,
            pick_file,
            pick_save_path,
            read_pdf_file,
            write_pdf_file,
            read_text_file,
            write_text_file,
            file_exists,
            list_directory,
            reveal_in_explorer
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
