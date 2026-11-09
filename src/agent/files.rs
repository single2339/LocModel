use super::{arg, err, Reply};
use base64::{engine::general_purpose::STANDARD, Engine};
use calamine::{open_workbook_auto, Reader};
use quick_xml::{events::Event, Reader as Xml};
use serde_json::{json, Value};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

fn ext(p: &Path) -> String {
    p.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}
const LIMIT: u64 = 64 * 1024 * 1024;
fn office(path: &Path, slides: bool) -> Result<String, String> {
    let mut zip = zip::ZipArchive::new(fs::File::open(path).map_err(err)?).map_err(err)?;
    let names = if slides {
        let mut ordered = zip
            .file_names()
            .filter_map(|s| {
                s.strip_prefix("ppt/slides/slide")?
                    .strip_suffix(".xml")?
                    .parse::<u32>()
                    .ok()
                    .map(|n| (n, s.to_owned()))
            })
            .collect::<Vec<_>>();
        ordered.sort();
        ordered.into_iter().map(|(_, s)| s).collect()
    } else {
        vec!["word/document.xml".into()]
    };
    let mut result = String::new();
    let mut size = 0;
    for name in names {
        let entry = zip.by_name(&name).map_err(err)?;
        size += entry.size();
        if size > LIMIT {
            return Err("文档解压后超过 64 MiB".into());
        }
        let mut source = String::new();
        entry
            .take(LIMIT + 1)
            .read_to_string(&mut source)
            .map_err(err)?;
        let mut xml = Xml::from_str(&source);
        let mut text = false;
        loop {
            match xml.read_event().map_err(err)? {
                Event::Start(e) if e.local_name().as_ref() == b"t" => text = true,
                Event::End(e) if e.local_name().as_ref() == b"t" => text = false,
                Event::End(e) if e.local_name().as_ref() == b"p" => result.push('\n'),
                Event::Empty(e) if e.local_name().as_ref() == b"tab" => result.push('\t'),
                Event::Empty(e) if e.local_name().as_ref() == b"br" => result.push('\n'),
                Event::Text(t) if text => result.push_str(&t.decode().map_err(err)?),
                Event::GeneralRef(r) if text => result.push_str(
                    &quick_xml::escape::unescape(&format!("&{};", r.decode().map_err(err)?))
                        .map_err(err)?,
                ),
                Event::Eof => break,
                _ => {}
            }
        }
    }
    Ok(result)
}
pub(super) fn document(path: &Path) -> Result<String, String> {
    if path.metadata().map_err(err)?.len() > LIMIT {
        return Err("文件超过 64 MiB".into());
    }
    match ext(path).as_str() {
        "pdf" => pdf_extract::extract_text(path).map_err(err),
        "pptx" => office(path, true),
        "docx" => office(path, false),
        "xls" | "xlsx" | "xlsb" | "ods" | "xlsm" => {
            let mut workbook = open_workbook_auto(path).map_err(err)?;
            let mut text = String::new();
            for sheet in workbook.sheet_names() {
                text.push_str(&format!("[{sheet}]\n"));
                for row in workbook.worksheet_range(&sheet).map_err(err)?.rows() {
                    text.push_str(
                        &row.iter()
                            .map(ToString::to_string)
                            .collect::<Vec<_>>()
                            .join("\t"),
                    );
                    text.push('\n');
                    if text.len() > LIMIT as usize {
                        return Err("工作簿内容超过 64 MiB".into());
                    }
                }
            }
            Ok(text)
        }
        _ => {
            let data = fs::read(path).map_err(err)?;
            if let Some((s, little)) = data
                .strip_prefix(&[0xff, 0xfe])
                .map(|s| (s, true))
                .or_else(|| data.strip_prefix(&[0xfe, 0xff]).map(|s| (s, false)))
            {
                if s.len() % 2 != 0 {
                    return Err("UTF-16 文件长度无效".into());
                }
                let words = s
                    .chunks_exact(2)
                    .map(|c| {
                        if little {
                            u16::from_le_bytes([c[0], c[1]])
                        } else {
                            u16::from_be_bytes([c[0], c[1]])
                        }
                    })
                    .collect::<Vec<_>>();
                return String::from_utf16(&words).map_err(err);
            }
            if data.contains(&0) {
                return Err("不支持这种二进制文件".into());
            }
            let s = String::from_utf8(data).map_err(err)?;
            Ok(s.strip_prefix('\u{feff}').unwrap_or(&s).to_owned())
        }
    }
}
fn attachment(path: &Path) -> Value {
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let get = || -> Reply {
        let bytes = path.metadata().map_err(err)?.len();
        if bytes > LIMIT {
            return Err("附件超过 64 MiB".into());
        }
        let mime = match ext(path).as_str() {
            "png" => "png",
            "jpg" | "jpeg" => "jpeg",
            "webp" => "webp",
            "gif" => "gif",
            "bmp" => "bmp",
            "avif" => "avif",
            _ => "",
        };
        let (kind, data) = if mime.is_empty() {
            ("text", document(path)?)
        } else {
            (
                "image",
                format!(
                    "data:image/{mime};base64,{}",
                    STANDARD.encode(fs::read(path).map_err(err)?)
                ),
            )
        };
        Ok(json!({"path":path,"name":name,"kind":kind,"data":data,"bytes":bytes}))
    };
    get().unwrap_or_else(|e| json!({"path":path,"name":name,"error":e}))
}
pub(super) fn attachments(cmd: &str, a: &Value) -> Reply {
    let paths: Vec<PathBuf> = if cmd == "pick_attachments" {
        rfd::FileDialog::new().pick_files().unwrap_or_default()
    } else {
        serde_json::from_value(a["paths"].clone()).map_err(err)?
    };
    Ok(Value::Array(paths.iter().map(|p| attachment(p)).collect()))
}
pub(super) fn save(cmd: &str, a: &Value) -> Reply {
    let name = Path::new(arg(a, "fileName")?)
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("文件名无效")?;
    let Some(path) = rfd::FileDialog::new().set_file_name(name).save_file() else {
        return Ok(Value::Null);
    };
    if cmd == "save_text_file" {
        fs::write(&path, arg(a, "content")?).map_err(err)?;
    } else {
        let data = match a["dataUrl"]
            .as_str()
            .and_then(|s| s.strip_prefix("data:image/"))
            .and_then(|s| s.split_once(";base64,"))
        {
            Some((_, data)) => STANDARD.decode(data).map_err(err)?,
            None => fs::read(arg(a, "srcPath")?).map_err(err)?,
        };
        fs::write(&path, data).map_err(err)?;
    }
    Ok(json!(path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn docx_attachment_decodes_text_and_xml_entities() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("中文.docx");
        let mut archive = zip::ZipWriter::new(fs::File::create(&path).unwrap());
        archive
            .start_file(
                "word/document.xml",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
        archive.write_all("<w:document xmlns:w='urn:w'><w:p><w:r><w:t>文件 &amp; 表格</w:t></w:r></w:p></w:document>".as_bytes()).unwrap();
        archive.finish().unwrap();
        let result = attachments(
            "load_attachments",
            &json!({"paths":[path,root.path().join("missing.txt")]}),
        )
        .unwrap();
        assert_eq!(result[0]["data"], "文件 & 表格\n");
        assert_eq!(result[0]["kind"], "text");
        assert!(result[1]["error"].is_string());
    }
}
